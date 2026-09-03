import { z } from 'zod';
import { defineCapabilityInput, defineCapabilityTool, normalizeBoundedInteger, type CapabilityExecutionContext, type CapabilityHealth, type CapabilityManifest, type CapabilityProvider, type CapabilityRunContext } from '@webpilot/capability-sdk';
import { connectorsRuntimeSkill } from './runtime-skill.js';
import { connectorsCapabilitySettings } from './settings.js';
export * from './runtime-skill.js';
export * from './settings.js';

export const connectorsCapabilityToolNames = Object.freeze({ connectors: 'connectors' } as const);
export type ConnectorOperation = { id: string; title?: string; description?: string; inputSchema?: Readonly<Record<string, unknown>>; readOnly?: boolean };
export interface AgentConnector {
  id: string;
  name: string;
  kind: 'mcp' | 'openapi' | 'custom';
  listOperations(context: CapabilityExecutionContext): Promise<ConnectorOperation[]>;
  call(operationId: string, args: Record<string, unknown>, context: CapabilityExecutionContext): Promise<unknown>;
  health?(): Promise<CapabilityHealth>;
  dispose?(): Promise<void>;
}
export interface ConnectorRegistry {
  list(): readonly AgentConnector[];
  get(id: string): AgentConnector | undefined;
}
export function createConnectorRegistry(connectors: readonly AgentConnector[]): ConnectorRegistry {
  const byId = new Map<string, AgentConnector>();
  for (const connector of connectors) { if (!connector.id.trim()) throw new Error('Connector id is required.'); if (byId.has(connector.id)) throw new Error(`Duplicate connector id: ${connector.id}.`); byId.set(connector.id, connector); }
  return Object.freeze({ list: () => Object.freeze([...byId.values()]), get: (id: string) => byId.get(id) });
}

const parser = z.object({
  action: z.enum(['list', 'describe', 'call']),
  reason: z.string().trim().min(1).max(300),
  connectorId: z.string().trim().min(1).max(200).optional(),
  operationId: z.string().trim().min(1).max(300).optional(),
  arguments: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((input, context) => {
  if ((input.action === 'describe' || input.action === 'call') && !input.connectorId) context.addIssue({ code: 'custom', path: ['connectorId'], message: `${input.action} requires connectorId.` });
  if (input.action === 'call' && !input.operationId) context.addIssue({ code: 'custom', path: ['operationId'], message: 'call requires operationId.' });
});
export type ConnectorsToolInput = z.infer<typeof parser>;
export const connectorsToolInput = defineCapabilityInput<ConnectorsToolInput>(z.toJSONSchema(parser) as Readonly<Record<string, unknown>>, (value) => parser.parse(value));
export const connectorsCapabilityManifest = Object.freeze({
  schemaVersion: 1, id: 'com.webpilot.connectors', name: 'Connectors', version: '0.1.0',
  description: 'Discover and invoke host-configured MCP, OpenAPI, and custom external operations.',
  permissions: ['network:external', 'secrets:reference'], runtimeRequirements: { node: '>=22.16' },
  configuration: { settings: connectorsCapabilitySettings }, skills: [connectorsRuntimeSkill],
} satisfies CapabilityManifest);

function boundedResult(value: unknown, maximum: number) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized.length <= maximum) return value;
  return { truncated: true, originalChars: serialized.length, preview: serialized.slice(0, maximum) };
}
export function createConnectorsTool(registry: ConnectorRegistry, configuration: CapabilityRunContext['configuration']) {
  return defineCapabilityTool<ConnectorsToolInput, unknown>({
    name: connectorsCapabilityToolNames.connectors,
    description: 'List configured external connections, describe their exact operations, or invoke one discovered MCP/OpenAPI/custom operation. Credentials are injected by the host.',
    input: connectorsToolInput,
    policy: { concurrency: 'parallel', concurrencyGroup: 'external-connectors', permissions: connectorsCapabilityManifest.permissions },
    async execute(input, context) {
      try {
        if (input.action === 'list') return { ok: true, summary: 'Configured external connectors.', data: registry.list().map(({ id, kind, name }) => ({ id, kind, name })) };
        const connector = registry.get(input.connectorId!);
        if (!connector) return { ok: false, error: { code: 'connector-not-found', message: `Unknown connector: ${input.connectorId}.` } };
        const operations = await connector.listOperations(context);
        if (input.action === 'describe') return { ok: true, summary: `${connector.name} operations.`, data: operations };
        const operation = operations.find((candidate) => candidate.id === input.operationId);
        if (!operation) return { ok: false, error: { code: 'connector-operation-not-found', message: `Unknown operation ${input.operationId} on connector ${connector.id}.` } };
        const value = await connector.call(operation.id, input.arguments || {}, context);
        return { ok: true, summary: `Connector operation ${connector.id}/${operation.id} completed.`, data: boundedResult(value, normalizeBoundedInteger(configuration.AGENT_CONNECTOR_MAX_RESULT_CHARS, 50_000, 1_000, 500_000)) };
      } catch (error) { return { ok: false, error: { code: 'connector-call-failed', message: error instanceof Error ? error.message : String(error), retryable: true } }; }
    },
  });
}
export function createConnectorsCapability(options: { createRegistry(context: CapabilityRunContext): ConnectorRegistry | Promise<ConnectorRegistry> }): CapabilityProvider {
  return { manifest: connectorsCapabilityManifest, async createRuntime(context) { const registry = await options.createRegistry(context); return { tools: Object.freeze({ connectors: createConnectorsTool(registry, context.configuration) }), health: async () => { const statuses = await Promise.all(registry.list().map((item) => item.health?.() || Promise.resolve({ status: 'healthy' as const }))); return statuses.some((item) => item.status === 'unhealthy') ? { status: 'degraded', message: 'One or more connectors are unhealthy.' } : { status: 'healthy' }; }, dispose: async () => { await Promise.allSettled(registry.list().map((item) => item.dispose?.())); } }; } };
}
