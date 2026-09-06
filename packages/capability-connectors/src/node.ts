import { randomUUID } from 'node:crypto';
import { readBoundedResponseText } from '@webpilot/capability-sdk';
import { createConnectorRegistry, createConnectorsCapability, type AgentConnector, type ConnectorOperation } from './index.js';
import type { CapabilityExecutionContext, CapabilityRunContext } from '@webpilot/capability-sdk';

type JsonRpcResponse = { id?: string | number; method?: string; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };

async function rpcResponse(response: Response, id: string, changed: () => void): Promise<JsonRpcResponse> {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const payload = JSON.parse(await readBoundedResponseText(response)) as JsonRpcResponse;
    if (payload.id !== id) throw new Error('MCP response id did not match the request.');
    return payload;
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('MCP response has no body.');
  let buffer = '', bytes = 0;
  const decoder = new TextDecoder();
  function event(text: string) {
    const data = text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    const payload = JSON.parse(data) as JsonRpcResponse;
    if (payload.method === 'notifications/tools/list_changed') changed();
    return payload.id === id ? payload : undefined;
  }
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        buffer += decoder.decode();
        const payload = event(buffer);
        if (payload) return payload;
        throw new Error('MCP stream ended before its matching response.');
      }
      bytes += chunk.value.byteLength;
      if (bytes > 8_000_000) throw new Error('MCP response exceeds 8 MB.');
      buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const payload = event(buffer.slice(0, end)); buffer = buffer.slice(end + 2);
        if (payload) return payload;
      }
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export function createMcpStreamableHttpConnector(input: { id: string; name?: string; url: string; headers?: Readonly<Record<string, string>>; fetchImpl?: typeof fetch; timeoutMs?: number }): AgentConnector {
  const fetchImpl = input.fetchImpl || fetch;
  let sessionId = '', protocolVersion = '2025-06-18';
  let initialization: Promise<void> | undefined;
  let operationRequest: Promise<ConnectorOperation[]> | undefined;
  let cachedOperations: ConnectorOperation[] | undefined;
  let cachedAt = 0;
  const lifetime = new AbortController();
  const request = async (method: string, params: Record<string, unknown>, context: CapabilityExecutionContext, notification = false) => {
    const id = randomUUID();
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(input.timeoutMs || 30_000), ...(context.abortSignal ? [context.abortSignal] : [])]);
    const response = await fetchImpl(input.url, { method: 'POST', signal,
      headers: { ...input.headers, accept: 'application/json, text/event-stream', 'content-type': 'application/json',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}), ...(method === 'initialize' ? {} : { 'mcp-protocol-version': protocolVersion }) },
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 404) { initialization = undefined; sessionId = ''; cachedOperations = undefined; }
      throw Object.assign(new Error(`MCP connector returned HTTP ${response.status}.`), { retryable: response.status === 429 || response.status >= 500 });
    }
    sessionId ||= response.headers.get('mcp-session-id') || '';
    if (notification) { await response.body?.cancel().catch(() => undefined); return; }
    const payload = await rpcResponse(response, id, () => { cachedOperations = undefined; });
    if (payload.error) throw new Error(`MCP ${payload.error.code || 'error'}: ${payload.error.message || 'Unknown error'}`);
    return payload.result;
  };
  const ensureInitialized = (context: CapabilityExecutionContext) => initialization ||= (async () => {
    const result = await request('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'webpilot-connectors', version: '0.1.0' } }, context) as { protocolVersion?: string };
    if (typeof result?.protocolVersion === 'string') protocolVersion = result.protocolVersion;
    await request('notifications/initialized', {}, context, true);
  })().catch((error) => { initialization = undefined; throw error; });
  return {
    id: input.id, name: input.name || input.id, kind: 'mcp',
    async listOperations(context) {
      await ensureInitialized(context);
      if (cachedOperations && Date.now() - cachedAt < 60_000) return cachedOperations;
      if (operationRequest) return operationRequest;
      operationRequest = (async () => {
        const operations: ConnectorOperation[] = [];
        const seen = new Set<string>();
        let cursor: string | undefined;
        do {
          const result = await request('tools/list', cursor ? { cursor } : {}, context) as { nextCursor?: string; tools?: Array<{ name?: string; title?: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean } }> };
          operations.push(...(result?.tools || []).flatMap((tool) => tool.name ? [{ id: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, readOnly: tool.annotations?.readOnlyHint }] : []));
          if (operations.length > 10_000) throw new Error('MCP tool listing exceeded 10,000 tools.');
          cursor = result.nextCursor;
          if (cursor) {
            if (seen.has(cursor) || seen.size >= 100 || operations.length > 10_000) throw new Error('MCP tool pagination exceeded its limit or repeated a cursor.');
            seen.add(cursor);
          }
        } while (cursor);
        cachedOperations = operations; cachedAt = Date.now();
        return operations;
      })().finally(() => { operationRequest = undefined; });
      return operationRequest;
    },
    async call(operationId, args, context) { await ensureInitialized(context); return request('tools/call', { name: operationId, arguments: args }, context); },
    async health() { return lifetime.signal.aborted ? { status: 'unhealthy', message: 'Connector disposed.' } : { status: 'healthy' }; },
    async dispose() {
      lifetime.abort();
      const activeSession = sessionId;
      sessionId = ''; initialization = undefined; cachedOperations = undefined;
      if (activeSession) {
        const response = await fetchImpl(input.url, { method: 'DELETE', signal: AbortSignal.timeout(3000),
          headers: { ...input.headers, 'mcp-session-id': activeSession, 'mcp-protocol-version': protocolVersion } });
        await response.body?.cancel();
        if (!response.ok && response.status !== 404 && response.status !== 405) throw new Error(`MCP session cleanup returned HTTP ${response.status}.`);
      }
    },
  };
}

type OpenApiDocument = { servers?: Array<{ url?: string }>; paths?: Record<string, Record<string, unknown>> };
export function createOpenApiConnector(input: { id: string; name?: string; document: OpenApiDocument; baseUrl?: string; headers?: Readonly<Record<string, string>>; fetchImpl?: typeof fetch; timeoutMs?: number }): AgentConnector {
  const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
  const operations = new Map<string, { method: string; path: string; definition: Record<string, unknown> }>();
  for (const [path, pathItem] of Object.entries(input.document.paths || {})) for (const [method, raw] of Object.entries(pathItem)) {
    if (!methods.has(method.toLowerCase()) || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const definition = raw as Record<string, unknown>;
    const operationId = typeof definition.operationId === 'string' && definition.operationId.trim() ? definition.operationId.trim() : `${method.toLowerCase()}_${path.replace(/[^a-z0-9]+/gi, '_')}`;
    operations.set(operationId, { method: method.toUpperCase(), path, definition });
  }
  const baseUrl = input.baseUrl || input.document.servers?.[0]?.url || '';
  return {
    id: input.id, name: input.name || input.id, kind: 'openapi',
    async listOperations() { return [...operations].map(([id, item]) => ({ id, title: typeof item.definition.summary === 'string' ? item.definition.summary : undefined, description: typeof item.definition.description === 'string' ? item.definition.description : undefined, inputSchema: { type: 'object', additionalProperties: true }, readOnly: item.method === 'GET' || item.method === 'HEAD' })); },
    async call(operationId, args, context) {
      const operation = operations.get(operationId); if (!operation) throw new Error(`Unknown OpenAPI operation: ${operationId}.`); if (!baseUrl) throw new Error('OpenAPI connector has no base URL.');
      const pathArgs = args.path && typeof args.path === 'object' && !Array.isArray(args.path) ? args.path as Record<string, unknown> : {};
      const requestPath = operation.path.replace(/\{([^}]+)\}/g, (_, key: string) => { if (pathArgs[key] === undefined) throw new Error(`Missing path parameter: ${key}.`); return encodeURIComponent(String(pathArgs[key])); });
      const url = new URL(baseUrl);
      url.pathname = url.pathname.replace(/\/$/, '') + '/' + requestPath.replace(/^\/+/, '');
      const query = args.query && typeof args.query === 'object' && !Array.isArray(args.query) ? args.query as Record<string, unknown> : {};
      for (const [key, value] of Object.entries(query)) if (value !== undefined) for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
      const timeout = AbortSignal.timeout(input.timeoutMs || 30_000); const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, timeout]) : timeout;
      const response = await (input.fetchImpl || fetch)(url, { method: operation.method, signal, headers: { accept: 'application/json', ...(args.body === undefined ? {} : { 'content-type': 'application/json' }), ...input.headers }, body: args.body === undefined || operation.method === 'GET' || operation.method === 'HEAD' ? undefined : JSON.stringify(args.body) });
      const text = await readBoundedResponseText(response); let body: unknown = text; try { body = text ? JSON.parse(text) : undefined; } catch { /* preserve text */ }
      if (!response.ok) throw new Error(`OpenAPI operation returned HTTP ${response.status}: ${text.slice(0, 1000)}`);
      return { status: response.status, headers: Object.fromEntries(response.headers), body };
    },
  };
}

export function createNodeConnectorsCapability(input: {
  connectors: readonly AgentConnector[] | ((context: CapabilityRunContext) => readonly AgentConnector[] | Promise<readonly AgentConnector[]>);
}) {
  return createConnectorsCapability({
    async createRegistry(context) {
      const connectors = typeof input.connectors === 'function'
        ? await input.connectors(context)
        : input.connectors;
      return createConnectorRegistry(connectors);
    },
  });
}
