import { z } from 'zod';
import { defineCapabilityInput, defineCapabilityTool, normalizeBoundedInteger, type CapabilityHealth, type CapabilityManifest, type CapabilityProvider, type CapabilityRunContext } from '@webpilot/capability-sdk';
import { knowledgeRuntimeSkill } from './runtime-skill.js';
import { knowledgeCapabilitySettings } from './settings.js';
export * from './runtime-skill.js'; export * from './settings.js';

export const knowledgeCapabilityToolNames = Object.freeze({ knowledge: 'knowledge' } as const);
export type KnowledgeDocument = { id: string; title: string; source?: string; content: string; metadata?: Record<string, unknown>; createdAt: string; updatedAt: string };
export type KnowledgeSearchHit = { documentId: string; title: string; source?: string; chunkIndex: number; text: string; score: number; metadata?: Record<string, unknown> };
export interface KnowledgeStore {
  put(input: Omit<KnowledgeDocument, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<KnowledgeDocument>;
  get(id: string): Promise<KnowledgeDocument | undefined>;
  list(limit: number, offset: number): Promise<KnowledgeDocument[]>;
  search(query: string, limit: number, chunkChars: number): Promise<KnowledgeSearchHit[]>;
  delete(id: string): Promise<boolean>;
  health?(): Promise<CapabilityHealth>;
  dispose?(): Promise<void>;
}

const parser = z.object({
  action: z.enum(['ingest', 'search', 'get', 'list', 'delete']), reason: z.string().trim().min(1).max(300),
  documentId: z.string().trim().min(1).max(200).optional(), title: z.string().trim().min(1).max(500).optional(),
  source: z.string().trim().max(8_000).optional(), content: z.string().min(1).max(1_000_000).optional(), metadata: z.record(z.string(), z.unknown()).optional(),
  query: z.string().trim().min(1).max(4_000).optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1_000_000).optional(),
}).strict().superRefine((input, context) => {
  if (input.action === 'ingest' && (!input.title || !input.content)) context.addIssue({ code: 'custom', message: 'ingest requires title and content.' });
  if ((input.action === 'get' || input.action === 'delete') && !input.documentId) context.addIssue({ code: 'custom', path: ['documentId'], message: `${input.action} requires documentId.` });
  if (input.action === 'search' && !input.query) context.addIssue({ code: 'custom', path: ['query'], message: 'search requires query.' });
});
export type KnowledgeToolInput = z.infer<typeof parser>;
export const knowledgeToolInput = defineCapabilityInput<KnowledgeToolInput>(z.toJSONSchema(parser) as Readonly<Record<string, unknown>>, (value) => parser.parse(value));
export const knowledgeCapabilityManifest = Object.freeze({ schemaVersion: 1, id: 'com.webpilot.knowledge', name: 'Knowledge', version: '0.1.0', description: 'Ingest and retrieve durable reference documents with source provenance.', permissions: ['knowledge:read', 'knowledge:write'], runtimeRequirements: { node: '>=22.16' }, configuration: { settings: knowledgeCapabilitySettings }, skills: [knowledgeRuntimeSkill] } satisfies CapabilityManifest);

export function createKnowledgeTool(store: KnowledgeStore, configuration: CapabilityRunContext['configuration']) {
  return defineCapabilityTool<KnowledgeToolInput, unknown>({
    name: 'knowledge', description: 'Ingest, search, inspect, list, or delete durable knowledge-base documents. This is for reference material, not personal preferences or transient conversation state.', input: knowledgeToolInput,
    policy: { concurrency: 'serial', concurrencyGroup: 'knowledge-store', permissions: knowledgeCapabilityManifest.permissions },
    async execute(input) {
      try {
        if (input.action === 'ingest') { const document = await store.put({ id: input.documentId, title: input.title!, content: input.content!, source: input.source, metadata: input.metadata }); return { ok: true, summary: `Knowledge document ${document.id} indexed.`, data: { ...document, content: undefined, contentChars: document.content.length } }; }
        if (input.action === 'search') { const hits = await store.search(input.query!, input.limit || normalizeBoundedInteger(configuration.AGENT_KNOWLEDGE_SEARCH_LIMIT, 8, 1, 30), normalizeBoundedInteger(configuration.AGENT_KNOWLEDGE_CHUNK_CHARS, 1800, 400, 8000)); return { ok: true, summary: `Found ${hits.length} knowledge chunk(s).`, data: hits }; }
        if (input.action === 'get') { const document = await store.get(input.documentId!); return document ? { ok: true, summary: `Knowledge document ${document.id}.`, data: document } : { ok: false, error: { code: 'knowledge-document-not-found', message: `Unknown knowledge document: ${input.documentId}.` } }; }
        if (input.action === 'list') { const documents = await store.list(input.limit || 50, input.offset || 0); return { ok: true, summary: `${documents.length} knowledge document(s).`, data: documents.map((item) => ({ ...item, content: undefined, contentChars: item.content.length })) }; }
        const deleted = await store.delete(input.documentId!); return deleted ? { ok: true, summary: `Knowledge document ${input.documentId} deleted.`, data: { documentId: input.documentId, deleted: true } } : { ok: false, error: { code: 'knowledge-document-not-found', message: `Unknown knowledge document: ${input.documentId}.` } };
      } catch (error) { return { ok: false, error: { code: 'knowledge-operation-failed', message: error instanceof Error ? error.message : String(error) } }; }
    },
  });
}
export function createKnowledgeCapability(options: { createStore(context: CapabilityRunContext): KnowledgeStore | Promise<KnowledgeStore> }): CapabilityProvider { return { manifest: knowledgeCapabilityManifest, async createRuntime(context) { const store = await options.createStore(context); return { tools: Object.freeze({ knowledge: createKnowledgeTool(store, context.configuration) }), health: () => store.health?.() || Promise.resolve({ status: 'healthy' }), dispose: () => store.dispose?.() || Promise.resolve() }; } }; }
