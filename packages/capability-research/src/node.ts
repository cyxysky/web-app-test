import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { createResearchCapability, ResearchOperationError, type ResearchOperations, type ResearchSource } from './index.js';
import type { CapabilityExecutionContext, CapabilityRunContext } from '@webpilot/capability-sdk';

function sourceId(url: string) { return `source_${createHash('sha256').update(url).digest('hex').slice(0, 16)}`; }
function privateAddress(address: string) {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === '::' || normalized === '::1' || normalized.startsWith('::ffff:')
    || normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')
    || /^127\./.test(normalized) || /^10\./.test(normalized) || /^192\.168\./.test(normalized)
    || /^169\.254\./.test(normalized) || /^172\.(1[6-9]|2\d|3[01])\./.test(normalized) || /^0\./.test(normalized);
}
async function assertPublicUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Research fetch accepts only HTTP(S) URLs.');
  if (url.username || url.password) throw new Error('Credential-bearing URLs are not allowed.');
  if (url.hostname === 'localhost') throw new Error('Local research targets are not allowed.');
  const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => privateAddress(entry.address))) throw new Error('Private or unresolved research targets are not allowed.');
  return url;
}
function decodeEntities(value: string) { return value.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'"); }
function htmlText(value: string) {
  const clean = value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  // Keep financial row/cell boundaries instead of a single unlabelled stream
  // of numbers. Spans are explicit; do not infer flattened header associations.
  const rows = clean.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_, row: string) => {
    const cells = [...row.matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi)].map((cell) => {
      const spans = [...cell[2].matchAll(/\b(colspan|rowspan)\s*=\s*["']?(\d+)/gi)]
        .filter((match) => Number(match[2]) > 1)
        .map((match) => `${match[1].toLowerCase()}=${match[2]}`);
      const text = cell[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return `${spans.length ? `[${spans.join(',')}] ` : ''}${text}`;
    });
    return cells.length ? `\n${cells.join(' | ')}\n` : row;
  });
  return decodeEntities(rows.replace(/<br\b[^>]*>|<\/(?:p|div|h[1-6]|li|table|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[^\S\r\n]+/g, ' ').replace(/ *\r?\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function titleFromHtml(value: string, fallback: string) { const matched = value.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i); return matched ? htmlText(matched[1]).slice(0, 300) : fallback; }
async function boundedResponseText(response: Response, maximum: number) {
  if (!response.body) { const text = await response.text(); return { text: text.slice(0, maximum), truncated: text.length > maximum }; }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = '';
  let truncated = false;
  while (output.length < maximum) {
    const chunk = await reader.read();
    if (chunk.done) {
      output += decoder.decode();
      break;
    }
    output += decoder.decode(chunk.value, { stream: true });
    if (output.length >= maximum) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return { text: output.slice(0, maximum), truncated };
}

export function createNodeResearchOperations(input: {
  search?: ResearchOperations['search'];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  allowUrl?: (url: URL) => boolean | Promise<boolean>;
} = {}): ResearchOperations {
  const fetchImpl = input.fetchImpl || fetch;
  return {
    search: input.search,
    async fetch(request, context: CapabilityExecutionContext): Promise<ResearchSource> {
      let url = await assertPublicUrl(request.url);
      const timeout = AbortSignal.timeout(input.timeoutMs || 20_000);
      const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, timeout]) : timeout;
      let response: Response | undefined;
      for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
        if (input.allowUrl && !(await input.allowUrl(url))) throw new Error('The host network policy rejected this URL.');
        response = await fetchImpl(url, { redirect: 'manual', signal, headers: { accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.2', 'user-agent': 'WebPilotResearch/0.1' } });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get('location');
        if (!location) throw new Error(`Research redirect ${response.status} did not include a location.`);
        if (redirectCount === 5) throw new Error('Research fetch exceeded the redirect limit.');
        url = await assertPublicUrl(new URL(location, url).href);
      }
      if (!response) throw new Error('Research fetch did not return a response.');
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new ResearchOperationError('research-http-failed', `Research fetch returned HTTP ${response.status}. ${response.status === 401 || response.status === 403 ? 'This source denied access; use another authoritative source, not repeated identical requests.' : ''}`, response.status === 429 || response.status >= 500);
      }
      const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
      const binaryError = () => new ResearchOperationError('research-binary-document', `This URL returns a binary document (${mediaType}), not extracted text. No source evidence was read. Use file action=download with this URL, then file action=readContent with the returned artifactId. Do not retry research.fetch for this document. URL: ${url.href}`);
      if (!(mediaType.startsWith('text/') || /^(application\/(json|[^;]+\+json|xml|[^;]+\+xml|javascript))$/i.test(mediaType))) {
        await response.body?.cancel().catch(() => undefined);
        throw binaryError();
      }
      // Markup can be much larger than the extracted article (especially SEC/
      // financial tables). Bound raw input separately from model-visible text.
      const rawLimit = mediaType.includes('html')
        ? Math.min(4_000_000, Math.max(1_000_000, request.maxChars * 8))
        : Math.max(request.maxChars * 4, request.maxChars);
      const received = await boundedResponseText(response, rawLimit);
      const raw = received.text;
      // A mislabeled PDF/ZIP must not become tens of thousands of tokens of fake evidence.
      if (/^\s*%PDF-|^PK\u0003\u0004/.test(raw) || raw.includes('\u0000')) throw binaryError();
      const content = mediaType.includes('html') ? htmlText(raw) : raw;
      if (mediaType.includes('html') && content.length < 2_000 && /^(?:This site requires JavaScript to verify your browser|Just a moment\b|Checking your browser\b|Access Denied\b|Please (?:enable JavaScript|verify (?:that )?you are human))/i.test(content)) {
        throw new ResearchOperationError('research-access-challenge', `The server returned an access/verification page, not the requested source. No data was verified. Use another accessible authoritative source or the browser's normal verification flow; do not treat this page as evidence or retry the same fetch. URL: ${url.href}`);
      }
      const truncated = received.truncated || content.length > request.maxChars;
      return { sourceId: sourceId(url.href), url: url.href, title: mediaType.includes('html') ? titleFromHtml(raw, url.hostname) : url.pathname.split('/').pop() || url.hostname, content: content.slice(0, request.maxChars), mediaType, retrievedAt: new Date().toISOString(), provider: 'http', truncated, returnedCharacters: Math.min(content.length, request.maxChars), ...(truncated ? { instruction: 'This is only a prefix, not the complete source. For structured data use a narrower date/range request or download the full file before computing. Do not infer omitted records or change the required interval to fit this preview.' } : {}) };
    },
  };
}

export function createNodeResearchCapability(input: Parameters<typeof createNodeResearchOperations>[0] = {}) {
  return createResearchCapability({ createOperations(context: CapabilityRunContext) { return createNodeResearchOperations({ ...input, timeoutMs: Number(context.configuration.AGENT_RESEARCH_TIMEOUT_MS) || input.timeoutMs }); } });
}
