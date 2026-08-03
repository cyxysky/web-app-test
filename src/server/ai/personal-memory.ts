import { randomUUID } from 'node:crypto';
import { generateText } from 'ai';
import { normalizeApplicationUserId } from '@/server/auth/user-context';
import { getModel, getModelSettings } from '@/server/ai/model';
import type { StepExecutionResult } from '@/server/ai/schemas/runtime.schema';
import { readPersonalMemoryRecords, replacePersonalMemoryRecords } from '@/server/storage/sqlite-record-store';

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

function personalMemoryExtractionTimeoutMs() {
  const raw = Number(process.env.AI_PERSONAL_MEMORY_EXTRACTION_TIMEOUT_MS || process.env.AI_REQUEST_TIMEOUT_MS || 30000);
  return Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 1000), 120000) : 30000;
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

function readStore(): PersonalMemoryStoreFile {
  const items = readPersonalMemoryRecords<PersonalMemoryItem>()
    .map(normalizeStoreItem)
    .filter((item): item is PersonalMemoryItem => Boolean(item));
  return { version: 1, items };
}

function writeStore(store: PersonalMemoryStoreFile) {
  replacePersonalMemoryRecords(store.items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
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

export function listPersonalMemoryItems(input: {
  userId?: unknown;
  domain?: unknown;
  includeDisabled?: boolean;
} = {}) {
  const userId = normalizePersonalMemoryUserId(input.userId);
  const domain = normalizePersonalMemoryDomain(input.domain);
  return readStore().items.filter((item) => {
    if (item.userId !== userId && !item.shared) return false;
    if (!input.includeDisabled && item.status !== 'active') return false;
    if (!domain) return true;
    return item.scope === 'global' || domainMatches(item.domain, domain);
  });
}

export function getPersonalMemoryItem(id: string, userId?: unknown) {
  const normalizedUserId = normalizePersonalMemoryUserId(userId);
  return readStore().items.find((item) => item.id === id && (item.userId === normalizedUserId || item.shared));
}

export function savePersonalMemoryItem(input: PersonalMemoryDraft & {
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
  const store = readStore();
  const timestamp = now();
  const requestedId = compactText(input.id, 120);
  const requestedItem = requestedId ? store.items.find((item) => item.id === requestedId) : undefined;
  if (requestedItem && requestedItem.userId !== userId) {
    throw new Error('Only the memory creator can edit this shared memory.');
  }
  const identity = memoryIdentity(draft);
  const existingIndex = store.items.findIndex((item) => (
    (requestedId && item.id === requestedId && item.userId === userId)
    || memoryIdentity(item) === identity
  ));
  const previous = existingIndex >= 0 ? store.items[existingIndex] : undefined;
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
  if (existingIndex >= 0) store.items[existingIndex] = item;
  else store.items.push(item);
  writeStore(store);
  return item;
}

export function updatePersonalMemoryItem(id: string, patch: PersonalMemoryDraft, userId?: unknown) {
  const normalizedUserId = normalizePersonalMemoryUserId(userId);
  const store = readStore();
  const index = store.items.findIndex((item) => item.id === id && item.userId === normalizedUserId);
  if (index < 0) return undefined;
  const previous = store.items[index];
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
  const item: PersonalMemoryItem = {
    ...previous,
    ...draft,
    id: previous.id,
    createdAt: previous.createdAt,
    updatedAt: now(),
    lastUsedAt: previous.lastUsedAt,
    useCount: previous.useCount,
    status: normalizeStatus(patch.status ?? previous.status),
  };
  store.items[index] = item;
  writeStore(store);
  return item;
}

export function deletePersonalMemoryItem(id: string, userId?: unknown) {
  const normalizedUserId = normalizePersonalMemoryUserId(userId);
  const store = readStore();
  const before = store.items.length;
  const deleted = store.items.find((item) => item.id === id && item.userId === normalizedUserId);
  store.items = store.items.filter((item) => !(item.id === id && item.userId === normalizedUserId));
  if (store.items.length !== before) writeStore(store);
  return deleted;
}

function normalizedSearchText(value: unknown) {
  return textFromUnknown(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

function termMatches(query: string, term: string) {
  const normalized = normalizedSearchText(term);
  return normalized.length >= 2 && query.includes(normalized);
}

export function searchPersonalMemory(input: {
  userId?: unknown;
  query?: unknown;
  domain?: unknown;
  limit?: number;
}): PersonalMemorySearchResult[] {
  if (!personalMemoryEnabled()) return [];
  const userId = normalizePersonalMemoryUserId(input.userId);
  const domain = normalizePersonalMemoryDomain(input.domain);
  const query = normalizedSearchText(input.query);
  const limit = typeof input.limit === 'number' ? input.limit : personalMemoryPromptLimit();
  if (limit <= 0) return [];
  const results: PersonalMemorySearchResult[] = [];
  for (const item of readStore().items) {
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
    const terms = [item.key, ...item.aliases];
    for (const term of terms) {
      if (termMatches(query, term)) {
        score += term === item.key ? 10 : 8;
        reasons.push(term === item.key ? 'key' : 'alias');
        break;
      }
    }
    if (item.domain && termMatches(query, item.domain)) {
      score += 3;
      reasons.push('domain-mentioned');
    }
    if (item.scope === 'global' && !reasons.some((reason) => reason === 'key' || reason === 'alias') && !['preference', 'workflow'].includes(item.type)) {
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
  const idSet = new Set(uniqueIds);
  const store = readStore();
  const timestamp = now();
  const updated: PersonalMemoryItem[] = [];
  store.items = store.items.map((item) => {
    if (!idSet.has(item.id)) return item;
    const next = {
      ...item,
      lastUsedAt: timestamp,
      useCount: item.useCount + 1,
      updatedAt: timestamp,
    };
    updated.push(next);
    return next;
  });
  if (updated.length) writeStore(store);
  return updated;
}

export function formatPersonalMemoryForPrompt(results: PersonalMemorySearchResult[] | PersonalMemoryItem[]) {
  const items = results.map((entry) => 'item' in entry ? entry.item : entry).filter((item) => item.status === 'active');
  if (!items.length) return '';
  const prompt = [
    'Personal short memory:',
    'Use these concise user/domain facts when relevant. If the latest user message contradicts a memory, follow the latest user message.',
    ...items.map((item, index) => {
      const scope = item.scope === 'domain' && item.domain ? `[${item.domain}]` : '[global]';
      const aliases = item.aliases.length ? ` aliases=${item.aliases.join(', ')}` : '';
      const value = normalizePersonalMemoryValue(item.value)
        .split('\n')
        .map((line) => `   ${line}`)
        .join('\n');
      return `${index + 1}. ${scope} ${item.type} ${item.key}${aliases}:\n${value}`;
    }),
  ].join('\n');
  const maxChars = personalMemoryPromptMaxChars();
  if (prompt.length <= maxChars) return prompt;
  const suffix = '\n[Personal memory truncated only for this prompt; the stored memory remains complete.]';
  return `${prompt.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd()}${suffix}`;
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

function extractJsonObject(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || trimmed;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1)) as unknown;
    }
    throw new Error('AI personal memory extraction did not return JSON.');
  }
}

const personalMemoryDurabilitySignals = new Set<PersonalMemoryDurabilitySignal>([
  'explicit_preference',
  'explicit_workflow',
  'explicit_alias',
  'explicit_remember',
  'repeated_user_behavior',
]);

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
  const normalizedUserMessages = userMessages.map(normalizedEvidenceText).filter(Boolean);
  return items.filter((item) => {
    const evidence = normalizedEvidenceTexts(item.evidence);
    const signal = textFromUnknown(item.durability).trim() as PersonalMemoryDurabilitySignal;
    if (!evidence.length || !personalMemoryDurabilitySignals.has(signal)) return false;
    const sourceMessageIndexes = new Set(evidence.map((quote) => (
      normalizedUserMessages.findIndex((message) => message.includes(quote))
    )).filter((index) => index >= 0));
    if (signal === 'repeated_user_behavior') {
      if (evidence.length < 2 || sourceMessageIndexes.size < 2) return false;
    } else {
      const hasDurableUserEvidence = Array.from(sourceMessageIndexes).some((index) => (
        hasExplicitDurabilityCue(normalizedUserMessages[index], signal)
      ));
      if (!hasDurableUserEvidence) return false;
    }
    const type = normalizeType(item.type);
    if (type === 'domain_fact' && signal !== 'explicit_remember' && signal !== 'explicit_alias') return false;
    return true;
  });
}

function parseExtractionItems(text: string, userMessages: string[]): PersonalMemoryDraft[] {
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const items = (parsed as { items?: unknown }).items;
  const drafts = Array.isArray(items)
    ? items.filter((item): item is PersonalMemoryExtractionDraft => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : [];
  return filterDurablePersonalMemoryDrafts(drafts, userMessages);
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
    'Return ONLY strict JSON: {"items":[...]}',
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

export function upsertExtractedPersonalMemoryItems(input: {
  userId?: unknown;
  domain?: unknown;
  sourceSessionId?: string;
  sourceMessageIds?: string[];
  sourceUrl?: string;
  items: PersonalMemoryDraft[];
}) {
  const userId = normalizePersonalMemoryUserId(input.userId);
  const store = readStore();
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
  if (saved.length) writeStore(store);
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
  if (!personalMemoryExtractionEnabled()) return { items: [], rawText: '', skipped: true, reason: 'disabled' };
  const userId = normalizePersonalMemoryUserId(input.userId);
  const currentDomain = normalizePersonalMemoryDomain(input.currentUrl || input.targetUrl || '');
  const existingItems = listPersonalMemoryItems({ userId, domain: currentDomain, includeDisabled: true });
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
  const timeoutMs = personalMemoryExtractionTimeoutMs();
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new Error(`Personal memory extraction timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    const result = await generateText({
      model: getModel(),
      temperature: 0.1,
      maxRetries: 0,
      prompt,
      abortSignal: timeoutController.signal,
    });
    const items = upsertExtractedPersonalMemoryItems({
      userId,
      domain: currentDomain,
      sourceSessionId: input.sourceSessionId,
      sourceMessageIds: input.sourceMessageIds,
      sourceUrl: input.currentUrl || input.targetUrl || '',
      items: parseExtractionItems(result.text || '', [
        ...(input.conversation || []).filter((message) => message.role === 'user').map((message) => message.content),
        input.userMessage,
      ]),
    });
    return { items, rawText: result.text || '', skipped: false };
  } finally {
    clearTimeout(timer);
  }
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
