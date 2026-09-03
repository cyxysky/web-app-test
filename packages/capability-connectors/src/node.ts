import { randomUUID } from 'node:crypto';
import { createConnectorRegistry, createConnectorsCapability, type AgentConnector, type ConnectorOperation } from './index.js';
import type { CapabilityExecutionContext, CapabilityRunContext } from '@webpilot/capability-sdk';

type JsonRpcResponse = { id?: string | number; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
function responseJson(text: string): JsonRpcResponse {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed) as JsonRpcResponse;
  const data = trimmed.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean).at(-1);
  if (!data) throw new Error('Connector returned neither JSON nor SSE data.');
  return JSON.parse(data) as JsonRpcResponse;
}

export function createMcpStreamableHttpConnector(input: { id: string; name?: string; url: string; headers?: Readonly<Record<string, string>>; fetchImpl?: typeof fetch; timeoutMs?: number }): AgentConnector {
  const fetchImpl = input.fetchImpl || fetch;
  let sessionId = '';
  let initialized = false;
  let cachedOperations: ConnectorOperation[] | undefined;
  const request = async (method: string, params: Record<string, unknown>, context: CapabilityExecutionContext, notification = false) => {
    const controller = AbortSignal.timeout(input.timeoutMs || 30_000);
    const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, controller]) : controller;
    const response = await fetchImpl(input.url, { method: 'POST', signal, headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(sessionId ? { 'mcp-session-id': sessionId } : {}), ...input.headers }, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: randomUUID() }), method, params }) });
    if (!response.ok) throw new Error(`MCP connector returned HTTP ${response.status}.`);
    sessionId ||= response.headers.get('mcp-session-id') || '';
    if (notification) return undefined;
    const payload = responseJson(await response.text());
    if (payload.error) throw new Error(`MCP ${payload.error.code || 'error'}: ${payload.error.message || 'Unknown error'}`);
    return payload.result;
  };
  const ensureInitialized = async (context: CapabilityExecutionContext) => {
    if (initialized) return;
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'webpilot-connectors', version: '0.1.0' } }, context);
    await request('notifications/initialized', {}, context, true);
    initialized = true;
  };
  return {
    id: input.id, name: input.name || input.id, kind: 'mcp',
    async listOperations(context) {
      await ensureInitialized(context);
      if (cachedOperations) return cachedOperations;
      const result = await request('tools/list', {}, context) as { tools?: Array<{ name?: string; title?: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean } }> };
      cachedOperations = (result?.tools || []).flatMap((tool) => tool.name ? [{ id: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, readOnly: tool.annotations?.readOnlyHint }] : []);
      return cachedOperations;
    },
    async call(operationId, args, context) { await ensureInitialized(context); return request('tools/call', { name: operationId, arguments: args }, context); },
    async health() { return { status: 'healthy' }; },
    async dispose() {
      if (!sessionId) return;
      await fetchImpl(input.url, { method: 'DELETE', headers: { 'mcp-session-id': sessionId, ...input.headers } }).catch(() => undefined);
      sessionId = ''; initialized = false; cachedOperations = undefined;
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
      const url = new URL(requestPath, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
      const query = args.query && typeof args.query === 'object' && !Array.isArray(args.query) ? args.query as Record<string, unknown> : {};
      for (const [key, value] of Object.entries(query)) if (value !== undefined) for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
      const timeout = AbortSignal.timeout(input.timeoutMs || 30_000); const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, timeout]) : timeout;
      const response = await (input.fetchImpl || fetch)(url, { method: operation.method, signal, headers: { accept: 'application/json', ...(args.body === undefined ? {} : { 'content-type': 'application/json' }), ...input.headers }, body: args.body === undefined || operation.method === 'GET' || operation.method === 'HEAD' ? undefined : JSON.stringify(args.body) });
      const text = await response.text(); let body: unknown = text; try { body = text ? JSON.parse(text) : undefined; } catch { /* preserve text */ }
      if (!response.ok) throw new Error(`OpenAPI operation returned HTTP ${response.status}: ${text.slice(0, 1000)}`);
      return { status: response.status, headers: Object.fromEntries(response.headers), body };
    },
  };
}

export function createNodeConnectorsCapability(input: { connectors: readonly AgentConnector[] | ((context: CapabilityRunContext) => readonly AgentConnector[]) }) {
  return createConnectorsCapability({ createRegistry(context) { return createConnectorRegistry(typeof input.connectors === 'function' ? input.connectors(context) : input.connectors); } });
}
