import { randomUUID } from 'node:crypto';
import { generateText } from 'ai';
import { z } from 'zod';
import { fuzzyRetrievalScore } from '@/lib/fuzzy-retrieval';
import { normalizeApplicationUserId } from '@/server/auth/user-context';
import { aiTelemetry } from '@/server/ai/ai-sdk-runtime';
import { getModel, getModelSettings } from '@/server/ai/model';
import type { StepExecutionResult } from '@/server/ai/schemas/runtime.schema';
import {
  deletePersonalMemoryRecord,
  markPersonalMemoryRecordsUsed,
  readPersonalMemoryRecordByIdentity,
  readPersonalMemoryRecords,
  writePersonalMemoryRecord,
  writePersonalMemoryRecords,
  writePersonalMemoryRecordsQueued,
} from '@/server/storage/database-record-store';

export type PersonalMemoryScope = 'global' | 'domain';
export type PersonalMemoryType = 'alias' | 'preference' | 'workflow' | 'domain_fact';
export type PersonalMemoryStatus = 'active' | 'disabled';

export type PersonalMemoryItem = {
  id: string;
  userId: string;
  shared: boolean;
  scope: PersonalMemoryScope;
  domain: string;
  type: PersonalMemoryType;
  key: string;
  aliases: string[];
  value: string;
  text: string;
  confidence: number;
  sourceSessionId?: string;
  sourceMessageIds?: string[];
  sourceUrl?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  useCount: number;
  status: PersonalMemoryStatus;
};

export type PersonalMemoryDraft = {
  shared?: unknown;
  scope?: unknown;
  domain?: unknown;
  type?: unknown;
  key?: unknown;
  aliases?: unknown;
  value?: unknown;
  confidence?: unknown;
  sourceUrl?: unknown;
  status?: unknown;
};

type PersonalMemoryStoreFile = {
  version: 1;
  items: PersonalMemoryItem[];
};

export type PersonalMemorySearchResult = {
  item: PersonalMemoryItem;
  score: number;
  reasons: string[];
};

export type PersonalMemoryExtractionResult = {
  items: PersonalMemoryItem[];
  rawText: string;
  skipped: boolean;
  reason?: string;
  diagnostics: PersonalMemoryExtractionDiagnostics;
};

export type PersonalMemoryFilterRejectionReason =
  | 'missing_evidence'
  | 'unsupported_durability'
  | 'repeated_behavior_requires_two_quotes'
  | 'repeated_behavior_requires_two_user_messages'
  | 'evidence_not_found_in_user_messages'
  | 'missing_explicit_durability_cue'
  | 'domain_fact_requires_explicit_remember_or_alias';

export type PersonalMemoryFilterRejection = {
  index: number;
  key: string;
  type: string;
  durability: string;
  reason: PersonalMemoryFilterRejectionReason;
  reasonDescription: string;
};

export type PersonalMemoryExtractionDiagnostics = {
  candidateCount: number;
  acceptedCount: number;
  rejectedCount: number;
  savedCount: number;
  normalizationRejectedCount: number;
  rejectionReasons: Partial<Record<PersonalMemoryFilterRejectionReason, number>>;
  rejectedCandidates: PersonalMemoryFilterRejection[];
};

type PersonalMemoryConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type PersonalMemoryDurabilitySignal =
  | 'explicit_preference'
  | 'explicit_workflow'
  | 'explicit_alias'
  | 'explicit_remember'
  | 'repeated_user_behavior';

type PersonalMemoryExtractionDraft = PersonalMemoryDraft & {
  evidence?: unknown;
  durability?: unknown;
};

const memoryTypes: PersonalMemoryType[] = ['alias', 'preference', 'workflow', 'domain_fact'];
const memoryScopes: PersonalMemoryScope[] = ['global', 'domain'];
const memoryStatuses: PersonalMemoryStatus[] = ['active', 'disabled'];
const personalMemoryExtractionSchema = z.object({
  items: z.array(z.object({
    scope: z.enum(['global', 'domain']),
    domain: z.string().max(253).optional(),
    type: z.enum(['alias', 'preference', 'workflow', 'domain_fact']),
    key: z.string().min(1).max(120),
    aliases: z.array(z.string().min(1).max(120)).max(8).optional(),
    value: z.string().min(1).max(500),
    confidence: z.number().min(0).max(1).optional(),
    evidence: z.array(z.string().min(1).max(500)).min(1).max(8),
    durability: z.enum([
      'explicit_preference',
      'explicit_workflow',
      'explicit_alias',
      'explicit_remember',
      'repeated_user_behavior',
    ]),
  })).max(8),
});

export function parsePersonalMemoryExtractionOutput(value: unknown) {
  const text = textFromUnknown(value).trim();
  if (!text) return personalMemoryExtractionSchema.parse({ items: [] });
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const source = (fenced?.[1] || text).trim();
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Personal memory extraction returned no JSON object.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.slice(start, end + 1));
  } catch (error) {
    throw new Error('Personal memory extraction returned invalid JSON.', { cause: error });
  }
  const validated = personalMemoryExtractionSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`Personal memory extraction returned an invalid object: ${validated.error.message}`);
  }
  return validated.data;
}

function now() {
  return new Date().toISOString();
}

function textFromUnknown(value: unknown) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function compactText(value: unknown, max = 180) {
  const text = textFromUnknown(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function normalizePersonalMemoryValue(value: unknown) {
  return textFromUnknown(value).replace(/\r\n?/g, '\n').trim();
}

export function normalizePersonalMemoryUserId(value: unknown) {
  return normalizeApplicationUserId(value);
}

export function personalMemoryEnabled() {
  return process.env.AI_PERSONAL_MEMORY_ENABLED !== 'false';
}

function personalMemoryExtractionEnabled() {
  return personalMemoryEnabled() && process.env.AI_PERSONAL_MEMORY_EXTRACT_ENABLED !== 'false';
}

function personalMemoryPromptLimit() {
  const raw = Number(process.env.AI_PERSONAL_MEMORY_PROMPT_LIMIT || 6);
  return Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 0), 20) : 6;
}

function personalMemoryPromptMaxChars() {
  const raw = Number(process.env.AI_PERSONAL_MEMORY_PROMPT_MAX_CHARS || 12000);
  return Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 1000), 120000) : 12000;
}

function personalMemoryExtractionInputLimit() {
  const raw = Number(process.env.AI_PERSONAL_MEMORY_EXTRACTION_INPUT_MAX_CHARS || 18000);
  return Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 3000), 60000) : 18000;
}

export function normalizePersonalMemoryDomain(value: unknown) {
  const raw = textFromUnknown(value).trim();
  if (!raw) return '';
  try {
    const url = raw.includes('://') ? new URL(raw) : new URL(`https://${raw}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return raw
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .split('/')[0]
      .replace(/^www\./, '')
      .trim();
  }
}

function domainMatches(memoryDomain: string, currentDomain: string) {
  if (!memoryDomain) return false;
  if (memoryDomain === currentDomain) return true;
  return Boolean(currentDomain && currentDomain.endsWith(`.${memoryDomain}`));
}

function normalizeScope(value: unknown, domain: string): PersonalMemoryScope {
  const scope = textFromUnknown(value).trim();
  if (memoryScopes.includes(scope as PersonalMemoryScope)) return scope as PersonalMemoryScope;
  return domain ? 'domain' : 'global';
}

function normalizeType(value: unknown): PersonalMemoryType {
  const type = textFromUnknown(value).trim();
  if (memoryTypes.includes(type as PersonalMemoryType)) return type as PersonalMemoryType;
  return 'domain_fact';
}

function normalizeStatus(value: unknown): PersonalMemoryStatus {
  const status = textFromUnknown(value).trim();
  if (memoryStatuses.includes(status as PersonalMemoryStatus)) return status as PersonalMemoryStatus;
  return 'active';
}

function normalizeConfidence(value: unknown) {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) return 0.75;
  return Math.min(Math.max(confidence, 0), 1);
}

function normalizeKey(value: unknown) {
  return compactText(value, 120);
}

function normalizeAliases(value: unknown, key = '') {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const item of source) {
    const alias = compactText(item, 80);
    const normalized = alias.toLowerCase();
    if (!alias || normalized === key.toLowerCase() || seen.has(normalized)) continue;
    seen.add(normalized);
    aliases.push(alias);
  }
  return aliases.slice(0, 8);
}

function itemText(input: Pick<PersonalMemoryItem, 'key' | 'value' | 'aliases' | 'domain' | 'scope' | 'type'>) {
  const aliases = input.aliases.length ? ` aliases: ${input.aliases.join(', ')}` : '';
  const domain = input.scope === 'domain' && input.domain ? ` domain: ${input.domain}` : '';
  return compactText(`${input.type} ${input.key}: ${input.value}${aliases}${domain}`, 360);
}

function normalizeMemoryDraft(input: PersonalMemoryDraft, defaults: {
  userId: string;
  domain?: string;
  sourceSessionId?: string;
  sourceMessageIds?: string[];
  sourceUrl?: string;
}): Omit<PersonalMemoryItem, 'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt' | 'useCount'> | undefined {
  const rawDomain = normalizePersonalMemoryDomain(input.domain || defaults.domain || '');
  const scope = normalizeScope(input.scope, rawDomain);
  const domain = scope === 'domain' ? rawDomain : '';
  const key = normalizeKey(input.key);
  const value = normalizePersonalMemoryValue(input.value);
  if (!key || !value) return undefined;
  const type = normalizeType(input.type);
  const aliases = normalizeAliases(input.aliases, key);
  return {
    userId: defaults.userId,
    shared: input.shared === true,
    scope,
    domain,
    type,
    key,
    aliases,
    value,
    text: itemText({ key, value, aliases, domain, scope, type }),
    confidence: normalizeConfidence(input.confidence),
    sourceSessionId: defaults.sourceSessionId,
    sourceMessageIds: defaults.sourceMessageIds,
    sourceUrl: compactText(input.sourceUrl || defaults.sourceUrl || '', 2000) || undefined,
    status: normalizeStatus(input.status),
  };
}

function normalizeStoreItem(value: unknown): PersonalMemoryItem | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Partial<PersonalMemoryItem>;
  const userId = normalizePersonalMemoryUserId(record.userId);
  const draft = normalizeMemoryDraft(record, {
    userId,
    domain: record.domain,
    sourceSessionId: record.sourceSessionId,
    sourceMessageIds: record.sourceMessageIds,
    sourceUrl: record.sourceUrl,
  });
  if (!draft) return undefined;
  const timestamp = now();
  const id = compactText(record.id, 120) || `mem_${randomUUID()}`;
  return {
    ...draft,
    id,
    createdAt: textFromUnknown(record.createdAt).trim() || timestamp,
    updatedAt: textFromUnknown(record.updatedAt).trim() || timestamp,
    lastUsedAt: textFromUnknown(record.lastUsedAt).trim() || undefined,
    useCount: Math.max(0, Math.floor(Number(record.useCount) || 0)),
  };
}

async function readStore(input: {
  domain?: string;
  includeDisabled?: boolean;
  includeShared?: boolean;
  limit?: number;
  userId?: string;
} = {}): Promise<PersonalMemoryStoreFile> {
  const items = (await readPersonalMemoryRecords<PersonalMemoryItem>(input))
    .map(normalizeStoreItem)
    .filter((item): item is PersonalMemoryItem => Boolean(item));
  return { version: 1, items };
}

function memoryIdentity(item: Pick<PersonalMemoryItem, 'userId' | 'scope' | 'domain' | 'type' | 'key'>) {
  return [
    item.userId,
    item.scope,
    item.domain,
    item.type,
    item.key.toLowerCase(),
  ].join('\u0001');
}

export async function listPersonalMemoryItems(input: {
  userId?: unknown;
  domain?: unknown;
  includeDisabled?: boolean;
  limit?: number;
} = {}) {
  const userId = normalizePersonalMemoryUserId(input.userId);
  const domain = normalizePersonalMemoryDomain(input.domain);
  const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(500, Math.floor(Number(input.limit)))) : undefined;
  const items = (await readStore({
    domain,
    userId,
    includeShared: true,
    includeDisabled: input.includeDisabled === true,
    limit,
  })).items.filter((item) => {
    if (item.userId !== userId && !item.shared) return false;
    if (!input.includeDisabled && item.status !== 'active') return false;
    if (!domain) return true;
    return item.scope === 'global' || domainMatches(item.domain, domain);
  });
  return limit ? items.slice(0, limit) : items;
}

export async function getPersonalMemoryItem(id: string, userId?: unknown) {
  const normalizedUserId = normalizePersonalMemoryUserId(userId);
  return (await readPersonalMemoryRecords<PersonalMemoryItem>({
    ids: [id],
    userId: normalizedUserId,
    includeShared: true,
  })).map(normalizeStoreItem).find((item): item is PersonalMemoryItem => Boolean(item));
}

export async function savePersonalMemoryItem(input: PersonalMemoryDraft & {
  id?: unknown;
  userId?: unknown;
  sourceSessionId?: string;
  sourceMessageIds?: string[];
}) {
  const userId = normalizePersonalMemoryUserId(input.userId);
  const draft = normalizeMemoryDraft(input, {
    userId,
    domain: textFromUnknown(input.domain),
    sourceSessionId: input.sourceSessionId,
    sourceMessageIds: input.sourceMessageIds,
    sourceUrl: textFromUnknown(input.sourceUrl),
  });
  if (!draft) throw new Error('Personal memory item requires key and value.');
  const timestamp = now();
  const requestedId = compactText(input.id, 120);
  const requestedItem = requestedId
    ? (await readPersonalMemoryRecords<PersonalMemoryItem>({ ids: [requestedId] }))
      .map(normalizeStoreItem)
      .find((item): item is PersonalMemoryItem => Boolean(item))
    : undefined;
  if (requestedItem && requestedItem.userId !== userId) {
    throw new Error('Only the memory creator can edit this shared memory.');
  }
  const identityItem = await readPersonalMemoryRecordByIdentity<PersonalMemoryItem>({
    userId,
    scope: draft.scope,
    domain: draft.domain,
    type: draft.type,
    key: draft.key,
  });
  const previous = requestedItem || (identityItem ? normalizeStoreItem(identityItem) : undefined);
  const item: PersonalMemoryItem = {
    ...draft,
    shared: input.shared === undefined ? previous?.shared ?? false : draft.shared,
    id: previous?.id || requestedId || `mem_${randomUUID()}`,
    createdAt: previous?.createdAt || timestamp,
    updatedAt: timestamp,
    lastUsedAt: previous?.lastUsedAt,
    useCount: previous?.useCount || 0,
    status: draft.status,
  };
  await writePersonalMemoryRecord(item);
  return item;
}

export async function savePersonalMemoryItems(
  inputs: Array<PersonalMemoryDraft & { id?: unknown }>,
  userIdValue?: unknown,
  options: { queued?: boolean } = {},
) {
  const userId = normalizePersonalMemoryUserId(userIdValue);
  const store = await readStore({ userId, includeShared: true });
  const byIdentity = new Map(store.items.map((item) => [memoryIdentity(item), item]));
  const timestamp = now();
  const saved: PersonalMemoryItem[] = [];
  let created = 0;
  let updated = 0;
  for (const input of inputs) {
    const draft = normalizeMemoryDraft(input, {
      userId,
      domain: textFromUnknown(input.domain),
      sourceUrl: textFromUnknown(input.sourceUrl),
    });
    if (!draft) continue;
    const previous = byIdentity.get(memoryIdentity(draft));
    if (previous && previous.userId !== userId) continue;
    const item: PersonalMemoryItem = {
      ...draft,
      shared: input.shared === undefined ? previous?.shared ?? false : draft.shared,
      id: previous?.id || compactText(input.id, 120) || `mem_${randomUUID()}`,
      createdAt: previous?.createdAt || timestamp,
      updatedAt: timestamp,
      lastUsedAt: previous?.lastUsedAt,
      useCount: previous?.useCount || 0,
      status: draft.status,
    };
    if (previous) updated += 1;
    else created += 1;
    byIdentity.set(memoryIdentity(item), item);
    saved.push(item);
  }
  const result = { created, items: saved, updated };
  if (saved.length && options.queued) return writePersonalMemoryRecordsQueued(saved).then(() => result);
  if (saved.length) await writePersonalMemoryRecords(saved);
  return result;
}

export async function updatePersonalMemoryItem(id: string, patch: PersonalMemoryDraft, userId?: unknown) {
  const normalizedUserId = normalizePersonalMemoryUserId(userId);
  const previous = (await readPersonalMemoryRecords<PersonalMemoryItem>({
    ids: [id],
    userId: normalizedUserId,
    includeShared: false,
  })).map(normalizeStoreItem).find((item): item is PersonalMemoryItem => Boolean(item));
  if (!previous) return undefined;
  const draft = normalizeMemoryDraft({
    ...previous,
    ...patch,
    aliases: patch.aliases ?? previous.aliases,
    domain: patch.domain ?? previous.domain,
    scope: patch.scope ?? previous.scope,
    type: patch.type ?? previous.type,
  }, {
    userId: previous.userId,
    domain: previous.domain,
    sourceSessionId: previous.sourceSessionId,
    sourceMessageIds: previous.sourceMessageIds,
    sourceUrl: previous.sourceUrl,
  });
  if (!draft) throw new Error('Personal memory item requires key and value.');
  const patchKeys = Object.keys(patch);
  const statusOnlyUpdate = patchKeys.length === 1 && patchKeys[0] === 'status';
  const item: PersonalMemoryItem = {
    ...previous,
    ...draft,
    id: previous.id,
    createdAt: previous.createdAt,
    updatedAt: statusOnlyUpdate ? previous.updatedAt : now(),
    lastUsedAt: previous.lastUsedAt,
    useCount: previous.useCount,
    status: normalizeStatus(patch.status ?? previous.status),
  };
  await writePersonalMemoryRecord(item);
  return item;
}

export async function deletePersonalMemoryItem(id: string, userId?: unknown) {
  const normalizedUserId = normalizePersonalMemoryUserId(userId);
  const deleted = (await readPersonalMemoryRecords<PersonalMemoryItem>({
    ids: [id],
    userId: normalizedUserId,
    includeShared: false,
  })).map(normalizeStoreItem).find((item): item is PersonalMemoryItem => Boolean(item));
  return deleted && await deletePersonalMemoryRecord(id, normalizedUserId) ? deleted : undefined;
}

export async function searchPersonalMemory(input: {
  userId?: unknown;
  query?: unknown;
  domain?: unknown;
  limit?: number;
}): Promise<PersonalMemorySearchResult[]> {
  if (!personalMemoryEnabled()) return [];
  const userId = normalizePersonalMemoryUserId(input.userId);
  const domain = normalizePersonalMemoryDomain(input.domain);
  const limit = typeof input.limit === 'number' ? input.limit : personalMemoryPromptLimit();
  if (limit <= 0) return [];
  const results: PersonalMemorySearchResult[] = [];
  for (const item of (await readStore({ domain, userId, includeShared: true, includeDisabled: false, limit: 2_000 })).items) {
    if ((item.userId !== userId && !item.shared) || item.status !== 'active') continue;
    const reasons: string[] = [];
    let score = 0;
    if (item.scope === 'domain') {
      if (!domainMatches(item.domain, domain)) continue;
      score += item.domain === domain ? 8 : 6;
      reasons.push('domain');
    } else {
      score += item.type === 'preference' || item.type === 'workflow' ? 2 : 1;
      reasons.push('global');
    }
    const keyRelevance = fuzzyRetrievalScore(input.query, [item.key]);
    const aliasRelevance = fuzzyRetrievalScore(input.query, item.aliases);
    const valueRelevance = fuzzyRetrievalScore(input.query, [item.value, item.text]);
    if (keyRelevance >= 0.38) {
      score += keyRelevance * 10;
      reasons.push('semantic-key');
    } else if (aliasRelevance >= 0.38) {
      score += aliasRelevance * 8;
      reasons.push('semantic-alias');
    } else if (valueRelevance >= 0.38) {
      score += valueRelevance * 7;
      reasons.push('semantic-value');
    }
    if (item.domain && fuzzyRetrievalScore(input.query, [item.domain]) >= 0.8) {
      score += 3;
      reasons.push('domain-mentioned');
    }
    if (item.scope === 'global' && !reasons.some((reason) => reason.startsWith('semantic-')) && !['preference', 'workflow'].includes(item.type)) {
      continue;
    }
    score += item.confidence;
    score += Math.min(item.useCount, 12) * 0.05;
    results.push({ item, score, reasons: Array.from(new Set(reasons)) });
  }
  return results
    .sort((a, b) => (
      b.score - a.score
      || b.item.updatedAt.localeCompare(a.item.updatedAt)
      || b.item.confidence - a.item.confidence
    ))
    .slice(0, limit);
}

export function markPersonalMemoryItemsUsed(ids: string[]) {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  if (!uniqueIds.length) return [];
  return markPersonalMemoryRecordsUsed<PersonalMemoryItem>(uniqueIds, now());
}

export function formatPersonalMemoryForPrompt(results: PersonalMemorySearchResult[] | PersonalMemoryItem[]) {
  const items = results.map((entry) => 'item' in entry ? entry.item : entry).filter((item) => item.status === 'active');
  if (!items.length) return '';
  const header = [
    'Personal short memory:',
    'Use these concise user/domain facts when relevant. If the latest user message contradicts a memory, follow the latest user message.',
  ].join('\n');
  const maxChars = personalMemoryPromptMaxChars();
  const blocks: string[] = [];
  let usedChars = header.length;
  for (const item of items) {
    const attributes = [
      `id="${item.id}"`,
      `scope="${item.scope}"`,
      `type="${item.type}"`,
      item.scope === 'domain' && item.domain ? `domain="${item.domain}"` : '',
    ].filter(Boolean).join(' ');
    const aliases = item.aliases.length ? `\nAliases: ${item.aliases.join(', ')}` : '';
    const opening = `<memory ${attributes}>\nKey: ${item.key}${aliases}\nValue:\n`;
    const closing = '\n</memory>';
    const separatorChars = 2;
    const available = maxChars - usedChars - separatorChars - opening.length - closing.length;
    if (available <= 0) break;
    const rawValue = normalizePersonalMemoryValue(item.value);
    const truncated = rawValue.length > available;
    const fullSuffix = '\n[Personal memory truncated only for this prompt; the stored memory remains complete.]';
    const suffix = truncated ? fullSuffix.slice(0, available) : '';
    const valueLimit = Math.max(0, available - suffix.length);
    const value = rawValue.slice(0, valueLimit).trimEnd();
    const block = `${opening}${value}${suffix}${closing}`;
    blocks.push(block);
    usedChars += separatorChars + block.length;
    if (truncated) break;
  }
  return [header, ...blocks].join('\n\n');
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}

function summarizeStep(step: StepExecutionResult) {
  return {
    index: step.index,
    action: compactText(step.action, 220),
    actual: compactText(step.actual, 260),
    status: step.status,
    tools: (step.tools || []).slice(-4).map((tool) => ({
      name: tool.name,
      reason: compactText(tool.reason, 160),
      result: compactText(tool.result, 180),
      ok: tool.ok,
      recovered: tool.recovered,
      transient: tool.transient,
    })),
  };
}

const personalMemoryDurabilitySignals = new Set<PersonalMemoryDurabilitySignal>([
  'explicit_preference',
  'explicit_workflow',
  'explicit_alias',
  'explicit_remember',
  'repeated_user_behavior',
]);

const personalMemoryFilterRejectionDescriptions: Record<PersonalMemoryFilterRejectionReason, string> = {
  missing_evidence: '缺少用户原文证据。',
  unsupported_durability: '模型返回了不支持的长期性类型。',
  repeated_behavior_requires_two_quotes: '重复行为至少需要两条用户原文证据。',
  repeated_behavior_requires_two_user_messages: '重复行为证据必须来自两条不同的用户消息。',
  evidence_not_found_in_user_messages: '模型给出的证据未在用户消息中找到。',
  missing_explicit_durability_cue: '用户原文缺少“记住、以后、默认”等长期性表达。',
  domain_fact_requires_explicit_remember_or_alias: '域名事实必须由用户明确要求记住或定义为可复用别名。',
};

function normalizedEvidenceText(value: unknown) {
  return textFromUnknown(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizedEvidenceTexts(value: unknown) {
  const values = Array.isArray(value) ? value : [value];
  return Array.from(new Set(values.map(normalizedEvidenceText).filter((evidence) => evidence.length >= 2)));
}

function hasExplicitDurabilityCue(text: string, signal: PersonalMemoryDurabilitySignal) {
  const durableCue = /(?:记住|记下来|以后|下次|今后|从现在|总是|一直|每次|默认|习惯|偏好|我喜欢|我不喜欢|不要|别再|必须|务必|都要|remember|from now on|in the future|always|never|every time|by default|i prefer|my preference)/i;
  const aliasCue = /(?:我说.{1,40}(?:指|就是|表示|意思是)|(?:叫|称为).{1,40}(?:指|就是|表示|意思是)|when i say.{1,80}(?:mean|refer)|.{1,60}\bmeans\b.{1,80})/i;
  if (signal === 'explicit_alias') return aliasCue.test(text) || durableCue.test(text);
  return durableCue.test(text);
}

export function filterDurablePersonalMemoryDrafts(
  items: PersonalMemoryExtractionDraft[],
  userMessages: string[],
): PersonalMemoryDraft[] {
  return analyzeDurablePersonalMemoryDrafts(items, userMessages).items;
}

export function analyzeDurablePersonalMemoryDrafts(
  items: PersonalMemoryExtractionDraft[],
  userMessages: string[],
) {
  const normalizedUserMessages = userMessages.map(normalizedEvidenceText).filter(Boolean);
  const accepted: PersonalMemoryDraft[] = [];
  const rejected: PersonalMemoryFilterRejection[] = [];
  items.forEach((item, index) => {
    const evidence = normalizedEvidenceTexts(item.evidence);
    const signal = textFromUnknown(item.durability).trim() as PersonalMemoryDurabilitySignal;
    const reject = (reason: PersonalMemoryFilterRejectionReason) => {
      rejected.push({
        index,
        key: compactText(item.key, 120),
        type: textFromUnknown(item.type),
        durability: signal,
        reason,
        reasonDescription: personalMemoryFilterRejectionDescriptions[reason],
      });
    };
    if (!evidence.length) {
      reject('missing_evidence');
      return;
    }
    if (!personalMemoryDurabilitySignals.has(signal)) {
      reject('unsupported_durability');
      return;
    }
    const sourceMessageIndexes = new Set(evidence.map((quote) => (
      normalizedUserMessages.findIndex((message) => message.includes(quote))
    )).filter((index) => index >= 0));
    if (signal === 'repeated_user_behavior') {
      if (evidence.length < 2) {
        reject('repeated_behavior_requires_two_quotes');
        return;
      }
      if (sourceMessageIndexes.size < 2) {
        reject('repeated_behavior_requires_two_user_messages');
        return;
      }
    } else {
      if (!sourceMessageIndexes.size) {
        reject('evidence_not_found_in_user_messages');
        return;
      }
      const hasDurableUserEvidence = Array.from(sourceMessageIndexes).some((index) => (
        hasExplicitDurabilityCue(normalizedUserMessages[index], signal)
      ));
      if (!hasDurableUserEvidence) {
        reject('missing_explicit_durability_cue');
        return;
      }
    }
    const type = normalizeType(item.type);
    if (type === 'domain_fact' && signal !== 'explicit_remember' && signal !== 'explicit_alias') {
      reject('domain_fact_requires_explicit_remember_or_alias');
      return;
    }
    accepted.push(item);
  });
  return { items: accepted, rejected };
}

function compactConversationForMemory(messages: PersonalMemoryConversationMessage[]) {
  return messages.map((message) => ({ role: message.role, content: compactText(message.content, 1400) }));
}

function buildExtractionPrompt(input: {
  userId: string;
  currentDomain: string;
  currentUrl: string;
  targetUrl: string;
  userMessage: string;
  assistantReply: string;
  conversation: PersonalMemoryConversationMessage[];
  steps: StepExecutionResult[];
  existingItems: PersonalMemoryItem[];
}) {
  const conversation = compactConversationForMemory(input.conversation);
  const source = {
    currentDomain: input.currentDomain,
    currentUrl: input.currentUrl,
    targetUrl: input.targetUrl,
    primaryUserEvidence: {
      latestUserMessage: input.userMessage,
      userMessages: conversation.filter((message) => message.role === 'user').map((message) => message.content),
    },
    supplementaryAssistantContext: {
      assistantMessages: conversation.filter((message) => message.role === 'assistant').map((message) => message.content),
      latestAssistantReply: input.assistantReply,
      browserSteps: input.steps.map(summarizeStep),
    },
    existingMemory: input.existingItems.map((item) => ({
      id: item.id,
      scope: item.scope,
      domain: item.domain,
      type: item.type,
      key: item.key,
      aliases: item.aliases,
      value: item.value,
      status: item.status,
    })),
  };
  return [
    'You extract durable personal short memory for a browser assistant.',
    'Return raw JSON only. Do not use Markdown fences or add explanatory text.',
    'The exact top-level shape is {"items":[]}. Each item must use only the fields defined below.',
    '',
    'Allowed item fields:',
    '- scope: "global" or "domain"',
    '- domain: hostname for domain-scoped facts, empty for global',
    '- type: "alias", "preference", "workflow", or "domain_fact"',
    '- key: short phrase the user may say later',
    '- aliases: short alternative phrases',
    '- value: one concise fact, at most 160 Chinese characters or 220 English characters',
    '- confidence: number from 0 to 1',
    '- evidence: an array of exact, short quotes copied only from user messages',
    '- durability: "explicit_preference", "explicit_workflow", "explicit_alias", "explicit_remember", or "repeated_user_behavior"',
    '',
    'User-authored messages are the primary and only authoritative evidence of personal memory. Assistant messages and browser steps are supplementary context only: they may clarify the target or outcome, but they can never establish a user habit by themselves.',
    'Use all user messages, not only the latest one. The default is {"items":[]}. Write an item when the user explicitly states a lasting preference/workflow, explicitly defines a reusable phrase, explicitly asks you to remember something, or independently demonstrates the same reusable behavior in at least two different user messages.',
    'For an explicit durability signal, evidence must contain at least one exact user quote. For repeated_user_behavior, evidence must contain at least two exact quotes from two different user messages. Never use assistant text as evidence.',
    'Assistant discoveries, public page content, successful one-off instructions, and descriptions of which control the user meant only in the current task are not personal memory.',
    'Domain facts require an explicit remember request or an explicit reusable alias definition from the user. Never memorize documentation examples, page order, current UI layout, search results, or facts merely observed by the assistant.',
    'Examples that MUST return no items: "点击第一个选择器", "打开带 icon 的滑块", "查一下 YYF 的直播间", or a completed workflow the user did not say should be reused.',
    'Examples that may produce one item: "以后我说第一个选择器，是指基本示例里的那个"; "记住 YYF 的直播间是 9999"; "以后不要截图，默认用 DOM".',
    'Return up to 8 independent items from one completed conversation. Do not merge separate preferences, aliases, or workflows into one broad memory.',
    'Before returning an item, compare against every existing global item and every existing item for currentDomain. If the fact already exists, return no duplicate. If it should be updated, return the same scope/domain/type/key shape so the store updates it.',
    'Do not store secrets, passwords, tokens, OTPs, private credentials, temporary IDs, one-off task data, raw page content, or long summaries.',
    'Do not invent facts. If nothing durable is learned, return {"items":[]}.',
    'Prefer concise user wording for key and aliases. Keep values short and operational.',
    '',
    `Input JSON:\n${compactText(safeJson(source), personalMemoryExtractionInputLimit())}`,
  ].join('\n');
}

export async function upsertExtractedPersonalMemoryItems(input: {
  userId?: unknown;
  domain?: unknown;
  sourceSessionId?: string;
  sourceMessageIds?: string[];
  sourceUrl?: string;
  items: PersonalMemoryDraft[];
}) {
  const userId = normalizePersonalMemoryUserId(input.userId);
  const store = await readStore({ userId, includeShared: true });
  const byIdentity = new Map(store.items.map((item, index) => [memoryIdentity(item), index]));
  const timestamp = now();
  const saved: PersonalMemoryItem[] = [];
  for (const rawItem of input.items.slice(0, 8)) {
    const draft = normalizeMemoryDraft(rawItem, {
      userId,
      domain: textFromUnknown(input.domain),
      sourceSessionId: input.sourceSessionId,
      sourceMessageIds: input.sourceMessageIds,
      sourceUrl: input.sourceUrl,
    });
    if (!draft) continue;
    const identity = memoryIdentity(draft);
    const existingIndex = byIdentity.get(identity);
    if (typeof existingIndex === 'number') {
      const previous = store.items[existingIndex];
      const item: PersonalMemoryItem = {
        ...previous,
        ...draft,
        shared: previous.shared,
        aliases: Array.from(new Set([...previous.aliases, ...draft.aliases])).slice(0, 8),
        text: itemText({ ...draft, aliases: Array.from(new Set([...previous.aliases, ...draft.aliases])).slice(0, 8) }),
        confidence: Math.max(previous.confidence, draft.confidence),
        sourceSessionId: draft.sourceSessionId || previous.sourceSessionId,
        sourceMessageIds: Array.from(new Set([...(previous.sourceMessageIds || []), ...(draft.sourceMessageIds || [])])).slice(-20),
        sourceUrl: draft.sourceUrl || previous.sourceUrl,
        updatedAt: timestamp,
        status: previous.status,
      };
      store.items[existingIndex] = item;
      saved.push(item);
    } else {
      const item: PersonalMemoryItem = {
        ...draft,
        id: `mem_${randomUUID()}`,
        createdAt: timestamp,
        updatedAt: timestamp,
        useCount: 0,
      };
      byIdentity.set(identity, store.items.length);
      store.items.push(item);
      saved.push(item);
    }
  }
  if (saved.length) await writePersonalMemoryRecords(saved);
  return saved;
}

export async function extractPersonalMemoryFromTurn(input: {
  userId?: unknown;
  currentUrl?: string;
  targetUrl?: string;
  userMessage: string;
  assistantReply: string;
  conversation?: PersonalMemoryConversationMessage[];
  steps: StepExecutionResult[];
  sourceSessionId: string;
  sourceMessageIds: string[];
}): Promise<PersonalMemoryExtractionResult> {
  if (!personalMemoryExtractionEnabled()) return {
    items: [],
    rawText: '',
    skipped: true,
    reason: 'disabled',
    diagnostics: {
      candidateCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      savedCount: 0,
      normalizationRejectedCount: 0,
      rejectionReasons: {},
      rejectedCandidates: [],
    },
  };
  const userId = normalizePersonalMemoryUserId(input.userId);
  const currentDomain = normalizePersonalMemoryDomain(input.currentUrl || input.targetUrl || '');
  const existingItems = await listPersonalMemoryItems({ userId, domain: currentDomain, includeDisabled: true });
  const prompt = buildExtractionPrompt({
    userId,
    currentDomain,
    currentUrl: input.currentUrl || '',
    targetUrl: input.targetUrl || '',
    userMessage: input.userMessage,
    assistantReply: input.assistantReply,
    conversation: input.conversation || [],
    steps: input.steps,
    existingItems,
  });
  const result = await generateText({
    model: getModel(),
    temperature: 0.1,
    maxRetries: 3,
    prompt,
    telemetry: aiTelemetry('personal-memory-extraction'),
  });
  const output = parsePersonalMemoryExtractionOutput(result.text);
  const userMessages = [
    ...(input.conversation || []).filter((message) => message.role === 'user').map((message) => message.content),
    input.userMessage,
  ];
  const filtered = analyzeDurablePersonalMemoryDrafts(output.items, userMessages);
  const items = await upsertExtractedPersonalMemoryItems({
    userId,
    domain: currentDomain,
    sourceSessionId: input.sourceSessionId,
    sourceMessageIds: input.sourceMessageIds,
    sourceUrl: input.currentUrl || input.targetUrl || '',
    items: filtered.items,
  });
  const rejectionReasons = filtered.rejected.reduce<Partial<Record<PersonalMemoryFilterRejectionReason, number>>>((counts, rejection) => {
    counts[rejection.reason] = (counts[rejection.reason] || 0) + 1;
    return counts;
  }, {});
  return {
    items,
    rawText: result.text,
    skipped: false,
    diagnostics: {
      candidateCount: output.items.length,
      acceptedCount: filtered.items.length,
      rejectedCount: filtered.rejected.length,
      savedCount: items.length,
      normalizationRejectedCount: Math.max(0, filtered.items.length - items.length),
      rejectionReasons,
      rejectedCandidates: filtered.rejected,
    },
  };
}

export function personalMemoryDiagnostics() {
  return {
    enabled: personalMemoryEnabled(),
    extractionEnabled: personalMemoryExtractionEnabled(),
    promptLimit: personalMemoryPromptLimit(),
    promptMaxChars: personalMemoryPromptMaxChars(),
    provider: getModelSettings().provider,
    model: getModelSettings().model,
  };
}
