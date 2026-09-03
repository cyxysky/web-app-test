import { z } from 'zod';
import { defineCapabilityInput, defineCapabilityTool, normalizeBoundedInteger, type CapabilityExecutionContext, type CapabilityHealth, type CapabilityManifest, type CapabilityProvider, type CapabilityRunContext } from '@webpilot/capability-sdk';
import { researchRuntimeSkill } from './runtime-skill.js';
import { researchCapabilitySettings } from './settings.js';
export * from './runtime-skill.js';
export * from './settings.js';

export const researchCapabilityToolNames = Object.freeze({ research: 'research' } as const);
export type ResearchSource = { sourceId: string; url: string; title: string; snippet?: string; content?: string; provider?: string; retrievedAt: string; mediaType?: string };
export interface ResearchOperations {
  search?(input: { query: string; limit: number; domains?: string[]; recencyDays?: number }, context: CapabilityExecutionContext): Promise<ResearchSource[]>;
  fetch(input: { url: string; maxChars: number }, context: CapabilityExecutionContext): Promise<ResearchSource>;
  health?(): Promise<CapabilityHealth>;
  dispose?(): Promise<void>;
}

const parser = z.object({
  action: z.enum(['search', 'fetch']),
  reason: z.string().trim().min(1).max(300),
  query: z.string().trim().min(1).max(1_000).optional(),
  url: z.string().url().max(8_000).optional(),
  limit: z.number().int().min(1).max(20).optional(),
  domains: z.array(z.string().trim().min(1).max(253)).max(20).optional(),
  recencyDays: z.number().int().min(1).max(3650).optional(),
}).strict().superRefine((input, context) => {
  if (input.action === 'search' && !input.query) context.addIssue({ code: 'custom', path: ['query'], message: 'search requires query.' });
  if (input.action === 'fetch' && !input.url) context.addIssue({ code: 'custom', path: ['url'], message: 'fetch requires url.' });
});
export type ResearchToolInput = z.infer<typeof parser>;
export const researchToolInput = defineCapabilityInput<ResearchToolInput>(z.toJSONSchema(parser) as Readonly<Record<string, unknown>>, (value) => parser.parse(value));
export const researchCapabilityManifest = Object.freeze({
  schemaVersion: 1, id: 'com.webpilot.research', name: 'Research', version: '0.1.0',
  description: 'Search and fetch public information with stable provenance records.',
  permissions: ['network:public-read'], runtimeRequirements: { node: '>=22.16' },
  configuration: { settings: researchCapabilitySettings }, skills: [researchRuntimeSkill],
} satisfies CapabilityManifest);

export function createResearchTool(operations: ResearchOperations, configuration: CapabilityRunContext['configuration']) {
  return defineCapabilityTool<ResearchToolInput, ResearchSource | ResearchSource[]>({
    name: researchCapabilityToolNames.research,
    description: 'Search public sources or fetch and extract one exact public HTTP(S) document. Every result carries provenance metadata for citation.',
    input: researchToolInput,
    policy: { concurrency: 'parallel', concurrencyGroup: 'research-network', permissions: researchCapabilityManifest.permissions },
    async execute(input, context) {
      try {
        if (input.action === 'search') {
          if (!operations.search) return { ok: false, error: { code: 'research-search-unavailable', message: 'No search provider is configured.' } };
          const sources = await operations.search({ query: input.query!, limit: input.limit || 8, domains: input.domains, recencyDays: input.recencyDays }, context);
          return { ok: true, summary: `Found ${sources.length} research source(s).`, data: sources };
        }
        const source = await operations.fetch({ url: input.url!, maxChars: normalizeBoundedInteger(configuration.AGENT_RESEARCH_MAX_CONTENT_CHARS, 30_000, 1_000, 200_000) }, context);
        return { ok: true, summary: `Fetched research source: ${source.title || source.url}.`, data: source };
      } catch (error) {
        return { ok: false, error: { code: 'research-operation-failed', message: error instanceof Error ? error.message : String(error), retryable: true } };
      }
    },
  });
}

export function createResearchCapability(options: { createOperations(context: CapabilityRunContext): ResearchOperations | Promise<ResearchOperations> }): CapabilityProvider {
  return { manifest: researchCapabilityManifest, async createRuntime(context) { const operations = await options.createOperations(context); return { tools: Object.freeze({ research: createResearchTool(operations, context.configuration) }), health: () => operations.health?.() || Promise.resolve({ status: 'healthy' }), dispose: () => operations.dispose?.() || Promise.resolve() }; } };
}
