import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import {
  filterDurablePersonalMemoryDrafts,
  getPersonalMemoryItem,
  markPersonalMemoryItemsUsed,
  normalizePersonalMemoryDomain,
  normalizePersonalMemoryUserId,
  savePersonalMemoryItem,
  searchPersonalMemory,
  updatePersonalMemoryItem,
  type PersonalMemoryDraft,
  type PersonalMemoryItem,
} from '@/server/ai/personal-memory';

export const personalMemoryToolNames = [
  'searchMemory',
  'saveMemory',
  'updateMemory',
  'disableMemory',
] as const;

export type PersonalMemoryToolName = (typeof personalMemoryToolNames)[number];

export type PersonalMemoryToolContext = {
  userId?: unknown;
  currentUrl?: string;
  getCurrentUrl?: () => string;
  sourceSessionId?: string;
  sourceMessageIds?: string[];
  userMessages?: string[];
  readOnly?: boolean;
  usedMemoryIds?: Set<string>;
};

const memoryScopeSchema = z.enum(['global', 'domain']);
const memoryTypeSchema = z.enum(['alias', 'preference', 'workflow', 'domain_fact']);
const durabilitySchema = z.enum([
  'explicit_preference',
  'explicit_workflow',
  'explicit_alias',
  'explicit_remember',
  'repeated_user_behavior',
]);
const evidenceSchema = z.array(z.string().min(1).max(500)).min(1).max(8);

const memoryDraftShape = {
  scope: memoryScopeSchema,
  domain: z.string().max(253).optional(),
  type: memoryTypeSchema,
  key: z.string().min(1).max(120),
  aliases: z.array(z.string().min(1).max(120)).max(8).optional(),
  value: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1).optional(),
};

function toolMemoryItem(item: PersonalMemoryItem) {
  return {
    id: item.id,
    scope: item.scope,
    domain: item.domain,
    type: item.type,
    key: item.key,
    aliases: item.aliases,
    value: item.value,
    confidence: item.confidence,
    status: item.status,
    updatedAt: item.updatedAt,
  };
}

function exactUserEvidence(context: PersonalMemoryToolContext, evidence: string[]) {
  const userMessages = (context.userMessages || []).map((message) => message.replace(/\s+/g, ' ').trim());
  return evidence.every((quote) => {
    const normalized = quote.replace(/\s+/g, ' ').trim();
    return normalized.length >= 2 && userMessages.some((message) => message.includes(normalized));
  });
}

function assertWritable(context: PersonalMemoryToolContext) {
  if (context.readOnly) throw new Error('Personal memory tools are read-only in this agent.');
}

function durableDraft(input: PersonalMemoryDraft & {
  evidence: string[];
  durability: z.infer<typeof durabilitySchema>;
}, context: PersonalMemoryToolContext) {
  if (!exactUserEvidence(context, input.evidence)) {
    throw new Error('Memory write rejected: evidence must be an exact quote from a user message in this turn.');
  }
  const [accepted] = filterDurablePersonalMemoryDrafts([input], context.userMessages || []);
  if (!accepted) {
    throw new Error('Memory write rejected: the user did not provide a durable preference, workflow, alias, remember request, or repeated behavior.');
  }
  return accepted;
}

function explicitMemoryManagementRequest(context: PersonalMemoryToolContext, evidence: string[]) {
  if (!exactUserEvidence(context, evidence)) return false;
  return evidence.some((quote) => /(?:忘记|删除|移除|停用|不要记|别记|更新记忆|修改记忆|改成|forget|delete|remove|disable|do not remember|update (?:the )?memory|change (?:the )?memory)/i.test(quote));
}

export function createPersonalMemoryTools(context: PersonalMemoryToolContext): ToolSet {
  const userId = normalizePersonalMemoryUserId(context.userId);
  const usedMemoryIds = context.usedMemoryIds || new Set<string>();
  const currentUrl = () => context.getCurrentUrl?.() || context.currentUrl || '';
  const currentDomain = () => normalizePersonalMemoryDomain(currentUrl());
  const markUsedOnce = (ids: string[]) => {
    const unusedIds = Array.from(new Set(ids.filter((id) => id && !usedMemoryIds.has(id))));
    if (!unusedIds.length) return;
    markPersonalMemoryItemsUsed(unusedIds);
    unusedIds.forEach((id) => usedMemoryIds.add(id));
  };

  return {
    searchMemory: tool({
      description: 'Search the current user\'s durable SQLite personal memory. Use this only when injected short memory is insufficient or the user explicitly asks what is remembered. Results are scoped to the current user and current domain.',
      inputSchema: z.object({
        query: z.string().min(1).max(1_000),
        limit: z.number().int().min(1).max(20).optional(),
      }),
      execute: async ({ query, limit }) => {
        const results = searchPersonalMemory({
          userId,
          query,
          domain: currentDomain(),
          limit,
        });
        markUsedOnce(results.map((result) => result.item.id));
        return {
          items: results.map((result) => ({
            ...toolMemoryItem(result.item),
            score: result.score,
            reasons: result.reasons,
          })),
        };
      },
    }),
    saveMemory: tool({
      description: 'Create or upsert one durable personal memory only when the user explicitly states a lasting preference/workflow/alias, asks to remember it, or independently repeats the same behavior. Evidence must quote the user exactly; never store assistant discoveries, page content, secrets, or one-off task data.',
      inputSchema: z.object({
        ...memoryDraftShape,
        evidence: evidenceSchema,
        durability: durabilitySchema,
      }),
      execute: async (input) => {
        assertWritable(context);
        const draft = durableDraft(input, context);
        const domain = draft.scope === 'domain' ? draft.domain || currentDomain() : '';
        if (draft.scope === 'domain' && !domain) {
          throw new Error('Domain-scoped memory requires a current URL or an explicit domain.');
        }
        const item = savePersonalMemoryItem({
          ...draft,
          userId,
          domain,
          sourceSessionId: context.sourceSessionId,
          sourceMessageIds: context.sourceMessageIds,
          sourceUrl: currentUrl(),
        });
        return { item: toolMemoryItem(item) };
      },
    }),
    updateMemory: tool({
      description: 'Update one existing personal memory when the current user explicitly asks to change that remembered fact. Supply exact user evidence for the change. The memory ID must come from searchMemory or injected runtime context.',
      inputSchema: z.object({
        id: z.string().min(1).max(160),
        scope: memoryScopeSchema.optional(),
        domain: z.string().max(253).optional(),
        type: memoryTypeSchema.optional(),
        key: z.string().min(1).max(120).optional(),
        aliases: z.array(z.string().min(1).max(120)).max(8).optional(),
        value: z.string().min(1).max(500).optional(),
        confidence: z.number().min(0).max(1).optional(),
        evidence: evidenceSchema,
      }).refine((input) => (
        input.scope !== undefined
        || input.domain !== undefined
        || input.type !== undefined
        || input.key !== undefined
        || input.aliases !== undefined
        || input.value !== undefined
        || input.confidence !== undefined
      ), { message: 'Provide at least one memory field to update.' }),
      execute: async ({ id, evidence, ...patch }) => {
        assertWritable(context);
        if (!explicitMemoryManagementRequest(context, evidence)) {
          throw new Error('Memory update rejected: the current user must explicitly request the memory change.');
        }
        const existing = getPersonalMemoryItem(id, userId);
        if (!existing || (existing.userId !== userId && existing.shared)) {
          throw new Error('Personal memory was not found or is not editable by the current user.');
        }
        const item = updatePersonalMemoryItem(id, patch, userId);
        if (!item) throw new Error('Personal memory was not found.');
        return { item: toolMemoryItem(item) };
      },
    }),
    disableMemory: tool({
      description: 'Disable one existing personal memory when the current user explicitly asks to forget, remove, or stop using it. Supply exact user evidence. This is recoverable and does not physically delete the SQLite record.',
      inputSchema: z.object({
        id: z.string().min(1).max(160),
        evidence: evidenceSchema,
      }),
      execute: async ({ id, evidence }) => {
        assertWritable(context);
        if (!explicitMemoryManagementRequest(context, evidence)) {
          throw new Error('Memory disable rejected: the current user must explicitly ask to forget or disable it.');
        }
        const existing = getPersonalMemoryItem(id, userId);
        if (!existing || (existing.userId !== userId && existing.shared)) {
          throw new Error('Personal memory was not found or is not editable by the current user.');
        }
        const item = updatePersonalMemoryItem(id, { status: 'disabled' }, userId);
        if (!item) throw new Error('Personal memory was not found.');
        return { item: toolMemoryItem(item) };
      },
    }),
  };
}
