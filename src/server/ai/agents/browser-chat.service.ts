import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { generateText } from 'ai';
import { BrowserSession, type BrowserScreencastFrame, type BrowserSessionMode, type BrowserTabSnapshot } from '@/server/browser/browser-session';
import {
  executeInteractiveBrowserTurn,
  type BrowserToolConfirmationDecision,
  type BrowserToolConfirmationRequest,
  type InteractiveBrowserTurnMessage,
  type InteractiveBrowserTurnResult,
} from '@/server/ai/agents/browser-chat-executor.agent';
import { generateSkillFromRun } from '@/server/ai/agents/skill-generator.agent';
import { formatSkillReferencesForUser, formatSkillsForPrompt } from '@/server/ai/agents/skill-context';
import {
  extractPersonalMemoryFromTurn,
  formatPersonalMemoryForPrompt,
  markPersonalMemoryItemsUsed,
  normalizePersonalMemoryDomain,
  personalMemoryEnabled,
  searchPersonalMemory,
} from '@/server/ai/personal-memory';
import { getModel, getModelSettings, withModelSettings } from '@/server/ai/model';
import type { ModelProvider, RecordedFlowStep, SkillRecord, StepExecutionResult, TestCaseContent, TestCaseRecord, TestRunRecord } from '@/server/ai/schemas/test-case.schema';
import { store } from '@/server/db/mock-store';
import { publishRefreshEvent } from '@/server/realtime/ws-refresh';
import { writeTextFileAtomic } from '@/server/storage/atomic-json';
import {
  artifactPath as resolveArtifactPath,
  browserChatSessionFilePath,
  browserChatSessionLogFilePath,
  browserChatSessionSummariesDir,
  browserChatSessionSummaryFilePath,
  browserChatSessionsDir,
} from '@/server/storage/paths';
import { artifactApiUrlFromRelative } from '@/lib/artifacts';
import { normalizeModelProvider, resolveRuntimeModelSelection } from '@/lib/model-selection';

export type BrowserChatAttachment = {
  id: string;
  name: string;
  type: string;
  size?: number;
  path: string;
  url: string;
  kind?: 'image' | 'file' | 'tab';
  sourceUrl?: string;
};

export type BrowserChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  updatedAt?: string;
  clientMessageId?: string;
  attachments?: BrowserChatAttachment[];
  skillIds?: string[];
  stepIndexes?: number[];
  activity?: {
    phase: string;
    label: string;
    updatedAt: string;
  };
  status?: 'running' | 'passed' | 'failed' | 'blocked' | 'interrupted';
};

export type BrowserChatLogRecord = {
  id: string;
  time: string;
  phase: string;
  message: string;
  details?: string;
  messageId?: string;
  stepIndex?: number;
  elapsedMs?: number;
};

export type BrowserChatConversationContext = {
  version: 1;
  updatedAt: string;
  coveredMessageIds: string[];
  summary: string;
};

export type BrowserChatSafetyMode = 'strict' | 'full';

export type BrowserChatToolConfirmation = {
  id: string;
  messageId: string;
  stepIndex?: number;
  toolName: string;
  inputSignature: string;
  reason?: string;
  prompt: string;
  requestedAt: string;
};

export type BrowserChatSessionSnapshot = {
  id: string;
  title: string;
  userId?: string;
  browserGroupId: string;
  targetUrl: string;
  noVncUrl?: string;
  mode: BrowserSessionMode;
  safetyMode: BrowserChatSafetyMode;
  modelProvider: ModelProvider;
  model: string;
  status: 'idle' | 'running' | 'closed' | 'error';
  busy: boolean;
  tabs: BrowserTabSnapshot[];
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  error?: string;
  messages: BrowserChatMessage[];
  steps: StepExecutionResult[];
  consoleErrors: string[];
  networkErrors: string[];
  logs: BrowserChatLogRecord[];
  conversationContext?: BrowserChatConversationContext;
  pendingToolConfirmation?: BrowserChatToolConfirmation;
};

type BrowserChatSessionRecord = BrowserChatSessionSnapshot & {
  activeAssistantMessageId?: string;
  activeAbortController?: AbortController;
  browser?: BrowserSession;
  started: boolean;
};

type BrowserChatRuntimeState = {
  sessions: Map<string, BrowserChatSessionRecord>;
  interruptedAssistantMessageIds: Set<string>;
  toolConfirmations: Map<string, {
    sessionId: string;
    resolve: (decision: BrowserToolConfirmationDecision) => void;
    promise: Promise<BrowserToolConfirmationDecision>;
  }>;
  pendingPersistTimers: Map<string, ReturnType<typeof setTimeout>>;
  sessionFileCache: Map<string, { mtimeMs: number; size: number; snapshot: BrowserChatSessionSnapshot }>;
  sessionLogFileCache: Map<string, { mtimeMs: number; size: number; logs: BrowserChatLogRecord[] }>;
  lastPersistWarningAt: number;
};

const browserChatRuntimeState = ((globalThis as typeof globalThis & {
  __browserChatRuntimeState?: BrowserChatRuntimeState;
}).__browserChatRuntimeState ??= {
  sessions: new Map<string, BrowserChatSessionRecord>(),
  interruptedAssistantMessageIds: new Set<string>(),
  toolConfirmations: new Map<string, {
    sessionId: string;
    resolve: (decision: BrowserToolConfirmationDecision) => void;
    promise: Promise<BrowserToolConfirmationDecision>;
  }>(),
  pendingPersistTimers: new Map<string, ReturnType<typeof setTimeout>>(),
  sessionFileCache: new Map<string, { mtimeMs: number; size: number; snapshot: BrowserChatSessionSnapshot }>(),
  sessionLogFileCache: new Map<string, { mtimeMs: number; size: number; logs: BrowserChatLogRecord[] }>(),
  lastPersistWarningAt: 0,
});
browserChatRuntimeState.sessions ??= new Map();
browserChatRuntimeState.interruptedAssistantMessageIds ??= new Set();
browserChatRuntimeState.toolConfirmations ??= new Map();
browserChatRuntimeState.pendingPersistTimers ??= new Map();
browserChatRuntimeState.sessionFileCache ??= new Map();
browserChatRuntimeState.sessionLogFileCache ??= new Map();

const sessions = browserChatRuntimeState.sessions;
const sessionsDir = browserChatSessionsDir();
const sessionSummariesDir = browserChatSessionSummariesDir();
const sessionFileCache = browserChatRuntimeState.sessionFileCache;
const sessionLogFileCache = browserChatRuntimeState.sessionLogFileCache;
const interruptedAssistantMessageIds = browserChatRuntimeState.interruptedAssistantMessageIds;
const toolConfirmations = browserChatRuntimeState.toolConfirmations;
const pendingPersistTimers = browserChatRuntimeState.pendingPersistTimers;
const browserStartPromises = new Map<string, Promise<BrowserSession>>();
const runningHydrationGraceMs = 2 * 60 * 1000;
const fullLogDetailsFlag = '__browserChatFullLogDetails';

function browserChatNoVncUrl(session: Pick<BrowserChatSessionSnapshot, 'id' | 'userId'>) {
  const template = String(process.env.BROWSER_CHAT_NOVNC_URL || process.env.NEXT_PUBLIC_BROWSER_CHAT_NOVNC_URL || '').trim();
  if (!template) return undefined;
  const encodedSessionId = encodeURIComponent(session.id);
  const encodedUserId = encodeURIComponent(session.userId || '');
  return template
    .replace(/\{sessionId\}/g, encodedSessionId)
    .replace(/\{id\}/g, encodedSessionId)
    .replace(/\{userId\}/g, encodedUserId)
    .replace(/\{qzUserId\}/g, encodedUserId);
}

function browserChatBrowserProfileKey(session: Pick<BrowserChatSessionSnapshot, 'id' | 'userId'>) {
  const userId = normalizeUserId(session.userId);
  return `user_${userId || 'default'}`;
}

function fullLogDetails(value: unknown) {
  return { [fullLogDetailsFlag]: true, value };
}

function browserChatLogLimit() {
  const raw = Number(process.env.BROWSER_CHAT_LOG_LIMIT || 2000);
  const normalized = Number.isFinite(raw) ? Math.floor(raw) : 2000;
  return Math.min(Math.max(normalized, 300), 10000);
}

function browserChatProgressPersistDelayMs() {
  const raw = Number(process.env.BROWSER_CHAT_PROGRESS_PERSIST_DELAY_MS || 600);
  const normalized = Number.isFinite(raw) ? Math.floor(raw) : 100;
  return Math.min(Math.max(normalized, 0), 1000);
}

function trimBrowserChatLogs(logs: BrowserChatLogRecord[]) {
  return logs.slice(-browserChatLogLimit());
}

function browserChatLogStorageLimit() {
  return Math.min(browserChatLogLimit() + 200, 10200);
}

function browserChatKeepBrowserOpenAfterTurn() {
  return process.env.BROWSER_CHAT_KEEP_BROWSER_OPEN_AFTER_TURN !== 'false';
}

function browserChatMemoryUrl(browser: BrowserSession | undefined, session: Pick<BrowserChatSessionSnapshot, 'targetUrl'>) {
  const currentUrl = browser?.currentUrl() || '';
  return currentUrl || session.targetUrl || '';
}

function browserChatPersonalMemoryContext(input: {
  session: BrowserChatSessionRecord;
  browser: BrowserSession;
  text: string;
  modelText: string;
  currentUrl?: string;
  domainOnly?: boolean;
  excludedIds?: ReadonlySet<string>;
  logPhase?: string;
}) {
  const currentUrl = input.currentUrl || browserChatMemoryUrl(input.browser, input.session);
  const currentDomain = normalizePersonalMemoryDomain(currentUrl || input.session.targetUrl);
  if (!personalMemoryEnabled()) return { context: '', itemIds: [] as string[], domain: currentDomain };
  const results = searchPersonalMemory({
    userId: input.session.userId,
    query: [input.text, input.modelText, input.session.title].filter(Boolean).join('\n'),
    domain: currentUrl || input.session.targetUrl,
  }).filter((result) => (
    (!input.domainOnly || result.item.scope === 'domain')
    && !input.excludedIds?.has(result.item.id)
  ));
  if (!results.length) return { context: '', itemIds: [] as string[], domain: currentDomain };
  markPersonalMemoryItemsUsed(results.map((result) => result.item.id));
  appendLog(input.session, input.logPhase || 'memory:prompt', `已注入 ${results.length} 条个性化短记忆。`, {
    details: {
      currentDomain,
      items: results.map((result) => ({
        id: result.item.id,
        scope: result.item.scope,
        domain: result.item.domain,
        type: result.item.type,
        key: result.item.key,
        score: result.score,
        reasons: result.reasons,
      })),
    },
    deferPersist: true,
  });
  return {
    context: formatPersonalMemoryForPrompt(results),
    itemIds: results.map((result) => result.item.id),
    domain: currentDomain,
  };
}

function queuePersonalMemoryExtraction(input: {
  session: BrowserChatSessionRecord;
  browser: BrowserSession;
  text: string;
  result: InteractiveBrowserTurnResult;
  userMessageId: string;
  assistantMessageId: string;
}) {
  if (!personalMemoryEnabled()) return;
  const currentUrl = browserChatMemoryUrl(input.browser, input.session);
  const conversation = input.session.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
  const startedAt = Date.now();
  void extractPersonalMemoryFromTurn({
    userId: input.session.userId,
    currentUrl,
    targetUrl: input.session.targetUrl,
    userMessage: input.text,
    assistantReply: input.result.reply,
    conversation,
    steps: input.result.newSteps,
    sourceSessionId: input.session.id,
    sourceMessageIds: [input.userMessageId, input.assistantMessageId],
  }).then((memoryResult) => {
    const current = sessions.get(input.session.id);
    if (!current || current !== input.session || memoryResult.skipped || !memoryResult.items.length) return;
    appendLog(current, 'memory:extract:done', `已提炼 ${memoryResult.items.length} 条个性化短记忆。`, {
      elapsedMs: elapsedMs(startedAt),
      messageId: null,
      details: {
        currentDomain: normalizePersonalMemoryDomain(currentUrl || input.session.targetUrl),
        items: memoryResult.items.map((item) => ({
          id: item.id,
          scope: item.scope,
          domain: item.domain,
          type: item.type,
          key: item.key,
          value: item.value,
          confidence: item.confidence,
        })),
      },
    });
  }).catch((error) => {
    const current = sessions.get(input.session.id);
    if (!current || current !== input.session) return;
    appendLog(current, 'memory:extract:error', `个性化短记忆提炼失败：${error instanceof Error ? error.message : 'unknown error'}`, {
      elapsedMs: elapsedMs(startedAt),
      messageId: null,
      details: errorLogDetails(error),
    });
  });
}

function normalizeSafetyMode(value: unknown): BrowserChatSafetyMode {
  return value === 'full' ? 'full' : 'strict';
}

function browserChatModelSettings(providerInput?: unknown, modelInput?: unknown) {
  store.applyRuntimeEnv();
  const config = store.getModelConfig();
  return resolveRuntimeModelSelection(config, {
    fallbackProvider: config?.provider,
    model: modelInput,
    provider: providerInput,
  });
}

function normalizeToolConfirmation(value: unknown): BrowserChatToolConfirmation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Partial<BrowserChatToolConfirmation>;
  const confirmationId = typeof record.id === 'string' ? record.id.trim() : '';
  const messageId = typeof record.messageId === 'string' ? record.messageId.trim() : '';
  const toolName = typeof record.toolName === 'string' ? record.toolName.trim() : '';
  const inputSignature = typeof record.inputSignature === 'string' ? record.inputSignature : '';
  const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : '';
  if (!confirmationId || !messageId || !toolName || !prompt) return undefined;
  return {
    id: confirmationId,
    messageId,
    stepIndex: typeof record.stepIndex === 'number' && Number.isFinite(record.stepIndex) ? Math.floor(record.stepIndex) : undefined,
    toolName,
    inputSignature,
    reason: typeof record.reason === 'string' && record.reason.trim() ? compactText(record.reason, 300) : undefined,
    prompt: compactText(prompt, 500),
    requestedAt: typeof record.requestedAt === 'string' ? record.requestedAt : now(),
  };
}

function now() {
  return new Date().toISOString();
}

function id(prefix: string) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function notifySessionUpdate(sessionId: string) {
  const session = sessions.get(sessionId);
  if (session) {
    publishRefreshEvent({ entityType: 'browserChatSession', id: sessionId, updatedAt: session.updatedAt });
  } else {
    publishRefreshEvent({ entityType: 'browserChatSession', id: sessionId, deleted: true });
  }
}

function elapsedMs(startedAt: number) {
  return Date.now() - startedAt;
}

function elapsedFromDetails(details: unknown) {
  if (!details || typeof details !== 'object') return undefined;
  const value = (details as { elapsedMs?: unknown }).elapsedMs;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function trimLogText(value: string, max = 3000) {
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function unwrapLogDetails(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { value, full: false };
  }
  const record = value as Record<string, unknown>;
  if (record[fullLogDetailsFlag] !== true) {
    return { value, full: false };
  }
  return { value: record.value, full: true };
}

function stringifyCompactLogDetails(value: unknown) {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (key, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (typeof item === 'function' || typeof item === 'symbol') return undefined;
    if (typeof item === 'string') {
      const max = /^(tree|elements|structuredText|text|actual|result|system|prompt|content)$/i.test(key) ? 1200 : 600;
      return trimLogText(item, max);
    }
    if (!item || typeof item !== 'object') return item;
    if (item instanceof Error) {
      return {
        name: item.name,
        message: item.message,
        stack: trimLogText(item.stack || '', 1200),
      };
    }
    if (item instanceof ArrayBuffer) return `[ArrayBuffer ${item.byteLength} bytes]`;
    if (ArrayBuffer.isView(item)) {
      const view = item as ArrayBufferView;
      return `[${item.constructor.name || 'TypedArray'} ${view.byteLength} bytes]`;
    }
    if (seen.has(item)) return '[Circular]';
    seen.add(item);
    if (Array.isArray(item) && /^(interactiveCandidates|scrollableAreas|messages|modelMessages|conversation|tabs)$/i.test(key)) {
      return `[${item.length} items]`;
    }
    return item;
  }, 2);
}

function logDetailsFromUnknown(input: unknown) {
  const { value, full } = unwrapLogDetails(input);
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') return full ? value.trim() : trimLogText(value);
  try {
    const serialized = (full ? stringifyJsonSafe(value, 2) : stringifyCompactLogDetails(value)) || String(value);
    return full ? serialized.trim() : trimLogText(serialized);
  } catch {
    const fallback = String(value);
    return full ? fallback.trim() : trimLogText(fallback);
  }
}

function errorLogDetails(error: unknown) {
  if (!(error instanceof Error)) return logDetailsFromUnknown(error);
  return logDetailsFromUnknown({
    name: error.name,
    message: error.message,
    stack: error.stack,
    cause: error.cause instanceof Error
      ? { name: error.cause.name, message: error.cause.message, stack: error.cause.stack }
      : error.cause,
    data: 'data' in error ? (error as { data?: unknown }).data : undefined,
    code: 'code' in error ? (error as { code?: unknown }).code : undefined,
  });
}

function userFacingErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '未知错误');
  const detail = errorLogDetails(error);
  if (!detail || detail === message) return message;
  if (/^\{\s*"/.test(detail)) return message;
  return `${message}\n${detail}`;
}

function normalizeBrowserUrl(url: string) {
  const trimmed = url.trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /^(about|data|file|blob):/i.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(trimmed)) return `http://${trimmed}`;
  return `https://${trimmed}`;
}

function isEmbeddedBrowserPlaceholderUrl(url: string) {
  return /^data:text\/html/i.test(url)
    && /data-webpilot-embedded-browser|WebPilot(?:%20|\+)Embedded(?:%20|\+)Browser|WebPilot embedded browser/i.test(url);
}

function isBlankBrowserUrl(url: string) {
  return !url
    || url === 'about:blank'
    || /^(about:newtab|chrome:\/\/new-tab-page|edge:\/\/newtab)/i.test(url)
    || isEmbeddedBrowserPlaceholderUrl(url);
}

function exportableTargetUrl(value?: string) {
  const url = normalizeBrowserUrl(value || '');
  if (!url || isBlankBrowserUrl(url) || /^(blob|javascript):/i.test(url)) return '';
  return url;
}

function inputUrl(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const value = (input as { url?: unknown }).url;
  return typeof value === 'string' ? value : '';
}

function firstExportableTargetUrl(candidates: Array<string | undefined>) {
  for (const candidate of candidates) {
    const url = exportableTargetUrl(candidate);
    if (url) return url;
  }
  return '';
}

function exportedTargetUrl(session: BrowserChatSessionRecord, steps: StepExecutionResult[]) {
  const browserCurrentUrl = session.browser?.currentUrl();
  const urlsFromOpenTools = steps.flatMap((step) => (step.tools || []).flatMap((tool) => (
    /^openPage$/i.test(tool.name) ? [inputUrl(tool.input)] : []
  )));
  return firstExportableTargetUrl([
    session.targetUrl,
    browserCurrentUrl,
    ...urlsFromOpenTools,
  ]);
}

function exportedRecordedToolInput(toolName: string, input: unknown, targetUrl: string) {
  if (!/^openPage$/i.test(toolName)) return input;
  const url = exportableTargetUrl(inputUrl(input));
  if (url) return input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return targetUrl ? { url: targetUrl } : input;
  const rest = { ...(input as Record<string, unknown>) };
  delete rest.url;
  return targetUrl ? { ...rest, url: targetUrl } : rest;
}

function textFromUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
        const record = item as Record<string, unknown>;
        return textFromUnknown(record.text ?? record.content);
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return textFromUnknown(record.text ?? record.content);
  }
  return '';
}

function compactText(value: unknown = '', max = 180) {
  const text = textFromUnknown(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function normalizeUserId(value: unknown) {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  return '';
}

function sessionBelongsToUser(session: Pick<BrowserChatSessionSnapshot, 'userId'>, userId?: unknown) {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) return true;
  return normalizeUserId(session.userId) === normalizedUserId;
}

function normalizeConversationContext(value: unknown): BrowserChatConversationContext | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Partial<BrowserChatConversationContext>;
  const arrayOfStrings = (items: unknown, limit: number, max = 420) => (
    Array.isArray(items)
      ? items.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => compactText(item, max)).slice(-limit)
      : []
  );
  const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
  if (!summary) return undefined;
  return {
    version: 1,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : now(),
    coveredMessageIds: arrayOfStrings(record.coveredMessageIds, 300, 120),
    summary: compactText(summary, 12000),
  };
}

function normalizeAttachmentPath(value: unknown) {
  const raw = typeof value === 'string' ? value.trim().replace(/\\/g, '/') : '';
  if (!raw || raw.startsWith('/') || raw.includes('..')) return undefined;
  if (!raw.startsWith('uploads/')) return undefined;
  return raw.split('/').filter(Boolean).join('/');
}

function normalizeAttachments(value: unknown): BrowserChatAttachment[] {
  if (!Array.isArray(value)) return [];
  const attachments: BrowserChatAttachment[] = [];
  for (const item of value.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const rawType = typeof record.type === 'string' && record.type.trim() ? record.type.trim().slice(0, 160) : 'application/octet-stream';
    const requestedKind = record.kind === 'tab' || record.kind === 'file' || record.kind === 'image' ? record.kind : undefined;
    const isTabReference = requestedKind === 'tab' || rawType === 'application/x-webpilot-tab';
    const pathValue = isTabReference ? '' : normalizeAttachmentPath(record.path);
    if (!isTabReference && !pathValue) continue;
    const attachmentPath = pathValue || '';
    const type = isTabReference ? 'application/x-webpilot-tab' : rawType;
    const kind = isTabReference ? 'tab' : (type.startsWith('image/') ? 'image' : 'file');
    const sourceUrl = typeof record.sourceUrl === 'string' ? record.sourceUrl.trim().slice(0, 2000) : '';
    const urlValue = typeof record.url === 'string' ? record.url.trim().slice(0, 2000) : '';
    const idValue = typeof record.id === 'string' && record.id.trim() ? record.id.trim().slice(0, 160) : (attachmentPath ? path.basename(attachmentPath) : randomUUID());
    const nameValue = typeof record.name === 'string' && record.name.trim() ? record.name.trim().slice(0, 180) : (attachmentPath ? path.basename(attachmentPath) : sourceUrl || urlValue || '新建标签页');
    const sizeValue = typeof record.size === 'number' && Number.isFinite(record.size) ? Math.max(0, Math.floor(record.size)) : undefined;
    attachments.push({
      id: idValue,
      kind,
      name: nameValue,
      type,
      size: sizeValue,
      path: attachmentPath,
      sourceUrl: isTabReference ? sourceUrl || urlValue : undefined,
      url: isTabReference
        ? sourceUrl || urlValue
        : (typeof record.url === 'string' && record.url.startsWith('/api/artifacts/') ? record.url : artifactApiUrlFromRelative(attachmentPath)),
    });
  }
  return attachments;
}

function normalizeSkillIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean)))
    .slice(0, 8);
}

function attachmentAbsolutePath(attachment: BrowserChatAttachment) {
  if (attachment.kind === 'tab' || !attachment.type.startsWith('image/')) return undefined;
  const relativePath = normalizeAttachmentPath(attachment.path);
  if (!relativePath) return undefined;
  return resolveArtifactPath(...relativePath.split('/'));
}

function attachmentKindLabel(attachment: BrowserChatAttachment) {
  if (attachment.kind === 'tab' || attachment.type === 'application/x-webpilot-tab') return '标签页';
  if (attachment.kind === 'image' || attachment.type.startsWith('image/')) return '图片';
  return '文件';
}

const inlineReferenceTokenPattern = /\[\[(skill|ref):([^\]]+)\]\]/g;

function decodeInlineReferenceId(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function attachmentPromptText(attachment: BrowserChatAttachment, index?: number) {
  const location = attachment.kind === 'tab'
    ? attachment.sourceUrl || attachment.url || '新建标签页'
    : attachment.path;
  const prefix = typeof index === 'number' ? `${index}. ` : '';
  return `${prefix}[${attachmentKindLabel(attachment)}] ${attachment.name}${location ? ` (${location})` : ''}`;
}

function inlineReferencedIds(text: string, type: 'ref' | 'skill') {
  const ids = new Set<string>();
  inlineReferenceTokenPattern.lastIndex = 0;
  for (const match of text.matchAll(inlineReferenceTokenPattern)) {
    if (match[1] === type) ids.add(decodeInlineReferenceId(match[2] || ''));
  }
  return ids;
}

function attachmentSummary(attachments?: BrowserChatAttachment[], options: { excludeIds?: Set<string> } = {}) {
  const visibleAttachments = (attachments || []).filter((attachment) => !options.excludeIds?.has(attachment.id));
  if (!visibleAttachments.length) return '';
  return [
    '用户提供的引用：',
    ...visibleAttachments.map((attachment, index) => attachmentPromptText(attachment, index + 1)),
  ].join('\n');
}

function contentWithInlineReferencesForPrompt(content: string, attachments: BrowserChatAttachment[] = []) {
  const attachmentsById = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  return content.replace(inlineReferenceTokenPattern, (_match, type: string, rawId: string) => {
    const id = decodeInlineReferenceId(rawId || '');
    if (type === 'ref') {
      const attachment = attachmentsById.get(id);
      return attachment ? attachmentPromptText(attachment) : '';
    }
    return '';
  }).replace(/[ \t]{2,}/g, ' ').trim();
}

function messageContentForPrompt(message: BrowserChatMessage) {
  const selectedSkills = message.skillIds?.length
    ? store.getSkills(message.skillIds).filter((skill) => skill.status === 'ready')
    : [];
  const text = textFromUnknown(message.content);
  const referencedAttachmentIds = inlineReferencedIds(text, 'ref');
  const skillReferences = selectedSkills.length
    ? formatSkillReferencesForUser(selectedSkills)
    : '';
  return [
    contentWithInlineReferencesForPrompt(text, message.attachments || []),
    skillReferences,
    attachmentSummary(message.attachments, { excludeIds: referencedAttachmentIds }),
  ].filter(Boolean).join('\n\n');
}

function stableConversationMessages(messages: BrowserChatMessage[]) {
  return messages.filter((message) => (
    (message.role === 'user' || message.role === 'assistant')
    && message.status !== 'running'
    && !isTransientBrowserChatProgress(textFromUnknown(message.content))
  ));
}

function estimateTextTokens(value: string) {
  let ascii = 0;
  let nonAscii = 0;
  for (const char of value) {
    if (char.charCodeAt(0) <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4 + nonAscii);
}

function contextWindowTokens() {
  const raw = Number(process.env.AI_CONTEXT_WINDOW_TOKENS || process.env.AI_MODEL_CONTEXT_TOKENS || '');
  if (Number.isFinite(raw) && raw > 1000) return Math.floor(raw);
  return 32000;
}

function contextCompressionThresholdRatio() {
  const raw = Number(process.env.AI_CONTEXT_COMPRESSION_THRESHOLD || process.env.AI_CONTEXT_COMPRESSION_RATIO || 0.7);
  if (!Number.isFinite(raw) || raw <= 0) return 0.7;
  return raw > 1 ? Math.min(0.98, raw / 100) : Math.min(0.98, raw);
}

function browserChatConversationTokenEstimate(messages: InteractiveBrowserTurnMessage[]) {
  return estimateTextTokens(messages.map((message) => `${message.role}: ${message.content}`).join('\n\n'));
}

function browserChatConversationSummaryInputCharLimit() {
  const raw = Number(process.env.AI_BROWSER_CHAT_SUMMARY_INPUT_MAX_CHARS || 60000);
  return Number.isFinite(raw) && raw > 1000 ? Math.floor(raw) : 60000;
}

function buildConversationSummaryPrompt(input: {
  previousContext?: BrowserChatConversationContext;
  messages: BrowserChatMessage[];
  estimatedTokens: number;
  thresholdTokens: number;
}) {
  const source = {
    previousSummary: input.previousContext?.summary || '',
    messages: input.messages.map((message) => ({
      id: message.id,
      role: message.role,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      content: messageContentForPrompt(message),
      stepIndexes: message.stepIndexes || [],
      status: message.status,
    })),
  };
  return [
    'You are compressing the historical messages of a WebPilot browser chat session.',
    'Return a concise Chinese summary that will become the first message of future model contexts.',
    '',
    'Rules:',
    '- Preserve user goals, constraints, decisions, completed work, pending work, blockers, useful findings, URLs/pages, and any facts needed to continue.',
    '- Preserve the order of important events, but do not copy long raw logs or repeated text.',
    '- Do not summarize the latest user request if it is not included in the input.',
    '- Do not invent facts.',
    '- Plain text only. No markdown table.',
    '',
    `Estimated historical context tokens before compression: ${input.estimatedTokens}/${input.thresholdTokens}`,
    '',
    `Input JSON:\n${trimLogText(stringifyJsonSafe(source, 2) || '', browserChatConversationSummaryInputCharLimit())}`,
  ].join('\n');
}

function fallbackConversationSummary(input: { previousContext?: BrowserChatConversationContext; messages: BrowserChatMessage[] }) {
  return [
    input.previousContext?.summary ? `此前摘要：${input.previousContext.summary}` : '',
    ...input.messages.slice(-12).map((message) => `${message.role === 'user' ? '用户' : 'AI'}：${compactText(messageContentForPrompt(message), 700)}`),
  ].filter(Boolean).join('\n');
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function testOperationFromToolName(name?: string): NonNullable<TestCaseContent['steps'][number]['operation']> {
  if (/open|url|navigate/i.test(name || '')) return 'open';
  if (/click|hover|drag/i.test(name || '')) return 'click';
  if (/type|fill|input/i.test(name || '')) return 'fill';
  if (/press|key/i.test(name || '')) return 'press';
  if (/select/i.test(name || '')) return 'select';
  if (/wait/i.test(name || '')) return 'wait';
  if (/screenshot/i.test(name || '')) return 'screenshot';
  return 'assert';
}

type CompletedRunStatus = Extract<TestRunRecord['status'], 'passed' | 'failed' | 'blocked'>;

function statusFromSteps(steps: StepExecutionResult[]): CompletedRunStatus {
  if (steps.some((step) => step.status === 'blocked')) return 'blocked';
  if (steps.some((step) => step.status === 'failed')) return 'failed';
  return 'passed';
}

function compactStepForClient(step: StepExecutionResult): StepExecutionResult {
  const clientStep = { ...step };
  delete clientStep.aiRequest;
  delete clientStep.visualContext;
  delete clientStep.workingMemory;
  return clientStep;
}

function previewMessages(session: Pick<BrowserChatSessionSnapshot, 'messages'>) {
  const firstUserMessage = session.messages.find((message) => message.role === 'user');
  const latestMessage = session.messages.at(-1);
  const selected = [firstUserMessage, latestMessage].filter((message): message is BrowserChatMessage => Boolean(message));
  return Array.from(new Map(selected.map((message) => [message.id, {
    ...message,
    content: compactText(message.content, 180),
  }])).values());
}

function summaryFromSnapshot(session: BrowserChatSessionSnapshot): BrowserChatSessionSnapshot {
  return {
    ...session,
    messages: previewMessages(session),
    steps: [],
    consoleErrors: [],
    networkErrors: [],
    logs: session.busy ? session.logs.slice(-8) : [],
  };
}

function browserChatTabs(session: BrowserChatSessionRecord): BrowserTabSnapshot[] {
  try {
    return session.browser?.getTabsSnapshot() || [];
  } catch {
    return [];
  }
}

function snapshot(session: BrowserChatSessionRecord, options: { fullSteps?: boolean } = {}): BrowserChatSessionSnapshot {
  finalizeIdleRunningAssistantMessages(session);
  return {
    id: session.id,
    title: session.title,
    userId: session.userId,
    browserGroupId: session.browserGroupId,
    targetUrl: session.targetUrl,
    noVncUrl: browserChatNoVncUrl(session),
    mode: session.mode,
    safetyMode: normalizeSafetyMode(session.safetyMode),
    modelProvider: normalizeModelProvider(session.modelProvider),
    model: browserChatModelSettings(session.modelProvider, session.model).model,
    status: session.status,
    busy: session.busy,
    tabs: browserChatTabs(session),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    closedAt: session.closedAt,
    error: session.error,
    messages: [...session.messages],
    steps: options.fullSteps ? [...session.steps] : session.steps.map(compactStepForClient),
    consoleErrors: [...session.consoleErrors],
    networkErrors: [...session.networkErrors],
    logs: [...(session.logs || [])],
    conversationContext: normalizeConversationContext(session.conversationContext),
    pendingToolConfirmation: normalizeToolConfirmation(session.pendingToolConfirmation),
  };
}

function summarySnapshot(session: BrowserChatSessionRecord): BrowserChatSessionSnapshot {
  finalizeIdleRunningAssistantMessages(session);
  return summaryFromSnapshot({
    id: session.id,
    title: session.title,
    userId: session.userId,
    browserGroupId: session.browserGroupId,
    targetUrl: session.targetUrl,
    noVncUrl: browserChatNoVncUrl(session),
    mode: session.mode,
    safetyMode: normalizeSafetyMode(session.safetyMode),
    modelProvider: normalizeModelProvider(session.modelProvider),
    model: browserChatModelSettings(session.modelProvider, session.model).model,
    status: session.status,
    busy: session.busy,
    tabs: browserChatTabs(session),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    closedAt: session.closedAt,
    error: session.error,
    messages: [...session.messages],
    steps: [],
    consoleErrors: [],
    networkErrors: [],
    logs: [...(session.logs || [])],
    conversationContext: normalizeConversationContext(session.conversationContext),
    pendingToolConfirmation: normalizeToolConfirmation(session.pendingToolConfirmation),
  });
}

function isTransientBrowserChatProgress(value?: string) {
  const text = (value || '').trim();
  return text === 'AI is preparing the current browser state.'
    || text === 'AI is choosing the next browser action from the current page.';
}

function isRecentTimestamp(value?: string, maxAgeMs = runningHydrationGraceMs) {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) && Date.now() - timestamp < maxAgeMs;
}

function parseLogDetails(details?: string) {
  if (!details) return undefined;
  try {
    return JSON.parse(details) as unknown;
  } catch {
    return undefined;
  }
}

function runtimeResponseTextFromLog(log: BrowserChatLogRecord) {
  if (log.phase !== 'ai:runtime:response') return '';
  const details = parseLogDetails(log.details);
  if (details && typeof details === 'object') {
    const text = (details as { text?: unknown }).text;
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  const fallback = log.message
    .replace(/;\s*turn\s+\d+\/\d+;\s*AI\+tool[\s\S]*$/i, '')
    .trim();
  return /^AI returned no text/i.test(fallback) ? '' : fallback;
}

function recoverAssistantMessageFromLogs(
  message: BrowserChatMessage,
  logs: BrowserChatLogRecord[],
  steps: StepExecutionResult[],
) {
  if (message.role !== 'assistant' || message.status === 'running' || hasMessageContent(message)) return message;
  const responseLogs = logs.filter((log) => log.messageId === message.id && log.phase === 'ai:runtime:response');
  const recoveredLog = [...responseLogs].reverse().find((log) => runtimeResponseTextFromLog(log));
  if (!recoveredLog) return message;
  const hasCompletedRun = logs.some((log) => log.messageId === message.id && log.phase === 'chat:run:done');
  return {
    ...message,
    content: runtimeResponseTextFromLog(recoveredLog),
    status: hasCompletedRun ? statusFromSteps(steps) : message.status,
    updatedAt: message.updatedAt || recoveredLog.time,
  };
}

function hasRunningAssistantMessage(session: Pick<BrowserChatSessionSnapshot, 'messages'>, assistantMessageId?: string) {
  return (session.messages || []).some((message) => (
    message.role === 'assistant'
    && message.status === 'running'
    && (!assistantMessageId || message.id === assistantMessageId)
  ));
}

function latestRunningAssistantMessageId(session: Pick<BrowserChatSessionSnapshot, 'messages'>) {
  for (let index = (session.messages || []).length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message.role === 'assistant' && message.status === 'running') return message.id;
  }
  return undefined;
}

function recoveredStatusForStaleAssistantMessage(
  session: Pick<BrowserChatSessionRecord, 'steps'>,
  message: BrowserChatMessage,
): BrowserChatMessage['status'] {
  const linkedIndexes = new Set(message.stepIndexes || []);
  const linkedSteps = linkedIndexes.size
    ? session.steps.filter((step) => linkedIndexes.has(step.index))
    : [];
  const steps = linkedSteps.length ? linkedSteps : session.steps.slice(-1);
  if (steps.some((step) => step.status === 'blocked')) return 'blocked';
  if (steps.some((step) => step.status === 'failed')) return 'failed';
  if (steps.some((step) => step.status === 'passed')) return 'passed';
  return 'interrupted';
}

function finalizeIdleRunningAssistantMessages(session: BrowserChatSessionRecord) {
  if (session.busy || session.status === 'running') return false;
  let changed = false;
  session.messages = session.messages.map((message) => {
    if (message.role !== 'assistant' || message.status !== 'running') return message;
    changed = true;
    return {
      ...message,
      status: recoveredStatusForStaleAssistantMessage(session, message),
      activity: undefined,
    };
  });
  return changed;
}

function markAssistantMessageInterrupted(assistantMessageId?: string) {
  if (!assistantMessageId) return;
  interruptedAssistantMessageIds.add(assistantMessageId);
  if (interruptedAssistantMessageIds.size <= 500) return;
  const oldest = interruptedAssistantMessageIds.values().next().value;
  if (oldest) interruptedAssistantMessageIds.delete(oldest);
}

function shouldPreserveRuntimeTurn(existing: BrowserChatSessionRecord, fromDisk: BrowserChatSessionSnapshot) {
  const assistantMessageId = existing.activeAssistantMessageId;
  const abortController = existing.activeAbortController;
  if (!assistantMessageId || !abortController) return false;
  if (abortController.signal.aborted || interruptedAssistantMessageIds.has(assistantMessageId)) return false;
  if (!fromDisk.busy && fromDisk.status !== 'running' && !hasRunningAssistantMessage(fromDisk, assistantMessageId)) return false;
  return hasRunningAssistantMessage(fromDisk, assistantMessageId);
}

function recordFromSnapshot(session: BrowserChatSessionSnapshot, options: { preserveRunningState?: boolean } = {}): BrowserChatSessionRecord {
  const modelSettings = browserChatModelSettings(session.modelProvider, session.model);
  const preserveRecentRunningState = (session.busy || session.status === 'running' || options.preserveRunningState)
    && (options.preserveRunningState || isRecentTimestamp(session.updatedAt));
  const status = preserveRecentRunningState ? session.status : (session.status === 'running' ? 'idle' : session.status);
  const transientStepIndexes = new Set(
    (session.steps || [])
      .filter((step) => step.status === 'running' && isTransientBrowserChatProgress(step.actual))
      .map((step) => step.index),
  );
  const steps = (session.steps || []).filter((step) => !transientStepIndexes.has(step.index));
  const messages = (session.messages || []).map((rawMessage) => {
    const safeMessage: BrowserChatMessage = {
      ...rawMessage,
      role: rawMessage.role === 'assistant' ? 'assistant' : 'user',
      content: textFromUnknown(rawMessage.content),
      attachments: Array.isArray(rawMessage.attachments) ? rawMessage.attachments : [],
      stepIndexes: Array.isArray(rawMessage.stepIndexes) ? rawMessage.stepIndexes : [],
    };
    const message = recoverAssistantMessageFromLogs(safeMessage, session.logs || [], steps);
    const contentIsTransient = message.role === 'assistant' && isTransientBrowserChatProgress(message.content);
    const stepIndexes = transientStepIndexes.size
      ? (message.stepIndexes || []).filter((stepIndex) => !transientStepIndexes.has(stepIndex))
      : message.stepIndexes;
    if (preserveRecentRunningState && message.status === 'running') {
      return stepIndexes === message.stepIndexes ? message : { ...message, stepIndexes };
    }
    if (message.status !== 'running' && !contentIsTransient) {
      return stepIndexes === message.stepIndexes ? message : { ...message, stepIndexes };
    }
    return {
      ...message,
      content: contentIsTransient ? '本轮对话在准备页面状态时中断，未执行新的浏览器操作。' : message.content || '上次对话未完成，已恢复为空闲状态。',
      status: message.status === 'running' || contentIsTransient
        ? recoveredStatusForStaleAssistantMessage({ steps } as Pick<BrowserChatSessionRecord, 'steps'>, message)
        : message.status,
      activity: undefined,
      stepIndexes,
    };
  });
  return {
    ...session,
    tabs: session.tabs || [],
    targetUrl: exportableTargetUrl(session.targetUrl),
    safetyMode: normalizeSafetyMode(session.safetyMode),
    modelProvider: modelSettings.provider,
    model: modelSettings.model,
    messages,
    steps,
    conversationContext: normalizeConversationContext(session.conversationContext),
    pendingToolConfirmation: preserveRecentRunningState ? normalizeToolConfirmation(session.pendingToolConfirmation) : undefined,
    status,
    busy: preserveRecentRunningState ? session.busy : false,
    logs: session.logs || [],
    started: false,
    browser: undefined,
  };
}

function appendLog(
  session: BrowserChatSessionRecord,
  phase: string,
  message: string,
  input: { stepIndex?: number; elapsedMs?: number; details?: unknown; messageId?: string | null; deferPersist?: boolean } = {},
) {
  const timestamp = now();
  const runningActivity = runningActivityFromLog(phase, message);
  const details = logDetailsFromUnknown(input.details);
  const logMessageId = input.messageId === null ? undefined : input.messageId ?? session.activeAssistantMessageId;
  session.logs = trimBrowserChatLogs([
    ...(session.logs || []),
    {
      id: id('log'),
      time: timestamp,
      phase,
      message,
      details,
      messageId: logMessageId,
      stepIndex: input.stepIndex,
      elapsedMs: input.elapsedMs,
    },
  ]);
  if (logMessageId && logMessageId === session.activeAssistantMessageId) {
    updateAssistantMessage(session, logMessageId, (item) => ({
      ...item,
      activity: item.status === 'running' && runningActivity
        ? { phase, label: runningActivity, updatedAt: timestamp }
        : item.activity,
      stepIndexes: input.stepIndex
        ? Array.from(new Set([...(item.stepIndexes || []), input.stepIndex])).sort((a, b) => a - b)
        : item.stepIndexes,
      updatedAt: timestamp,
    }));
  }
  session.updatedAt = timestamp;
  persistAndNotify(session.id, { defer: input.deferPersist === true });
}

function readSessionSummariesFromFile(): BrowserChatSessionSnapshot[] {
  const summaries = new Map<string, BrowserChatSessionSnapshot>();
  if (existsSync(sessionSummariesDir)) {
    for (const entry of readdirSync(sessionSummariesDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const item = readSessionSnapshotFromFilePath(path.join(sessionSummariesDir, entry.name));
      if (item) summaries.set(item.id, item);
    }
  }
  if (!existsSync(sessionsDir)) return [...summaries.values()];
  for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const sessionId = entry.name.slice(0, -'.json'.length);
    if (summaries.has(sessionId)) continue;
    const item = readSessionSnapshotFromFilePath(path.join(sessionsDir, entry.name));
    if (!item) continue;
    const summary = summaryFromSnapshot(item);
    writeSessionSummaryToFile(summary);
    summaries.set(summary.id, summary);
  }
  return [...summaries.values()];
}

function isBrowserChatSessionSnapshot(value: unknown): value is BrowserChatSessionSnapshot {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { id?: unknown }).id === 'string';
}

function discardInterruptedTurn(session: BrowserChatSessionRecord, assistantMessageId?: string) {
  if (!assistantMessageId) return;
  const assistantIndex = session.messages.findIndex((message) => message.id === assistantMessageId);
  if (assistantIndex < 0) return;
  const assistantMessage = session.messages[assistantIndex];
  const previousMessage = session.messages[assistantIndex - 1];
  const discardedMessageIds = new Set([assistantMessageId]);
  if (previousMessage?.role === 'user') discardedMessageIds.add(previousMessage.id);
  const discardedStepIndexes = new Set(assistantMessage.stepIndexes || []);
  session.messages = session.messages.filter((message) => !discardedMessageIds.has(message.id));
  if (discardedStepIndexes.size) {
    session.steps = session.steps.filter((step) => !discardedStepIndexes.has(step.index));
  }
  session.logs = (session.logs || []).filter((log) => (
    log.messageId !== assistantMessageId
    && (!log.stepIndex || !discardedStepIndexes.has(log.stepIndex))
  ));
}

function isBrowserChatLogRecord(value: unknown): value is BrowserChatLogRecord {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { id?: unknown }).id === 'string'
    && typeof (value as { time?: unknown }).time === 'string'
    && typeof (value as { phase?: unknown }).phase === 'string'
    && typeof (value as { message?: unknown }).message === 'string';
}

function readSessionLogRecords(sessionId: string) {
  const filePath = browserChatSessionLogFilePath(sessionId);
  if (!existsSync(filePath)) return [] as BrowserChatLogRecord[];
  const stat = statSync(filePath);
  const cached = sessionLogFileCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.logs;
  const logs = readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const item = JSON.parse(line) as unknown;
        return isBrowserChatLogRecord(item) ? [item] : [];
      } catch {
        return [];
      }
    });
  sessionLogFileCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, logs });
  return logs;
}

function logRecordKey(item: BrowserChatLogRecord) {
  return item.id || [item.time, item.phase, item.message, item.stepIndex || ''].join('|');
}

function writeSessionLogRecords(sessionId: string, incoming: BrowserChatLogRecord[]) {
  const filePath = browserChatSessionLogFilePath(sessionId);
  const existing = readSessionLogRecords(sessionId);
  const known = new Set(existing.map(logRecordKey));
  const additions = incoming.filter((item) => !known.has(logRecordKey(item)));
  const merged = additions.length
    ? [...existing, ...additions].sort((a, b) => timestampValue(a.time) - timestampValue(b.time))
    : existing;
  const shouldCompact = merged.length > browserChatLogStorageLimit();
  const next = shouldCompact ? trimBrowserChatLogs(merged) : merged;
  if (!existsSync(filePath) || shouldCompact) {
    const content = next.map((item) => stringifyJsonSafe(item)).filter(Boolean).join('\n');
    writeTextFileAtomic(filePath, content ? `${content}\n` : '');
  } else if (additions.length) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const content = additions.map((item) => stringifyJsonSafe(item)).filter(Boolean).join('\n');
    if (content) appendFileSync(filePath, `${content}\n`, 'utf8');
  }
  if (existsSync(filePath)) {
    const stat = statSync(filePath);
    sessionLogFileCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, logs: next });
  }
  return trimBrowserChatLogs(next);
}

function withPersistedLogs(snapshot: BrowserChatSessionSnapshot) {
  const persistedLogs = readSessionLogRecords(snapshot.id);
  return persistedLogs.length
    ? { ...snapshot, logs: trimBrowserChatLogs(persistedLogs) }
    : snapshot;
}

function readSessionSnapshotFromFilePath(filePath: string) {
  const stat = statSync(filePath);
  const cached = sessionFileCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return withPersistedLogs(cached.snapshot);
  const data = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  if (!isBrowserChatSessionSnapshot(data)) return undefined;
  sessionFileCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, snapshot: data });
  return withPersistedLogs(data);
}

function readSessionSnapshotFromFile(sessionId: string) {
  const filePath = browserChatSessionFilePath(sessionId);
  if (!existsSync(filePath)) return undefined;
  return readSessionSnapshotFromFilePath(filePath);
}

function writeSessionSnapshotToFile(item: BrowserChatSessionSnapshot) {
  const logs = writeSessionLogRecords(item.id, item.logs);
  const durableSnapshot = { ...item, logs: [] };
  const payload = stringifyJsonSafe(durableSnapshot, 2);
  if (!payload) throw new Error(`Browser chat session ${item.id} could not be serialized.`);
  const filePath = browserChatSessionFilePath(item.id);
  writeTextFileAtomic(filePath, payload);
  const stat = statSync(filePath);
  sessionFileCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, snapshot: durableSnapshot });
  writeSessionSummaryToFile(summaryFromSnapshot({ ...item, logs }));
}

function writeSessionSummaryToFile(item: BrowserChatSessionSnapshot) {
  const payload = stringifyJsonSafe(item, 2);
  if (!payload) throw new Error(`Browser chat session summary ${item.id} could not be serialized.`);
  const filePath = browserChatSessionSummaryFilePath(item.id);
  writeTextFileAtomic(filePath, payload);
  const stat = statSync(filePath);
  sessionFileCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, snapshot: item });
}

function deleteSessionSnapshotFile(sessionId: string) {
  const sessionPath = browserChatSessionFilePath(sessionId);
  const summaryPath = browserChatSessionSummaryFilePath(sessionId);
  const logPath = browserChatSessionLogFilePath(sessionId);
  rmSync(sessionPath, { force: true });
  rmSync(summaryPath, { force: true });
  rmSync(logPath, { force: true });
  sessionFileCache.delete(sessionPath);
  sessionFileCache.delete(summaryPath);
  sessionLogFileCache.delete(logPath);
}

function timestampValue(value?: string) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function messageTimestamp(message: BrowserChatMessage) {
  return Math.max(timestampValue(message.updatedAt), timestampValue(message.createdAt));
}

function hasMessageContent(message: BrowserChatMessage) {
  return Boolean(textFromUnknown(message.content).trim());
}

function shouldPreferIncomingMessage(previous: BrowserChatMessage, incoming: BrowserChatMessage) {
  const previousHasContent = hasMessageContent(previous);
  const incomingHasContent = hasMessageContent(incoming);
  if (incomingHasContent && !previousHasContent) return true;
  if (!incomingHasContent && previousHasContent) return false;
  if (incoming.status !== 'running' && previous.status === 'running') return true;
  if (incoming.status === 'running' && previous.status !== 'running') return false;
  return messageTimestamp(incoming) >= messageTimestamp(previous);
}

function mergeSortedNumbers(first?: number[], second?: number[]) {
  return Array.from(new Set([...(first || []), ...(second || [])])).sort((a, b) => a - b);
}

function mergeStringLists(first?: string[], second?: string[]) {
  return Array.from(new Set([...(first || []), ...(second || [])].filter(Boolean)));
}

function mergeMessagesFromFile(existing: BrowserChatMessage[] = [], incoming: BrowserChatMessage[] = []) {
  const byId = new Map<string, BrowserChatMessage>();
  for (const message of existing) byId.set(message.id, message);
  for (const message of incoming) {
    const previous = byId.get(message.id);
    if (!previous) {
      byId.set(message.id, message);
      continue;
    }
    const incomingPreferred = shouldPreferIncomingMessage(previous, message);
    const merged = incomingPreferred ? { ...previous, ...message } : { ...message, ...previous };
    byId.set(message.id, {
      ...merged,
      stepIndexes: mergeSortedNumbers(previous.stepIndexes, message.stepIndexes),
      attachments: incomingPreferred ? message.attachments || previous.attachments : previous.attachments || message.attachments,
    });
  }
  return [...byId.values()].sort((a, b) => messageTimestamp(a) - messageTimestamp(b));
}

function stepCompletenessScore(step: StepExecutionResult) {
  let score = 0;
  score += (step.tools?.length || 0) * 20;
  if (step.aiRequest) score += 8;
  if (step.beforeScreenshotPath) score += 4;
  if (step.afterScreenshotPath) score += 4;
  if (step.screenshotPath) score += 2;
  if (step.visualContext) score += 2;
  if (step.workingMemory) score += 2;
  if (step.status && step.status !== 'running') score += 10;
  return score;
}

function mergeStepFromFile(existing: StepExecutionResult, incoming: StepExecutionResult) {
  if (existing.status !== 'running' && incoming.status === 'running') return existing;
  if (incoming.status !== 'running' && existing.status === 'running') return incoming;
  return stepCompletenessScore(incoming) >= stepCompletenessScore(existing)
    ? { ...existing, ...incoming }
    : { ...incoming, ...existing };
}

function mergeStepsFromFile(existing: StepExecutionResult[] = [], incoming: StepExecutionResult[] = []) {
  const byIndex = new Map<number, StepExecutionResult>();
  for (const step of existing) byIndex.set(step.index, step);
  for (const step of incoming) {
    const previous = byIndex.get(step.index);
    byIndex.set(step.index, previous ? mergeStepFromFile(previous, step) : step);
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

function mergeLogsFromFile(existing: BrowserChatLogRecord[] = [], incoming: BrowserChatLogRecord[] = []) {
  const byKey = new Map<string, BrowserChatLogRecord>();
  const keyOf = (item: BrowserChatLogRecord) => item.id || [item.time, item.phase, item.message, item.stepIndex || ''].join('|');
  for (const item of existing) byKey.set(keyOf(item), item);
  for (const item of incoming) byKey.set(keyOf(item), item);
  return [...byKey.values()]
    .sort((a, b) => timestampValue(a.time) - timestampValue(b.time))
    .slice(-browserChatLogLimit());
}

function mergeConversationContextFromFile(
  existing?: BrowserChatConversationContext,
  incoming?: BrowserChatConversationContext,
) {
  if (!existing) return normalizeConversationContext(incoming);
  if (!incoming) return normalizeConversationContext(existing);
  return timestampValue(incoming.updatedAt) >= timestampValue(existing.updatedAt)
    ? normalizeConversationContext(incoming)
    : normalizeConversationContext(existing);
}

function mergeSessionSnapshotFromFile(
  existing: BrowserChatSessionSnapshot | undefined,
  incoming: BrowserChatSessionSnapshot,
): BrowserChatSessionSnapshot {
  if (!existing) return incoming;
  const incomingNewer = timestampValue(incoming.updatedAt) >= timestampValue(existing.updatedAt);
  const base = incomingNewer ? { ...existing, ...incoming } : { ...incoming, ...existing };
  return {
    ...base,
    messages: mergeMessagesFromFile(existing.messages, incoming.messages),
    steps: mergeStepsFromFile(existing.steps, incoming.steps),
    consoleErrors: mergeStringLists(existing.consoleErrors, incoming.consoleErrors),
    networkErrors: mergeStringLists(existing.networkErrors, incoming.networkErrors),
    logs: mergeLogsFromFile(existing.logs, incoming.logs),
    conversationContext: mergeConversationContextFromFile(existing.conversationContext, incoming.conversationContext),
  };
}

function mergeRuntimeSessionState(fromDisk: BrowserChatSessionRecord, existing: BrowserChatSessionRecord) {
  const hasRuntimeTurn = Boolean(
    existing.activeAssistantMessageId
    || existing.activeAbortController
    || existing.busy
    || existing.status === 'running',
  );
  if (!hasRuntimeTurn) return fromDisk;
  return {
    ...fromDisk,
    messages: mergeMessagesFromFile(fromDisk.messages, existing.messages),
    steps: mergeStepsFromFile(fromDisk.steps, existing.steps),
    consoleErrors: mergeStringLists(fromDisk.consoleErrors, existing.consoleErrors),
    networkErrors: mergeStringLists(fromDisk.networkErrors, existing.networkErrors),
    logs: mergeLogsFromFile(fromDisk.logs, existing.logs),
    conversationContext: mergeConversationContextFromFile(fromDisk.conversationContext, existing.conversationContext),
    pendingToolConfirmation: existing.pendingToolConfirmation || fromDisk.pendingToolConfirmation,
  };
}

function applyFileSnapshotToRuntime(snapshotFromFile: BrowserChatSessionSnapshot) {
  const existing = sessions.get(snapshotFromFile.id);
  if (!existing) {
    sessions.set(snapshotFromFile.id, recordFromSnapshot(snapshotFromFile));
    return;
  }
  const preserveRuntimeTurn = shouldPreserveRuntimeTurn(existing, snapshotFromFile);
  const fromDisk = mergeRuntimeSessionState(
    recordFromSnapshot(snapshotFromFile, { preserveRunningState: preserveRuntimeTurn }),
    existing,
  );
  const runtimeState = {
    activeAbortController: preserveRuntimeTurn ? existing.activeAbortController : undefined,
    activeAssistantMessageId: preserveRuntimeTurn ? existing.activeAssistantMessageId : undefined,
    browser: existing.browser,
    started: existing.started,
  };
  Object.assign(existing, fromDisk, runtimeState);
}

function hydrateSession(sessionId: string) {
  const fromDisk = readSessionSnapshotFromFile(sessionId);
  if (fromDisk) applyFileSnapshotToRuntime(fromDisk);
  return sessions.get(sessionId);
}

function persistSessionToFile(sessionId: string, options: { mergeFromDisk?: boolean } = {}) {
  try {
    const currentSession = sessions.get(sessionId);
    const incoming = currentSession ? snapshot(currentSession, { fullSteps: true }) : undefined;
    if (!incoming) {
      deleteSessionSnapshotFile(sessionId);
      return true;
    }
    const writtenSnapshot = options.mergeFromDisk === false
      ? incoming
      : mergeSessionSnapshotFromFile(readSessionSnapshotFromFile(sessionId), incoming);
    writeSessionSnapshotToFile(writtenSnapshot);
    if (options.mergeFromDisk !== false) applyFileSnapshotToRuntime(writtenSnapshot);
    return true;
  } catch (error) {
    warnPersistFailure(error);
    return false;
  }
}

function clearPendingPersist(sessionId: string) {
  const timer = pendingPersistTimers.get(sessionId);
  if (!timer) return;
  clearTimeout(timer);
  pendingPersistTimers.delete(sessionId);
}

function schedulePersistAndNotify(sessionId: string) {
  if (pendingPersistTimers.has(sessionId)) return;
  const timer = setTimeout(() => {
    pendingPersistTimers.delete(sessionId);
    persistAndNotify(sessionId, { mergeFromDisk: false });
  }, browserChatProgressPersistDelayMs());
  pendingPersistTimers.set(sessionId, timer);
}

function persistAndNotify(sessionId: string, options: { defer?: boolean; mergeFromDisk?: boolean } = {}) {
  if (options.defer) {
    schedulePersistAndNotify(sessionId);
    notifySessionUpdate(sessionId);
    return true;
  }
  clearPendingPersist(sessionId);
  const persisted = persistSessionToFile(sessionId, { mergeFromDisk: options.mergeFromDisk });
  if (!persisted) return false;
  notifySessionUpdate(sessionId);
  return true;
}

function persistDeletedSessionsToFile(sessionIds: string[]) {
  try {
    for (const sessionId of new Set(sessionIds.filter(Boolean))) {
      deleteSessionSnapshotFile(sessionId);
    }
    return true;
  } catch (error) {
    warnPersistFailure(error);
    return false;
  }
}

function orderedMessagesAfterCoveredContext(messages: BrowserChatMessage[], context?: BrowserChatConversationContext) {
  if (!context?.coveredMessageIds.length) return messages;
  const coveredIds = new Set(context.coveredMessageIds);
  const lastCoveredIndex = messages.reduce((latest, message, index) => (
    coveredIds.has(message.id) ? index : latest
  ), -1);
  return messages.slice(lastCoveredIndex + 1);
}

function conversationForPrompt(
  messages: BrowserChatMessage[],
  context?: BrowserChatConversationContext,
  currentUserMessageId?: string,
): InteractiveBrowserTurnMessage[] {
  const stableMessages = stableConversationMessages(messages)
    .filter((message) => message.id !== currentUserMessageId);
  const uncovered = orderedMessagesAfterCoveredContext(stableMessages, context);
  return [
    ...(context?.summary ? [{
      role: 'user' as const,
      content: `[历史会话总结]\n${context.summary}`,
    }] : []),
    ...uncovered.map((message) => ({ role: message.role, content: messageContentForPrompt(message) })),
  ];
}

async function ensureConversationContextWithinThreshold(
  session: BrowserChatSessionRecord,
  currentUserMessageId?: string,
  abortSignal?: AbortSignal,
) {
  const stableMessages = stableConversationMessages(session.messages);
  const currentUserIndex = currentUserMessageId ? stableMessages.findIndex((message) => message.id === currentUserMessageId) : -1;
  const historicalMessages = (currentUserIndex >= 0 ? stableMessages.slice(0, currentUserIndex) : stableMessages)
    .filter((message) => message.id !== session.activeAssistantMessageId);
  const currentConversation = conversationForPrompt(historicalMessages, session.conversationContext);
  const thresholdTokens = Math.floor(contextWindowTokens() * contextCompressionThresholdRatio());
  const estimatedTokens = browserChatConversationTokenEstimate(currentConversation);
  if (estimatedTokens <= thresholdTokens) return;

  const previousContext = normalizeConversationContext(session.conversationContext);
  const sourceMessages = orderedMessagesAfterCoveredContext(historicalMessages, previousContext);
  if (!previousContext?.summary && !sourceMessages.length) return;

  const prompt = buildConversationSummaryPrompt({
    previousContext,
    messages: sourceMessages,
    estimatedTokens,
    thresholdTokens,
  });
  const { provider, model } = getModelSettings();
  appendLog(session, 'conversation:context:request', '历史对话超过上下文阈值，正在压缩为后续模型上下文开头。', {
    details: fullLogDetails({
      provider,
      model,
      estimatedTokens,
      thresholdTokens,
      prompt,
    }),
  });
  const startedAt = Date.now();
  try {
    const timeoutMs = Math.max(1000, Number(process.env.AI_BROWSER_CHAT_CONTEXT_TIMEOUT_MS || process.env.AI_TEST_REQUEST_TIMEOUT_MS || 30000));
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(new Error(`AI conversation context summary timed out after ${timeoutMs}ms`)), timeoutMs);
    const combinedSignal = abortSignal ? AbortSignal.any([abortSignal, timeoutController.signal]) : timeoutController.signal;
    try {
      const result = await generateText({
        model: getModel(),
        temperature: 0.1,
        maxRetries: 0,
        prompt,
        abortSignal: combinedSignal,
      });
      const summary = compactText(result.text || '', 12000) || fallbackConversationSummary({ previousContext, messages: sourceMessages });
      session.conversationContext = {
        version: 1,
        updatedAt: now(),
        coveredMessageIds: historicalMessages.map((message) => message.id).slice(-300),
        summary,
      };
      appendLog(session, 'conversation:context:response', '历史对话已压缩，后续轮次会以该摘要作为 messages 开头。', {
        elapsedMs: elapsedMs(startedAt),
        details: fullLogDetails({
          provider,
          model,
          estimatedTokensBefore: estimatedTokens,
          estimatedTokensAfter: browserChatConversationTokenEstimate(conversationForPrompt(historicalMessages, session.conversationContext)),
          thresholdTokens,
          context: session.conversationContext,
        }),
      });
      persistAndNotify(session.id);
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    if (abortSignal?.aborted) throw abortSignal.reason || error;
    appendLog(session, 'conversation:context:error', '历史对话压缩失败，本轮继续使用未压缩历史。', {
      details: errorLogDetails(error),
    });
  }
}

function isDeadBrowserSessionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /Browser session has not started|Active browser page has been closed|Target page, context or browser has been closed|browser has been closed|page has been closed/i.test(message);
}

async function ensureStarted(session: BrowserChatSessionRecord) {
  const existing = browserStartPromises.get(session.id);
  if (existing) return existing;
  const startPromise = ensureStartedNow(session);
  browserStartPromises.set(session.id, startPromise);
  try {
    return await startPromise;
  } finally {
    if (browserStartPromises.get(session.id) === startPromise) browserStartPromises.delete(session.id);
  }
}

async function ensureStartedNow(session: BrowserChatSessionRecord) {
  if (session.started && session.browser) {
    if (session.browser.isUsable()) {
      appendLog(session, 'browser:reuse', '复用当前会话已有浏览器标签');
      return session.browser;
    }
    appendLog(session, 'browser:stale', '历史对话的浏览器已关闭或页面已失效，正在重新接管本会话。');
    await session.browser.close({ keepOpen: true }).catch(() => undefined);
    session.browser = undefined;
    session.started = false;
    session.updatedAt = now();
    persistAndNotify(session.id);
  }
  store.applyRuntimeEnv();
  const startedAt = Date.now();
  appendLog(session, 'browser:start', '正在启动或连接浏览器');
  const hasPriorConversation = session.steps.length > 0
    || session.messages.some((message) => message.role === 'assistant' && message.id !== session.activeAssistantMessageId);
  const browser = new BrowserSession(session.mode, {
    browserSurface: 'electron-embedded',
    browserProfileKey: browserChatBrowserProfileKey(session),
    isMarked: true,
    preferExistingPage: false,
    runId: session.id,
  });
  session.browser = browser;
  session.status = 'running';
  session.updatedAt = now();
  persistAndNotify(session.id);
  try {
    await browser.start();
  } catch (error) {
    await browser.close({ keepOpen: true }).catch(() => undefined);
    if (session.browser === browser) {
      session.browser = undefined;
      session.started = false;
      session.updatedAt = now();
      persistAndNotify(session.id);
    }
    throw error;
  }
  session.started = true;
  session.updatedAt = now();
  persistAndNotify(session.id);
  appendLog(session, 'browser:ready', `浏览器已就绪，用时 ${elapsedMs(startedAt)}ms`, { elapsedMs: elapsedMs(startedAt) });
  const url = exportableTargetUrl(session.targetUrl);
  if (session.targetUrl && !url) session.targetUrl = '';
  const currentUrl = browser.currentUrl();
  const shouldOpenTarget = Boolean(url && (!browser.hasNonBlankActivePage() || !hasPriorConversation));
  if (browser.hasNonBlankActivePage() && hasPriorConversation) {
    session.targetUrl = exportableTargetUrl(currentUrl) || url || session.targetUrl;
    appendLog(session, 'browser:reuse-page', `复用当前非空标签页：${session.targetUrl || '[unknown URL]'}`);
  } else if (shouldOpenTarget) {
    const openStartedAt = Date.now();
    session.targetUrl = url;
    appendLog(session, 'browser:open', `正在打开目标地址：${url}`);
    await browser.open(url);
    appendLog(session, 'browser:url-ready', `目标地址已打开，用时 ${elapsedMs(openStartedAt)}ms`, { elapsedMs: elapsedMs(openStartedAt) });
  } else if (url) {
    session.targetUrl = url;
  }
  session.status = 'idle';
  session.updatedAt = now();
  persistAndNotify(session.id);
  return browser;
}

function warmBrowserChatSession(session: BrowserChatSessionRecord) {
  if (session.status === 'closed' || (session.started && session.browser?.isUsable())) return;
  void ensureStarted(session).catch((error) => {
    if (session.status === 'closed' || session.busy) return;
    session.status = 'idle';
    session.error = undefined;
    session.updatedAt = now();
    appendLog(session, 'browser:warm:error', '常驻测试浏览器预热失败；发送消息时将自动重试。', {
      details: errorLogDetails(error),
    });
    persistAndNotify(session.id);
  });
}

export function createBrowserChatSession(input: {
  targetUrl?: string;
  mode?: BrowserSessionMode;
  safetyMode?: BrowserChatSafetyMode;
  modelProvider?: unknown;
  model?: unknown;
  title?: string;
  userId?: string | number;
} = {}) {
  store.applyRuntimeEnv();
  const modelSettings = browserChatModelSettings(input.modelProvider, input.model);
  const timestamp = now();
  const session: BrowserChatSessionRecord = {
    id: id('chat'),
    title: input.title?.trim() || '浏览器对话操作',
    userId: normalizeUserId(input.userId) || undefined,
    browserGroupId: '',
    targetUrl: exportableTargetUrl(input.targetUrl || ''),
    mode: 'dom',
    safetyMode: normalizeSafetyMode(input.safetyMode),
    modelProvider: modelSettings.provider,
    model: modelSettings.model,
    status: 'idle',
    busy: false,
    tabs: [],
    started: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: [],
    steps: [],
    consoleErrors: [],
    networkErrors: [],
    logs: [],
  };
  session.browserGroupId = `session:${session.id}`;
  sessions.set(session.id, session);
  persistAndNotify(session.id);
  warmBrowserChatSession(session);
  return snapshot(session);
}

export function getBrowserChatSession(sessionId: string, userId?: string | number) {
  const session = hydrateSession(sessionId);
  if (session && !sessionBelongsToUser(session, userId)) return undefined;
  if (session) warmBrowserChatSession(session);
  return session ? snapshot(session) : undefined;
}

export function setBrowserChatSessionGroup(sessionId: string, groupId: string, userId?: string | number) {
  const session = hydrateSession(sessionId);
  if (!session || !sessionBelongsToUser(session, userId)) return undefined;
  const normalized = groupId.trim();
  if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(normalized)) throw new Error('Invalid browser group id');
  session.browserGroupId = normalized;
  session.updatedAt = now();
  persistAndNotify(session.id);
  return snapshot(session);
}

export function getBrowserChatSessionLogs(sessionId: string, userId?: string | number) {
  const session = hydrateSession(sessionId);
  if (!session || !sessionBelongsToUser(session, userId)) return undefined;
  return [...(session.logs || [])];
}

export function listBrowserChatSessions(input: { userId?: string | number } = {}) {
  const summaries = new Map(readSessionSummariesFromFile().map((session) => [session.id, session]));
  for (const session of sessions.values()) summaries.set(session.id, summarySnapshot(session));
  return [...summaries.values()]
    .filter((session) => sessionBelongsToUser(session, input.userId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function closeBrowserChatSession(sessionId: string, userId?: string | number) {
  const session = hydrateSession(sessionId);
  if (!session) return undefined;
  if (!sessionBelongsToUser(session, userId)) return undefined;
  if (session.activeAbortController && !session.activeAbortController.signal.aborted) {
    session.activeAbortController.abort(new Error('Browser chat session closed by user.'));
  }
  cancelPendingToolConfirmation(session);
  await session.browser?.close({ keepOpen: true }).catch(() => undefined);
  session.browser = undefined;
  session.started = false;
  session.activeAbortController = undefined;
  session.activeAssistantMessageId = undefined;
  session.pendingToolConfirmation = undefined;
  session.busy = false;
  session.status = 'closed';
  session.closedAt = now();
  session.updatedAt = session.closedAt;
  persistAndNotify(session.id);
  return snapshot(session);
}

export async function deleteBrowserChatSession(sessionId: string, userId?: string | number) {
  const session = hydrateSession(sessionId);
  if (session && !sessionBelongsToUser(session, userId)) return undefined;
  const removed = await deleteBrowserChatSessionFromMemory(sessionId);
  if (!removed) return undefined;
  if (!persistAndNotify(sessionId)) {
    sessions.set(sessionId, removed.session);
    throw new Error('Browser chat session was removed from memory, but the session file could not be updated.');
  }
  return removed.deleted;
}

export async function switchBrowserChatTab(sessionId: string, index: number, userId?: string | number) {
  const session = hydrateSession(sessionId);
  if (!session || session.status === 'closed') return undefined;
  if (!sessionBelongsToUser(session, userId)) return undefined;
  const normalizedIndex = Math.floor(Number(index));
  if (!Number.isInteger(normalizedIndex) || normalizedIndex < 0) {
    throw new Error('Invalid tab index');
  }

  if (!session.started || !session.browser || !session.browser.isUsable()) {
    throw new Error('当前会话还没有运行中的浏览器，无法切换标签页。');
  }
  const browser = session.browser;
  const result = await browser.switchTab(normalizedIndex);
  if (!result?.ok) {
    throw new Error(`Switch tab failed: ${result?.actual || 'Unknown error'}`);
  }

  session.updatedAt = now();
  session.error = undefined;
  if (!session.busy) {
    session.status = 'idle';
  }
  persistAndNotify(session.id);
  return snapshot(session);
}

export async function startBrowserChatScreencast(
  sessionId: string,
  userId: string | number | undefined,
  handlers: {
    onActivePageChanged?: () => void;
    onError?: (error: unknown) => void;
    onFrame: (frame: BrowserScreencastFrame) => void | Promise<void>;
  },
) {
  const session = hydrateSession(sessionId);
  if (!session || session.status === 'closed') return undefined;
  if (!sessionBelongsToUser(session, userId)) return undefined;

  if (!session.started || !session.browser || !session.browser.isUsable()) {
    throw new Error('当前会话还没有运行中的浏览器；请先发送AI访问请求，浏览器启动后会自动显示画面。');
  }
  const browser = session.browser;
  return browser.startScreencast({
    onActivePageChanged: handlers.onActivePageChanged,
    onError: handlers.onError,
    onFrame: (frame) => {
      session.tabs = frame.tabs;
      session.targetUrl = exportableTargetUrl(frame.url) || session.targetUrl;
      return handlers.onFrame(frame);
    },
  });
}

async function deleteBrowserChatSessionFromMemory(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  if (session.activeAbortController && !session.activeAbortController.signal.aborted) {
    session.activeAbortController.abort(new Error('Browser chat session deleted by user.'));
  }
  cancelPendingToolConfirmation(session);
  await session.browser?.close({ keepOpen: true }).catch(() => undefined);
  session.browser = undefined;
  session.started = false;
  session.activeAbortController = undefined;
  session.activeAssistantMessageId = undefined;
  session.pendingToolConfirmation = undefined;
  sessions.delete(sessionId);
  return { deleted: { id: sessionId }, session };
}

export async function deleteBrowserChatSessions(sessionIds: string[], userId?: string | number) {
  const uniqueIds = Array.from(new Set(sessionIds.map((item) => item.trim()).filter(Boolean)));
  const deleted: Array<{ id: string }> = [];
  const removed: Array<{ deleted: { id: string }; session: BrowserChatSessionRecord }> = [];
  for (const sessionId of uniqueIds) {
    const session = hydrateSession(sessionId);
    if (session && !sessionBelongsToUser(session, userId)) continue;
    const result = await deleteBrowserChatSessionFromMemory(sessionId);
    if (result) {
      removed.push(result);
      deleted.push(result.deleted);
    }
  }
  if (removed.length) {
    const persisted = persistDeletedSessionsToFile(removed.map((item) => item.deleted.id));
    if (!persisted) {
      for (const item of removed) sessions.set(item.deleted.id, item.session);
      throw new Error('Browser chat sessions were removed from memory, but the session file could not be updated.');
    }
    for (const item of removed) notifySessionUpdate(item.deleted.id);
  }
  return { deleted, requested: uniqueIds.length };
}

type BrowserChatStepToolCall = NonNullable<StepExecutionResult['tools']>[number];

function isRecoveredTransientStepTool(tool: BrowserChatStepToolCall | undefined) {
  return tool?.recovered === true && tool.transient === true;
}

function firstPersistentStepTool(step: StepExecutionResult) {
  return step.tools?.find((tool) => !isRecoveredTransientStepTool(tool));
}

export function exportBrowserChatMessageToTestCase(sessionId: string, messageId: string) {
  const session = hydrateSession(sessionId);
  if (!session) throw new Error('Browser chat session not found');
  const messageIndex = session.messages.findIndex((message) => message.id === messageId && message.role === 'assistant');
  if (messageIndex < 0) throw new Error('Browser chat assistant message not found');
  const message = session.messages[messageIndex];
  const previousUser = [...session.messages.slice(0, messageIndex)].reverse().find((item) => item.role === 'user');
  const selectedStepIndexes = new Set(message.stepIndexes || []);
  const selectedSteps = session.steps
    .filter((step) => selectedStepIndexes.size ? selectedStepIndexes.has(step.index) : step.index > 0)
    .map((step) => ({ ...step, status: step.status === 'running' ? 'passed' : step.status }))
    .sort((a, b) => a.index - b.index);
  if (!selectedSteps.length) throw new Error('No executed browser steps found for this message');
  const targetUrl = exportedTargetUrl(session, selectedSteps);

  const recordedFlow: RecordedFlowStep[] = selectedSteps.flatMap((step) => (step.tools || []).flatMap((tool, toolIndex) => (
    isRecoveredTransientStepTool(tool) ? [] : [{
    index: 0,
    name: tool.name,
    input: exportedRecordedToolInput(tool.name, tool.input, targetUrl),
    reason: tool.reason,
    sourceStepIndex: step.index,
    sourceStepAction: step.action,
    sourceStepExpected: step.expected,
    sourceToolIndex: toolIndex + 1,
  }]))).map((flow, index) => ({ ...flow, index: index + 1 }));

  const titleSeed = previousUser?.content || message.content || '浏览器对话导出用例';
  const content: TestCaseContent = {
    title: `对话导出 - ${compactText(titleSeed, 36)}`,
    description: [
      previousUser ? `用户消息：${previousUser.content}` : '',
      `AI 输出：${message.content}`,
    ].filter(Boolean).join('\n\n'),
    targetUrl,
    priority: 'medium',
    browserMode: session.mode,
    isMarked: true,
    userRequirement: previousUser?.content || message.content,
    systemPrompt: '该用例由浏览器对话导出，已包含对话中 AI 实际执行过的步骤记录。',
    preconditions: ['已根据浏览器对话完成过一次执行，导出时同步创建一条已完成运行记录。'],
    testData: {},
    steps: selectedSteps.map((step, index) => {
      const firstTool = firstPersistentStepTool(step);
      return {
        index: index + 1,
        operation: testOperationFromToolName(firstTool?.name),
        action: compactText(step.action || firstTool?.name || `执行步骤 ${step.index}`, 240),
        input: firstTool?.input ? safeJson(firstTool.input) : undefined,
        expected: compactText(step.expected || step.actual || '该步骤应按对话中的已执行结果完成。', 320),
        riskLevel: step.status === 'failed' ? 'warning' : 'safe',
      };
    }),
    expectedResults: [message.content || '复现对话中 AI 已完成的浏览器操作。'],
    risks: session.networkErrors.length || session.consoleErrors.length
      ? ['原对话执行过程中存在控制台或网络诊断记录，复跑时需要关注稳定性。']
      : [],
    recordedFlow: recordedFlow.length ? recordedFlow : undefined,
  };

  const testCase = store.createTestCase(content, []);
  const run = store.createRun(testCase.id);
  const finishedAt = now();
  const status = statusFromSteps(selectedSteps);
  const completedRun = store.updateRun(run.id, {
    status,
    startedAt: message.createdAt || session.createdAt,
    endedAt: finishedAt,
    result: {
      steps: selectedSteps,
      consoleErrors: session.consoleErrors,
      networkErrors: session.networkErrors,
      taskFrame: selectedSteps.at(-1)?.taskFrame,
      ledgerItems: selectedSteps.flatMap((step) => step.ledgerItems || []),
    },
  }) || run;
  store.updateTestCaseStatus(testCase.id, status === 'passed' ? 'passed' : status);
  return { testCase: store.getTestCase(testCase.id) || testCase, run: completedRun };
}

export function exportBrowserChatMessagesToTestCase(sessionId: string, messageIds: string[]) {
  const session = hydrateSession(sessionId);
  if (!session) throw new Error('Browser chat session not found');
  const uniqueMessageIds = Array.from(new Set(messageIds.map((item) => item.trim()).filter(Boolean)));
  if (!uniqueMessageIds.length) throw new Error('请选择要导出的对话轮次');

  const selectedIdSet = new Set(uniqueMessageIds);
  const selectedMessages = session.messages
    .map((message, index) => ({ message, index }))
    .filter((item) => selectedIdSet.has(item.message.id) && item.message.role === 'assistant');
  if (!selectedMessages.length) throw new Error('请选择可导出的 AI 回复消息');

  const selectedStepIndexSet = new Set<number>();
  for (const { message } of selectedMessages) {
    for (const stepIndex of message.stepIndexes || []) selectedStepIndexSet.add(stepIndex);
  }

  const rawSteps = session.steps
    .filter((step) => selectedStepIndexSet.size ? selectedStepIndexSet.has(step.index) : step.index > 0)
    .map((step) => ({ ...step, status: step.status === 'running' ? 'passed' : step.status }))
    .sort((a, b) => a.index - b.index);
  if (!rawSteps.length) throw new Error('选中的对话轮次没有可导出的执行步骤');

  const selectedSteps = rawSteps.map((step, index): StepExecutionResult => ({
    ...step,
    index: index + 1,
  }));
  const targetUrl = exportedTargetUrl(session, selectedSteps);
  const recordedFlow: RecordedFlowStep[] = selectedSteps.flatMap((step) => (step.tools || []).flatMap((tool, toolIndex) => (
    isRecoveredTransientStepTool(tool) ? [] : [{
    index: 0,
    name: tool.name,
    input: exportedRecordedToolInput(tool.name, tool.input, targetUrl),
    reason: tool.reason,
    sourceStepIndex: step.index,
    sourceStepAction: step.action,
    sourceStepExpected: step.expected,
    sourceToolIndex: toolIndex + 1,
  }]))).map((flow, index) => ({ ...flow, index: index + 1 }));

  const turnDescriptions = selectedMessages.map(({ message, index }, turnIndex) => {
    const previousUser = [...session.messages.slice(0, index)].reverse().find((item) => item.role === 'user');
    return [
      `轮次 ${turnIndex + 1}`,
      previousUser?.content ? `用户消息：${previousUser.content}` : '',
      message.content ? `AI 输出：${message.content}` : '',
    ].filter(Boolean).join('\n');
  });
  const selectedUserGoals = Array.from(new Set(selectedMessages
    .map(({ index }) => [...session.messages.slice(0, index)].reverse().find((item) => item.role === 'user')?.content?.trim())
    .filter((item): item is string => Boolean(item))));
  const firstSelected = selectedMessages[0];
  const firstPreviousUser = firstSelected
    ? [...session.messages.slice(0, firstSelected.index)].reverse().find((item) => item.role === 'user')
    : undefined;
  const titleSeed = firstPreviousUser?.content || firstSelected?.message.content || session.title || '浏览器对话导出用例';
  const expectedResults = selectedMessages
    .map((item) => item.message.content)
    .filter((item): item is string => Boolean(item?.trim()))
    .map((item) => compactText(item, 420));
  const content: TestCaseContent = {
    title: `对话导出 - ${compactText(titleSeed, 36)}`,
    description: turnDescriptions.join('\n\n'),
    targetUrl,
    priority: 'medium',
    browserMode: session.mode,
    isMarked: true,
    userRequirement: selectedUserGoals.join('\n') || titleSeed,
    systemPrompt: '该用例由浏览器对话中的多轮消息导出，已包含所选轮次中 AI 实际执行过的步骤记录。',
    preconditions: ['已根据所选浏览器对话轮次完成过执行，导出时同步创建一条已完成运行记录。'],
    testData: {},
    steps: selectedSteps.map((step, index) => {
      const firstTool = firstPersistentStepTool(step);
      return {
        index: index + 1,
        operation: testOperationFromToolName(firstTool?.name),
        action: compactText(step.action || firstTool?.name || `执行步骤 ${step.index}`, 240),
        input: firstTool?.input ? safeJson(firstTool.input) : undefined,
        expected: compactText(step.expected || step.actual || '该步骤应按对话中的已执行结果完成。', 320),
        riskLevel: step.status === 'failed' ? 'warning' : 'safe',
      };
    }),
    expectedResults: expectedResults.length ? expectedResults : ['复现选中对话轮次中 AI 已完成的浏览器操作。'],
    risks: session.networkErrors.length || session.consoleErrors.length
      ? ['原对话执行过程中存在控制台或网络诊断记录，复跑时需要关注稳定性。']
      : [],
    recordedFlow: recordedFlow.length ? recordedFlow : undefined,
  };

  const testCase = store.createTestCase(content, []);
  const run = store.createRun(testCase.id);
  const finishedAt = now();
  const status = statusFromSteps(selectedSteps);
  const completedRun = store.updateRun(run.id, {
    status,
    startedAt: selectedMessages[0]?.message.createdAt || session.createdAt,
    endedAt: finishedAt,
    result: {
      steps: selectedSteps,
      consoleErrors: session.consoleErrors,
      networkErrors: session.networkErrors,
      taskFrame: selectedSteps.at(-1)?.taskFrame,
      ledgerItems: selectedSteps.flatMap((step) => step.ledgerItems || []),
    },
  }) || run;
  store.updateTestCaseStatus(testCase.id, status === 'passed' ? 'passed' : status);
  return { testCase: store.getTestCase(testCase.id) || testCase, run: completedRun, exportedMessageIds: uniqueMessageIds };
}

export async function generateBrowserChatMessagesSkill(sessionId: string, messageIds: string[]) {
  const session = hydrateSession(sessionId);
  if (!session) throw new Error('Browser chat session not found');
  const uniqueMessageIds = Array.from(new Set(messageIds.map((item) => item.trim()).filter(Boolean)));
  if (!uniqueMessageIds.length) throw new Error('请选择要生成 Skill 的对话轮次');

  const selectedIdSet = new Set(uniqueMessageIds);
  const selectedMessages = session.messages
    .map((message, index) => ({ message, index }))
    .filter((item) => selectedIdSet.has(item.message.id) && item.message.role === 'assistant');
  if (!selectedMessages.length) throw new Error('请选择可生成 Skill 的 AI 回复消息');
  if (selectedMessages.some((item) => item.message.status === 'running')) throw new Error('请等待所选对话轮次执行完成后再生成 Skill');

  const selectedStepIndexSet = new Set<number>();
  for (const { message } of selectedMessages) {
    for (const stepIndex of message.stepIndexes || []) selectedStepIndexSet.add(stepIndex);
  }

  const selectedSteps = session.steps
    .filter((step) => selectedStepIndexSet.size ? selectedStepIndexSet.has(step.index) : step.index > 0)
    .sort((a, b) => a.index - b.index)
    .map((step, index): StepExecutionResult => ({
      ...step,
      index: index + 1,
      status: step.status === 'running' ? 'passed' : step.status,
    }));
  if (!selectedSteps.length) throw new Error('选中的对话轮次没有可生成 Skill 的执行步骤');

  const targetUrl = exportedTargetUrl(session, selectedSteps);
  const turnDescriptions = selectedMessages.map(({ message, index }, turnIndex) => {
    const previousUser = [...session.messages.slice(0, index)].reverse().find((item) => item.role === 'user');
    return [
      `轮次 ${turnIndex + 1}`,
      previousUser?.content ? `用户消息：${previousUser.content}` : '',
      message.content ? `AI 输出：${message.content}` : '',
    ].filter(Boolean).join('\n');
  });
  const firstSelected = selectedMessages[0];
  const firstPreviousUser = firstSelected
    ? [...session.messages.slice(0, firstSelected.index)].reverse().find((item) => item.role === 'user')
    : undefined;
  const titleSeed = firstPreviousUser?.content || firstSelected?.message.content || session.title || '浏览器对话 Skill';
  const timestamp = now();
  const content: TestCaseContent = {
    title: `对话 Skill - ${compactText(titleSeed, 36)}`,
    description: turnDescriptions.join('\n\n'),
    targetUrl,
    priority: 'medium',
    browserMode: session.mode,
    isMarked: true,
    userRequirement: turnDescriptions.join('\n\n') || titleSeed,
    systemPrompt: '该上下文由浏览器对话生成，用于提炼可复用 Skill，不会创建测试用例。',
    preconditions: ['已在浏览器对话中完成过相关操作，Skill 只保留可复用的操作经验。'],
    testData: {},
    steps: selectedSteps.map((step, index) => {
      const firstTool = firstPersistentStepTool(step);
      return {
        index: index + 1,
        operation: testOperationFromToolName(firstTool?.name),
        action: compactText(step.action || firstTool?.name || `执行步骤 ${step.index}`, 240),
        input: firstTool?.input ? safeJson(firstTool.input) : undefined,
        expected: compactText(step.expected || step.actual || '该步骤应按对话中的已执行结果完成。', 320),
        riskLevel: step.status === 'failed' ? 'warning' : 'safe',
      };
    }),
    expectedResults: selectedMessages
      .map((item) => item.message.content)
      .filter((item): item is string => Boolean(item?.trim()))
      .map((item) => compactText(item, 420)),
    risks: session.networkErrors.length || session.consoleErrors.length
      ? ['原对话执行过程中存在控制台或网络诊断记录，复用时需要关注稳定性。']
      : [],
  };
  const syntheticTestCase: TestCaseRecord = {
    id: `chat_case_${session.id}`,
    title: content.title,
    description: content.description,
    targetUrl,
    status: 'generated',
    priority: content.priority,
    content,
    imageNames: [],
    createdAt: session.createdAt,
    updatedAt: timestamp,
  };
  const syntheticRun: TestRunRecord = {
    id: `chat_run_${session.id}`,
    testCaseId: syntheticTestCase.id,
    status: statusFromSteps(selectedSteps),
    startedAt: selectedMessages[0]?.message.createdAt || session.createdAt,
    endedAt: timestamp,
    createdAt: session.createdAt,
    result: {
      steps: selectedSteps,
      consoleErrors: session.consoleErrors,
      networkErrors: session.networkErrors,
      taskFrame: selectedSteps.at(-1)?.taskFrame,
      ledgerItems: selectedSteps.flatMap((step) => step.ledgerItems || []),
    },
    report: {
      title: content.title,
      summary: content.description || titleSeed,
      markdown: turnDescriptions.join('\n\n'),
      suggestions: [],
    },
  };

  const generated = await generateSkillFromRun({ run: syntheticRun, testCase: syntheticTestCase });
  const skill = store.upsertSkill({
    title: generated.title,
    description: generated.description,
    tags: generated.tags,
    triggerPhrases: generated.triggerPhrases,
    content: generated.content,
    sourceSessionId: session.id,
    status: 'ready',
  });
  return { skill, sourceMessageIds: uniqueMessageIds };
}

export async function generateBrowserChatMessageSkill(sessionId: string, messageId: string) {
  return generateBrowserChatMessagesSkill(sessionId, [messageId]);
}


export async function sendBrowserChatMessage(
  sessionId: string,
  content: string,
  mode?: BrowserSessionMode,
  safetyMode?: BrowserChatSafetyMode,
  modelProvider?: unknown,
  model?: unknown,
  clientMessageId?: string,
  attachmentsInput?: unknown,
  skillIdsInput?: unknown,
  userId?: string | number,
) {
  const session = hydrateSession(sessionId);
  if (!session) throw new Error('Browser chat session not found');
  if (!sessionBelongsToUser(session, userId)) throw new Error('Browser chat session not found');
  if (session.status === 'closed') throw new Error('Browser chat session is closed');
  const text = textFromUnknown(content).trim();
  const attachments = normalizeAttachments(attachmentsInput);
  const skillIds = normalizeSkillIds(skillIdsInput);
  const selectedSkills = store.getSkills(skillIds).filter((skill) => skill.status === 'ready');
  if (!text && !attachments.length && !selectedSkills.length) throw new Error('Message is empty');
  const messageText = text || (selectedSkills.length ? '请结合已选择的 Skills 继续处理当前任务。' : '请结合我提供的引用继续处理当前任务。');
  const skillReferences = formatSkillReferencesForUser(selectedSkills);
  const referencedAttachmentIds = inlineReferencedIds(messageText, 'ref');
  const inlineMessageText = contentWithInlineReferencesForPrompt(messageText, attachments);
  const attachmentReferences = attachmentSummary(attachments, { excludeIds: referencedAttachmentIds });
  const modelMessageText = [inlineMessageText, skillReferences, attachmentReferences].filter(Boolean).join('\n\n');
  const normalizedClientMessageId = clientMessageId?.trim().slice(0, 120) || undefined;
  if (normalizedClientMessageId && session.messages.some((message) => message.clientMessageId === normalizedClientMessageId)) {
    return snapshot(session);
  }
  if (session.busy) throw new Error('Browser chat session is already running');
  cancelPendingToolConfirmation(session);
  cancelOrphanToolConfirmationsForSession(session.id);
  session.pendingToolConfirmation = undefined;
  if (mode && !session.started && !session.steps.length && !session.messages.length) session.mode = mode;
  session.safetyMode = normalizeSafetyMode(safetyMode ?? session.safetyMode);
  const modelSettings = browserChatModelSettings(modelProvider ?? session.modelProvider, model ?? session.model);
  session.modelProvider = modelSettings.provider;
  session.model = modelSettings.model;
  const firstUserMessage = !session.messages.some((message) => message.role === 'user');
  if (firstUserMessage) session.title = compactText(inlineMessageText || messageText, 42);

  const timestamp = now();
  const fromStepIndex = Math.max(0, ...session.steps.map((step) => step.index)) + 1;
  const userMessage: BrowserChatMessage = {
    id: id('msg'),
    role: 'user',
    content: messageText,
    createdAt: timestamp,
    updatedAt: timestamp,
    clientMessageId: normalizedClientMessageId,
    attachments,
    skillIds: selectedSkills.map((skill) => skill.id),
  };
  const assistantMessage: BrowserChatMessage = {
    id: id('msg'),
    role: 'assistant',
    content: '',
    createdAt: timestamp,
    updatedAt: timestamp,
    clientMessageId: normalizedClientMessageId,
    status: 'running',
    stepIndexes: [],
  };
  session.messages.push(userMessage);
  session.messages.push(assistantMessage);
  session.activeAssistantMessageId = assistantMessage.id;
  const abortController = new AbortController();
  session.activeAbortController = abortController;
  session.busy = true;
  session.status = 'running';
  session.error = undefined;
  session.updatedAt = timestamp;
  persistAndNotify(session.id);
  appendLog(session, 'chat:queued', '已收到消息，准备执行浏览器操作');

  void runBrowserChatMessage(session, messageText, modelMessageText, userMessage.id, assistantMessage.id, fromStepIndex, abortController, attachments, selectedSkills);
  return snapshot(session);
}

function updateAssistantMessage(
  session: BrowserChatSessionRecord,
  assistantMessageId: string,
  updater: (message: BrowserChatMessage) => BrowserChatMessage,
) {
  const index = session.messages.findIndex((message) => message.id === assistantMessageId);
  if (index < 0) return;
  const updated = updater(session.messages[index]);
  session.messages[index] = {
    ...updated,
    updatedAt: updated.updatedAt || now(),
  };
}

function stringifyJsonSafe(value: unknown, space?: number) {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (typeof item === 'function' || typeof item === 'symbol') return undefined;
    if (!item || typeof item !== 'object') return item;
    if (item instanceof Error) {
      return {
        name: item.name,
        message: item.message,
        stack: item.stack,
      };
    }
    if (item instanceof ArrayBuffer) return `[ArrayBuffer ${item.byteLength} bytes]`;
    if (ArrayBuffer.isView(item)) {
      const view = item as ArrayBufferView;
      return `[${item.constructor.name || 'TypedArray'} ${view.byteLength} bytes]`;
    }
    if (seen.has(item)) return '[Circular]';
    seen.add(item);
    return item;
  }, space);
}

function warnPersistFailure(error: unknown) {
  const timestamp = Date.now();
  if (timestamp - browserChatRuntimeState.lastPersistWarningAt < 1000) return;
  browserChatRuntimeState.lastPersistWarningAt = timestamp;
  console.warn('[browser-chat] Failed to persist sessions; keeping realtime state in memory.', error);
}

function runningAssistantActivity(step: StepExecutionResult, timestamp: string) {
  const latestTool = step.tools?.at(-1);
  if (latestTool && isRecoveredTransientStepTool(latestTool)) {
    return { phase: 'tool:recovered', label: `工具目标已刷新：${latestTool.name}`, updatedAt: timestamp };
  }
  if (step.status === 'failed' && latestTool?.ok !== false) {
    return { phase: 'ai:runtime:recoverable-error', label: 'AI 请求异常，已保留现场', updatedAt: timestamp };
  }
  if (latestTool) {
    if (latestTool.ok === false) {
      return { phase: 'tool:failed', label: `工具执行失败：${latestTool.name}`, updatedAt: timestamp };
    }
    if (latestTool.ok === true) {
      return { phase: 'tool:completed', label: `工具执行完成：${latestTool.name}`, updatedAt: timestamp };
    }
    return { phase: 'tool:running', label: `正在执行工具：${latestTool.name}`, updatedAt: timestamp };
  }
  return { phase: 'step:running', label: '正在处理浏览器操作', updatedAt: timestamp };
}

function toolNameFromLogMessage(message: string) {
  return message.split(/\s|->/).filter(Boolean)[0] || 'tool';
}

function runningActivityFromLog(phase: string, message: string) {
  if (phase === 'chat:queued') return '已发送，等待后端开始处理';
  if (phase === 'chat:run:start') return '正在启动本轮对话';
  if (phase === 'browser:start') return '正在连接浏览器';
  if (phase === 'browser:reuse') return '正在复用当前浏览器';
  if (phase === 'browser:stale') return '正在重新接管浏览器';
  if (phase === 'browser:screenshot:before') return '正在读取当前页面';
  if (phase === 'browser:screenshot:after') return '正在保存页面状态';
  if (phase === 'ai:runtime-input:start') return '正在准备运行上下文';
  if (phase === 'perf:runtime-input') return '正在准备页面上下文';
  if (phase === 'ai:prepare') return '正在请求 AI 决策';
  if (phase === 'ai:runtime:request') return '正在请求 AI 模型';
  if (phase === 'ai:runtime:response') return 'AI 已返回，正在处理结果';
  if (phase === 'ai:runtime:object') return 'AI 已返回，正在解析动作';
  if (phase === 'ai:runtime:retry') return 'AI 请求失败，正在重试';
  if (phase === 'ai:runtime:partial') return '工具已执行，正在继续判断';
  if (phase === 'ai:context-compressed') return '正在整理上下文';
  if (phase === 'ai:visual-context') return '正在更新视觉上下文';
  if (phase === 'tool:confirmation:pending') return '等待用户确认工具调用';
  if (phase === 'tool:confirmation:confirmed') return '用户已确认，正在继续执行工具';
  if (phase === 'tool:confirmation:cancelled') return '用户已取消工具调用，正在继续本轮对话';
  if (phase === 'chat:step:start') return '正在准备下一步操作';
  if (phase === 'chat:run:saving') return '正在写入最终结果';
  if (phase === 'chat:run:done') return '正在完成本轮对话';
  if (phase === 'chat:run:error') return '本轮对话异常，正在收尾';
  if (phase === 'chat:run:interrupted') return '正在中断本轮对话';
  if (phase === 'ai:tool') {
    const name = toolNameFromLogMessage(message);
    if (/started/i.test(message)) return `正在执行工具：${name}`;
    if (/failed/i.test(message)) return `工具执行失败：${name}`;
    if (/ok/i.test(message)) return `工具执行完成：${name}`;
    return `正在处理工具：${name}`;
  }
  return undefined;
}

function isActiveBrowserChatTurn(session: BrowserChatSessionRecord, assistantMessageId: string, abortController: AbortController) {
  return !interruptedAssistantMessageIds.has(assistantMessageId)
    && sessions.get(session.id) === session
    && session.activeAssistantMessageId === assistantMessageId
    && session.activeAbortController === abortController
    && !abortController.signal.aborted;
}

function toolConfirmationLog(decision: BrowserToolConfirmationDecision) {
  return decision === 'confirmed'
    ? {
        phase: 'tool:confirmation:confirmed',
        message: '用户已确认执行该工具，继续当前对话。',
      }
    : {
        phase: 'tool:confirmation:cancelled',
        message: '用户已取消该工具调用，继续当前对话。',
      };
}

function toolConfirmationInputSignature(value: unknown) {
  const omitToolPresentationFields = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(omitToolPresentationFields);
    if (!input || typeof input !== 'object') return input;
    const record = input as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record)
      .filter((key) => key !== 'reason' && key !== 'requiresConfirmation' && key !== 'confirmationMessage')
      .sort()
      .map((key) => [key, omitToolPresentationFields(record[key])]));
  };
  try {
    return JSON.stringify(omitToolPresentationFields(value)) || '';
  } catch {
    return '';
  }
}

function cancelPendingToolConfirmation(session: BrowserChatSessionRecord) {
  const pending = session.pendingToolConfirmation;
  if (!pending) return false;
  const resolver = toolConfirmations.get(pending.id);
  if (resolver) {
    resolver.resolve('cancelled');
  } else {
    session.pendingToolConfirmation = undefined;
  }
  return true;
}

function cancelOrphanToolConfirmationsForSession(sessionId: string, activeConfirmationId?: string) {
  for (const [confirmationId, resolver] of [...toolConfirmations.entries()]) {
    if (resolver.sessionId !== sessionId || confirmationId === activeConfirmationId) continue;
    resolver.resolve('cancelled');
  }
}

function requestBrowserChatToolConfirmation(
  session: BrowserChatSessionRecord,
  assistantMessageId: string,
  request: BrowserToolConfirmationRequest,
  abortSignal?: AbortSignal,
): Promise<BrowserToolConfirmationDecision> {
  if (abortSignal?.aborted) return Promise.resolve('cancelled');
  const existing = session.pendingToolConfirmation;
  const existingResolver = existing ? toolConfirmations.get(existing.id) : undefined;
  const inputSignature = toolConfirmationInputSignature(request.input);
  if (
    existing
    && existingResolver?.sessionId === session.id
    && existing.messageId === assistantMessageId
    && existing.toolName === request.toolName
    && existing.inputSignature === inputSignature
  ) {
    // A transient upstream retry can replay the same tool call while the user is
    // deciding. Reuse that decision instead of converting the original request
    // into a false "cancelled" tool result and showing a second confirmation.
    return existingResolver.promise;
  }
  cancelPendingToolConfirmation(session);
  cancelOrphanToolConfirmationsForSession(session.id);
  const confirmationId = id('confirm');
  const requestedAt = now();
  const pending: BrowserChatToolConfirmation = {
    id: confirmationId,
    messageId: assistantMessageId,
    stepIndex: request.stepIndex,
    toolName: request.toolName,
    inputSignature,
    reason: request.reason ? compactText(request.reason, 300) : undefined,
    prompt: compactText(request.prompt || `请确认是否执行工具 ${request.toolName}`, 500),
    requestedAt,
  };

  let finish!: (decision: BrowserToolConfirmationDecision) => void;
  let onAbort!: () => void;
  const decisionPromise = new Promise<BrowserToolConfirmationDecision>((resolve) => {
    let settled = false;
    finish = (decision: BrowserToolConfirmationDecision) => {
      if (settled) return;
      settled = true;
      toolConfirmations.delete(confirmationId);
      abortSignal?.removeEventListener('abort', onAbort);
      if (session.pendingToolConfirmation?.id === confirmationId) {
        session.pendingToolConfirmation = undefined;
        const log = toolConfirmationLog(decision);
        appendLog(session, log.phase, log.message, {
          stepIndex: pending.stepIndex,
          messageId: assistantMessageId,
          details: { confirmationId, decision, toolName: pending.toolName, inputSignature: pending.inputSignature },
        });
      }
      resolve(decision);
    };
    onAbort = () => finish('cancelled');
    session.pendingToolConfirmation = pending;
    appendLog(session, 'tool:confirmation:pending', `工具 ${request.toolName} 等待用户确认。`, {
      stepIndex: request.stepIndex,
      messageId: assistantMessageId,
      details: { confirmation: pending, input: request.input },
    });
  });
  toolConfirmations.set(confirmationId, { sessionId: session.id, resolve: finish, promise: decisionPromise });
  abortSignal?.addEventListener('abort', onAbort, { once: true });
  if (abortSignal?.aborted) onAbort();
  return decisionPromise;
}

export function resolveBrowserChatToolConfirmation(
  sessionId: string,
  confirmationId: string,
  action: 'confirm' | 'cancel',
  userId?: string | number,
) {
  const session = hydrateSession(sessionId);
  if (!session) throw new Error('Browser chat session not found');
  if (!sessionBelongsToUser(session, userId)) throw new Error('Browser chat session not found');
  const normalizedConfirmationId = confirmationId.trim();
  const pending = session.pendingToolConfirmation;
  if (!pending || pending.id !== normalizedConfirmationId) {
    throw new Error('Tool confirmation is not pending');
  }
  const resolver = toolConfirmations.get(normalizedConfirmationId);
  if (!resolver || resolver.sessionId !== sessionId) {
    session.pendingToolConfirmation = undefined;
    const abortController = session.activeAbortController;
    if (abortController && !abortController.signal.aborted) {
      abortController.abort(new Error('Tool confirmation resolver was not available when the user responded.'));
    }
    appendLog(session, 'tool:confirmation:stale', '工具确认已失效，已清理。', {
      stepIndex: pending.stepIndex,
      messageId: pending.messageId,
      details: { confirmationId: normalizedConfirmationId, toolName: pending.toolName },
    });
    throw new Error('Tool confirmation is no longer active');
  }
  resolver.resolve(action === 'confirm' ? 'confirmed' : 'cancelled');
  return snapshot(session);
}

export function interruptBrowserChatSession(sessionId: string, userId?: string | number) {
  const session = hydrateSession(sessionId);
  if (!session) return undefined;
  if (!sessionBelongsToUser(session, userId)) return undefined;
  const timestamp = now();
  const assistantMessageId = session.activeAssistantMessageId || latestRunningAssistantMessageId(session);
  const abortController = session.activeAbortController;
  markAssistantMessageInterrupted(assistantMessageId);
  if (abortController && !abortController.signal.aborted) {
    abortController.abort(new Error('Browser chat operation interrupted by user.'));
  }
  cancelPendingToolConfirmation(session);
  discardInterruptedTurn(session, assistantMessageId);
  session.activeAbortController = undefined;
  session.activeAssistantMessageId = undefined;
  session.pendingToolConfirmation = undefined;
  session.busy = false;
  if (session.status !== 'closed') session.status = 'idle';
  session.error = undefined;
  session.updatedAt = timestamp;
  if (!persistAndNotify(session.id)) {
    throw new Error('Browser chat interrupt state could not be persisted.');
  }
  return snapshot(session);
}

async function runBrowserChatMessage(
  session: BrowserChatSessionRecord,
  text: string,
  modelText: string,
  userMessageId: string,
  assistantMessageId: string,
  fromStepIndex: number,
  abortController: AbortController,
  attachments: BrowserChatAttachment[],
  skills: SkillRecord[] = [],
) {
  const modelSettings = browserChatModelSettings(session.modelProvider, session.model);
  return withModelSettings(modelSettings, async () => {
    try {
      if (!isActiveBrowserChatTurn(session, assistantMessageId, abortController)) return;
      appendLog(session, 'chat:run:start', '开始处理本轮对话操作');
      const browser = await ensureStarted(session);
      if (!isActiveBrowserChatTurn(session, assistantMessageId, abortController)) return;
      await ensureConversationContextWithinThreshold(session, userMessageId, abortController.signal);
      if (!isActiveBrowserChatTurn(session, assistantMessageId, abortController)) return;
      const recalledMemoryIds = new Set<string>();
      const recalledDomains = new Set<string>();
      const initialPersonalMemory = browserChatPersonalMemoryContext({ session, browser, text, modelText });
      initialPersonalMemory.itemIds.forEach((id) => recalledMemoryIds.add(id));
      if (initialPersonalMemory.domain) recalledDomains.add(initialPersonalMemory.domain);
      const skillContext = [
        initialPersonalMemory.context,
        formatSkillsForPrompt(skills),
      ].filter(Boolean).join('\n\n');
      appendLog(session, 'ai:prepare', '浏览器已准备好，正在请求 AI 决策');
      const referenceImagePaths = attachments.map(attachmentAbsolutePath).filter((item): item is string => Boolean(item));
      const result = await executeInteractiveBrowserTurn({
        session: browser,
        runId: session.id,
        targetUrl: session.targetUrl || 'about:blank',
        instruction: text,
        modelInstruction: modelText,
        conversation: conversationForPrompt(session.messages, session.conversationContext, userMessageId),
        completedSteps: session.steps,
        mode: session.mode,
        safetyMode: session.safetyMode,
        referenceImagePaths,
        skillContext,
        getDynamicSkillContext: () => {
          const currentUrl = browserChatMemoryUrl(browser, session);
          const currentDomain = normalizePersonalMemoryDomain(currentUrl || session.targetUrl);
          if (!currentDomain || recalledDomains.has(currentDomain)) return '';
          const recalled = browserChatPersonalMemoryContext({
            session,
            browser,
            text,
            modelText,
            currentUrl,
            domainOnly: true,
            excludedIds: recalledMemoryIds,
            logPhase: 'memory:prompt:domain-refresh',
          });
          recalledDomains.add(currentDomain);
          recalled.itemIds.forEach((id) => recalledMemoryIds.add(id));
          return recalled.context;
        },
        abortSignal: abortController.signal,
        shouldContinue: () => isActiveBrowserChatTurn(session, assistantMessageId, abortController),
        requestToolConfirmation: session.safetyMode === 'strict'
          ? (request) => requestBrowserChatToolConfirmation(session, assistantMessageId, request, abortController.signal)
          : undefined,
        onProgress: (step) => {
          if (!isActiveBrowserChatTurn(session, assistantMessageId, abortController)) return;
          const index = session.steps.findIndex((item) => item.index === step.index);
          if (index >= 0) session.steps[index] = { ...session.steps[index], ...step };
          else session.steps.push(step);
          session.steps.sort((a, b) => a.index - b.index);
          if (step.index >= fromStepIndex) {
            const timestamp = now();
            updateAssistantMessage(session, assistantMessageId, (message) => ({
              ...message,
              activity: runningAssistantActivity(step, timestamp),
              status: 'running',
              updatedAt: timestamp,
              stepIndexes: Array.from(new Set([...(message.stepIndexes || []), step.index])).sort((a, b) => a - b),
            }));
          }
          session.updatedAt = now();
          // A tool trace is reported before its browser action begins. This state must
          // reach the session endpoint synchronously: realtime refreshes hydrate from
          // the persisted snapshot, so a deferred write makes fast follow-up tools
          // appear only after they have already completed.
          const hasRunningTool = (step.tools || []).some((tool) => tool.ok === undefined);
          persistAndNotify(session.id, hasRunningTool
            ? { mergeFromDisk: false }
            : { defer: true });
        },
        onDebug: (event) => {
          if (!isActiveBrowserChatTurn(session, assistantMessageId, abortController)) return;
          appendLog(session, event.phase, event.message, {
            stepIndex: event.stepIndex,
            elapsedMs: elapsedFromDetails(event.details),
            details: event.details,
            deferPersist: true,
          });
        },
      });
      if (!isActiveBrowserChatTurn(session, assistantMessageId, abortController)) return;
      appendLog(session, 'chat:run:saving', '正在写入本轮对话最终结果', { deferPersist: true });
      session.steps = result.steps;
      session.consoleErrors = result.consoleErrors;
      session.networkErrors = result.networkErrors;
      queuePersonalMemoryExtraction({ session, browser, text, result, userMessageId, assistantMessageId });
      const finishedAt = now();
      updateAssistantMessage(session, assistantMessageId, (message) => ({
        ...message,
        content: result.reply,
        updatedAt: finishedAt,
        stepIndexes: Array.from(new Set([
          ...(message.stepIndexes || []),
          ...result.newSteps.map((step) => step.index),
        ])).sort((a, b) => a - b),
        status: result.status,
        activity: undefined,
      }));
      if (!isActiveBrowserChatTurn(session, assistantMessageId, abortController)) return;
      const completedAt = now();
      const keepCompletedBrowser = browserChatKeepBrowserOpenAfterTurn() && Boolean(session.browser?.isUsable());
      const shouldCloseCompletedBrowser = Boolean(session.browser || session.started) && !keepCompletedBrowser;
      if (shouldCloseCompletedBrowser) {
        await session.browser?.close({ keepOpen: true }).catch(() => undefined);
        session.browser = undefined;
        session.started = false;
      }
      session.status = 'idle';
      session.busy = false;
      session.pendingToolConfirmation = undefined;
      session.activeAssistantMessageId = undefined;
      session.activeAbortController = undefined;
      session.updatedAt = completedAt;
      session.logs = trimBrowserChatLogs([
        ...(session.logs || []),
        {
          id: id('log'),
          time: completedAt,
          phase: 'chat:run:done',
          message: shouldCloseCompletedBrowser
            ? '本轮对话操作已完成，最终结果已写入，浏览器已自动关闭。'
            : keepCompletedBrowser
              ? '本轮对话操作已完成，最终结果已写入，浏览器已保留供后续对话复用。'
              : '本轮对话操作已完成，最终结果已写入。',
          messageId: assistantMessageId,
        },
      ]);
      persistAndNotify(session.id);
      void ensureConversationContextWithinThreshold(session).catch(() => undefined);
    } catch (error) {
      const stillActive = isActiveBrowserChatTurn(session, assistantMessageId, abortController);
      const interrupted = abortController.signal.aborted || interruptedAssistantMessageIds.has(assistantMessageId);
      if (!stillActive) return;
      const message = userFacingErrorMessage(error);
      const details = errorLogDetails(error);
      if (isDeadBrowserSessionError(error)) {
        await session.browser?.close({ keepOpen: true }).catch(() => undefined);
        session.browser = undefined;
        session.started = false;
      }
      appendLog(
        session,
        interrupted ? 'chat:run:interrupted' : 'chat:run:error',
        interrupted ? '用户主动中断了本轮对话。' : `本轮对话异常：${message}`,
        { details, deferPersist: true },
      );
      session.error = interrupted ? undefined : message;
      session.status = interrupted ? 'idle' : 'error';
      session.busy = false;
      session.pendingToolConfirmation = undefined;
      session.updatedAt = now();
      updateAssistantMessage(session, assistantMessageId, (item) => ({
        ...item,
        content: interrupted ? '已中断本轮对话操作。浏览器保持当前状态，可以继续发送下一条消息。' : `执行异常：${message}`,
        updatedAt: session.updatedAt,
        status: interrupted ? 'interrupted' : 'failed',
        activity: undefined,
      }));
      session.activeAssistantMessageId = undefined;
      session.activeAbortController = undefined;
      persistAndNotify(session.id);
    } finally {
      if (session.pendingToolConfirmation?.messageId === assistantMessageId) {
        cancelPendingToolConfirmation(session);
        session.pendingToolConfirmation = undefined;
      }
      if (session.activeAbortController === abortController) session.activeAbortController = undefined;
    }
  });
}
