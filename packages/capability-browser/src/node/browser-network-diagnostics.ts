import type { Page, Request, Response } from 'playwright';
import type { BrowserActionResult, BrowserDependencyFailure } from './browser-session.js';
import { compactDiagnosticText, shouldIgnoreNetworkFailure } from './browser-session-diagnostics.js';

type HttpRequestRecord = {
  id: string;
  sequence: number;
  startedAt: string;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  statusText?: string;
  ok?: boolean;
  failed?: boolean;
  errorText?: string;
};

/** Owns request listeners and all retained network state for one browser session. */
export class BrowserNetworkDiagnostics {
  private networkErrors: string[] = [];
  private httpRequestsByPage = new WeakMap<Page, HttpRequestRecord[]>();
  private httpRequestByRequest = new WeakMap<Request, HttpRequestRecord>();
  private httpRequestById = new Map<string, Request>();
  private httpRequestSequence = 0;
  private pendingBrowserCodeDependencyFailures = new Map<Request, BrowserDependencyFailure>();
  private deliveredBrowserCodeDependencyRequests = new WeakSet<Request>();
  private listeners = new Map<Page, () => void>();

  constructor(private configuredValue: (name: string) => string | undefined,
    private recordDomChangeError: (page: Page, source: 'network', message: string) => void) {}
  get sequence() { return this.httpRequestSequence; }
  records(page: Page): readonly HttpRequestRecord[] { return this.httpRequestsByPage.get(page) || []; }
  errors() { return [...this.networkErrors]; }
  private forgetRequest(id: string) {
    const request = this.httpRequestById.get(id);
    if (request) this.pendingBrowserCodeDependencyFailures.delete(request);
    this.httpRequestById.delete(id);
  }
  attach(page: Page) {
    if (this.listeners.has(page)) return;
    const onRequest = (request: Request) => {
      this.recordHttpRequest(page, request);
    };
    const onResponse = (response: Response) => {
      const request = response.request();
      const record = this.httpRequestByRequest.get(request) || this.recordHttpRequest(page, request);
      record.status = response.status();
      record.statusText = response.statusText();
      record.ok = response.ok();
      if (record.status === 408 || record.status === 429 || record.status >= 500) {
        this.queueBrowserCodeDependencyFailure(request, record);
      }
    };
    const onRequestFailed = (request: Request) => {
      const record = this.httpRequestByRequest.get(request) || this.recordHttpRequest(page, request);
      const errorText = request.failure()?.errorText || '';
      record.failed = true;
      record.ok = false;
      record.errorText = errorText;
      if (shouldIgnoreNetworkFailure(request.url(), errorText)) return;
      const message = `${request.method()} ${request.url()} ${errorText}`;
      this.networkErrors.push(message);
      if (this.networkErrors.length > 200) this.networkErrors.splice(0, this.networkErrors.length - 200);
      this.recordDomChangeError(page, 'network', message);
      this.queueBrowserCodeDependencyFailure(request, record);
    };

    const close = () => this.detach(page);
    page.on('request', onRequest); page.on('response', onResponse); page.on('requestfailed', onRequestFailed); page.on('close', close);
    this.listeners.set(page, () => {
      page.off('request', onRequest); page.off('response', onResponse); page.off('requestfailed', onRequestFailed); page.off('close', close);
    });
  }
  detach(page: Page) {
    this.listeners.get(page)?.(); this.listeners.delete(page);
    for (const record of this.records(page)) this.forgetRequest(record.id);
    this.httpRequestsByPage.delete(page);
  }
  dispose() {
    for (const page of this.listeners.keys()) this.detach(page);
    this.httpRequestById.clear(); this.pendingBrowserCodeDependencyFailures.clear(); this.networkErrors = [];
  }
  private recordHttpRequest(page: Page, request: Request) {
    const existing = this.httpRequestByRequest.get(request);
    if (existing) return existing;
    const records = this.httpRequestsByPage.get(page) || [];
    const record: HttpRequestRecord = {
      id: `${Date.now().toString(36)}-${this.httpRequestSequence + 1}`,
      sequence: ++this.httpRequestSequence,
      startedAt: new Date().toISOString(),
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
    };
    records.push(record);
    const rawMaxRecords = Number(this.configuredValue('BROWSER_HTTP_REQUEST_HISTORY_LIMIT') || 400);
    const maxRecords = Math.min(10_000, Math.max(50, Math.floor(Number.isFinite(rawMaxRecords) ? rawMaxRecords : 400)));
    if (records.length > maxRecords) {
      const removed = records.splice(0, records.length - maxRecords);
      for (const item of removed) this.forgetRequest(item.id);
    }
    this.httpRequestsByPage.set(page, records);
    this.httpRequestByRequest.set(request, record);
    this.httpRequestById.set(record.id, request);
    return record;
  }

  private dependencyFailureFromHttpRecord(record: HttpRequestRecord): BrowserDependencyFailure {
    let url = record.url;
    let path = record.url;
    try {
      const parsed = new URL(record.url);
      url = `${parsed.pathname}${parsed.search}`;
      path = parsed.pathname;
    } catch {
      path = record.url.split('?')[0] || record.url;
    }
    return {
      category: record.failed ? 'network_error' : 'external_service',
      key: `${record.method.toUpperCase()}:${path}`,
      method: record.method.toUpperCase(),
      ...(record.status !== undefined ? { status: record.status } : {}),
      ...(record.errorText ? { errorText: record.errorText } : {}),
      url,
    };
  }

  private queueBrowserCodeDependencyFailure(request: Request, record: HttpRequestRecord) {
    if (
      !this.httpRequestById.has(record.id)
      || this.deliveredBrowserCodeDependencyRequests.has(request)
      || this.pendingBrowserCodeDependencyFailures.has(request)
    ) return;
    this.pendingBrowserCodeDependencyFailures.set(request, this.dependencyFailureFromHttpRecord(record));
  }

  drainDependencyFailures() {
    const failures = [...this.pendingBrowserCodeDependencyFailures.entries()];
    this.pendingBrowserCodeDependencyFailures.clear();
    for (const [request] of failures) this.deliveredBrowserCodeDependencyRequests.add(request);
    return failures.map(([, failure]) => failure);
  }

  async read(page: Page, options: { ids?: string[] } = {}): Promise<BrowserActionResult> {
    const rawLimit = Number(this.configuredValue('AI_HTTP_REQUEST_TOOL_LIMIT') || 80);
    const limit = Math.max(1, Math.floor(Number.isFinite(rawLimit) ? rawLimit : 80));
    const requestedIds = new Set((options.ids || []).filter((id) => typeof id === 'string' && id));
    const detailed = requestedIds.size > 0;
    const records = detailed
      ? (this.httpRequestsByPage.get(page) || []).filter((record) => requestedIds.has(record.id))
      : (this.httpRequestsByPage.get(page) || []).slice(-limit);
    if (!records.length) {
      return { ok: true, actual: detailed ? 'None of the requested HTTP request IDs are available in the current tab history.' : 'Current tab has no captured HTTP requests yet.' };
    }
    const detailLimit = Math.max(1000, Math.floor(Number(this.configuredValue('AI_HTTP_REQUEST_DETAIL_MAX_CHARS') || 12000)));
    const output = await Promise.all(records.map(async (record) => {
      const summary = {
        id: record.id,
        time: record.startedAt,
        method: record.method,
        url: record.url,
        resourceType: record.resourceType,
        status: record.status ?? null,
        statusText: record.statusText ?? null,
        ok: record.ok ?? null,
        failed: record.failed || false,
        errorText: record.errorText || null,
      } as Record<string, unknown>;
      if (!detailed) return summary;
      const request = this.httpRequestById.get(record.id);
      if (!request) return { ...summary, detailUnavailable: true };
      const requestBody = request.postData();
      if (requestBody) summary.requestBody = compactDiagnosticText(requestBody, detailLimit);
      if (record.status !== undefined) {
        const response = await request.response().catch(() => null);
        const contentType = response?.headers()['content-type'] || '';
        if (response && /(?:json|text|xml|javascript|graphql|urlencoded)/i.test(contentType)) {
          const responseBody = await response.text().catch(() => '');
          if (responseBody) summary.responseBody = compactDiagnosticText(responseBody, detailLimit);
        }
      }
      return summary;
    }));
    return {
      ok: true,
      actual: JSON.stringify(output, null, 2),
      data: output,
      summary: `Read ${output.length} HTTP request record${output.length === 1 ? '' : 's'} from the active tab.`,
    };
  }
}
