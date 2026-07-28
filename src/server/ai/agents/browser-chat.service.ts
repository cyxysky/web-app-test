import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { generateText } from 'ai';
import { BrowserSession, type BrowserActionResult, type BrowserLiveInput, type BrowserScreencastFrame, type BrowserSessionMode, type BrowserTabSnapshot } from '@/server/browser/browser-session';
import { applicationUserRuntimeKey, normalizeApplicationUserId } from '@/server/auth/user-context';
import {
  executeInteractiveBrowserTurn,
  type BrowserToolConfirmationDecision,
  type BrowserToolConfirmationRequest,
  type BrowserChatSubagentReader,
  type BrowserChatSubagentTask,
  type InteractiveBrowserTurnMessage,
  type InteractiveBrowserTurnResult,
} from '@/server/ai/agents/browser-chat-executor.agent';
import { generateSkillFromRun } from '@/server/ai/agents/skill-generator.agent';
import { browserChatAttachmentMetadata, isBrowserChatImageAttachment, readBrowserChatAttachment } from '@/server/ai/agents/browser-chat-attachment-reader';
import { browserChatFirstMessageTitle } from '@/server/ai/agents/browser-chat-message-title';
import {
  browserChatSubagentSuggestedSummaryChars,
  preserveBrowserChatSubagentSummary,
  runOrReuseBrowserChatSubagentBatch,
  settleBrowserChatSubagents,
} from '@/server/ai/agents/browser-chat-subagents';
import {
  revokeBrowserChatTurn,
  runtimeSnapshotIsNewer,
} from '@/server/ai/agents/browser-chat-interrupt-state';
import { formatSkillReferencesForUser, formatSkillsForPrompt, runtimeSkillsForUrl } from '@/server/ai/agents/skill-context';
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
import { store } from '@/server/db/store';
import { publishRefreshEvent } from '@/server/realtime/ws-refresh';
import {
  deleteBrowserChatSessionRecord,
  readBrowserChatLogs,
  readBrowserChatSessionRecord,
  readBrowserChatSessionSummaries,
  writeBrowserChatSessionRecord,
} from '@/server/storage/sqlite-record-store';
import { artifactPath as resolveArtifactPath } from '@/server/storage/paths';
import { artifactApiUrlFromRelative } from '@/lib/artifacts';
import { normalizeModelProvider, resolveRuntimeModelSelection } from '@/lib/model-selection';
import {
  listLoginAccounts,
  resolveLoginAccountCredentialById,
} from '@/server/credentials/login-account-vault';

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

type BrowserChatBlockedSubagentRuntime = {
  id: string;
  sessionId: string;
  assistantMessageId: string;
  title: string;
  task: BrowserChatSubagentTask;
  browser: BrowserSession;
  steps: StepExecutionResult[];
};

type BrowserChatStoredSubagent = {
  uuid: string;
  batchId: string;
  sessionId: string;
  assistantMessageId: string;
  index: number;
  title: string;
  task: BrowserChatSubagentTask;
  status: 'running' | 'passed' | 'failed' | 'blocked';
  summary: string;
  summaryChars: number;
  summaryOriginalChars: number;
  summaryTruncated: boolean;
  steps: StepExecutionResult[];
  events: unknown[];
  error?: string;
  createdAt: string;
  updatedAt: string;
};

type BrowserChatRuntimeState = {
  sessions: Map<string, BrowserChatSessionRecord>;
  browserStartPromises: Map<string, Promise<BrowserSession>>;
  blockedSubagents: Map<string, BrowserChatBlockedSubagentRuntime>;
  subagentResults: Map<string, Map<string, BrowserChatStoredSubagent>>;
  interruptedAssistantMessageIds: Set<string>;
  toolConfirmations: Map<string, {
    sessionId: string;
    resolve: (decision: BrowserToolConfirmationDecision) => void;
    promise: Promise<BrowserToolConfirmationDecision>;
  }>;
  pendingPersistTimers: Map<string, ReturnType<typeof setTimeout>>;
  lastPersistWarningAt: number;
};

const browserChatRuntimeState = ((globalThis as typeof globalThis & {
  __browserChatRuntimeState?: BrowserChatRuntimeState;
}).__browserChatRuntimeState ??= {
  sessions: new Map<string, BrowserChatSessionRecord>(),
  browserStartPromises: new Map<string, Promise<BrowserSession>>(),
  blockedSubagents: new Map(),
  subagentResults: new Map(),
  interruptedAssistantMessageIds: new Set<string>(),
  toolConfirmations: new Map<string, {
    sessionId: string;
    resolve: (decision: BrowserToolConfirmationDecision) => void;
    promise: Promise<BrowserToolConfirmationDecision>;
  }>(),
  pendingPersistTimers: new Map<string, ReturnType<typeof setTimeout>>(),
  lastPersistWarningAt: 0,
});
browserChatRuntimeState.sessions ??= new Map();
browserChatRuntimeState.browserStartPromises ??= new Map();
browserChatRuntimeState.blockedSubagents ??= new Map();
browserChatRuntimeState.subagentResults ??= new Map();
browserChatRuntimeState.interruptedAssistantMessageIds ??= new Set();
browserChatRuntimeState.toolConfirmations ??= new Map();
browserChatRuntimeState.pendingPersistTimers ??= new Map();

const sessions = browserChatRuntimeState.sessions;
const browserStartPromises = browserChatRuntimeState.browserStartPromises;
const blockedSubagents = browserChatRuntimeState.blockedSubagents;
const subagentResults = browserChatRuntimeState.subagentResults;
const interruptedAssistantMessageIds = browserChatRuntimeState.interruptedAssistantMessageIds;
const toolConfirmations = browserChatRuntimeState.toolConfirmations;
const pendingPersistTimers = browserChatRuntimeState.pendingPersistTimers;
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

function browserChatBrowserProfileKey(session: Pick<BrowserChatSessionSnapshot, 'userId'>) {
  return `user_${normalizeUserId(session.userId)}`;
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

function browserChatBoundedNonNegativeEnv(key: string, fallback: number, max: number) {
  const raw = Number(process.env[key]);
  if (!Number.isFinite(raw) || raw < 0) return fallback;
  return Math.min(Math.floor(raw), max);
}

function browserChatBrowserExecutionOptions() {
  return {
    slowMoMs: browserChatBoundedNonNegativeEnv('BROWSER_CHAT_SLOW_MO_MS', 0, 2000),
    popupWaitMs: browserChatBoundedNonNegativeEnv('BROWSER_CHAT_POPUP_WAIT_MS', 0, 3000),
    actionFrameLimit: Math.max(1, browserChatBoundedNonNegativeEnv('BROWSER_CHAT_ACTION_FRAME_LIMIT', 24, 200)),
  };
}

function browserChatMemoryUrl(browser: BrowserSession | undefined, session: Pick<BrowserChatSessionSnapshot, 'targetUrl'>) {
  const currentUrl = browser?.currentUrl() || '';
  return currentUrl || session.targetUrl || '';
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
    (/^openPage$/i.test(tool.name) || (tool.name === 'page' && flowInputRecord(tool.input).action === 'open')) ? [inputUrl(tool.input)] : []
  )));
  return firstExportableTargetUrl([
    session.targetUrl,
    browserCurrentUrl,
    ...urlsFromOpenTools,
  ]);
}

function exportedRecordedToolInput(toolName: string, input: unknown, targetUrl: string) {
  if (!/^openPage$/i.test(toolName) && !(toolName === 'page' && flowInputRecord(input).action === 'open')) return input;
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
  return normalizeApplicationUserId(value);
}

function sessionBelongsToUser(session: Pick<BrowserChatSessionSnapshot, 'userId'>, userId?: unknown) {
  return normalizeUserId(session.userId) === normalizeUserId(userId);
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

function uploadedAttachmentAbsolutePath(attachment: BrowserChatAttachment) {
  if (attachment.kind === 'tab') return undefined;
  const relativePath = normalizeAttachmentPath(attachment.path);
  if (relativePath) return resolveArtifactPath(...relativePath.split('/'));
  if (!attachment.id.startsWith('artifact:')) return undefined;
  const artifactSegments = attachment.path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (!artifactSegments.length || artifactSegments.some((segment) => segment === '.' || segment === '..')) return undefined;
  return resolveArtifactPath(...artifactSegments);
}

function artifactAttachmentForSession(session: BrowserChatSessionRecord, artifactId: string): BrowserChatAttachment | undefined {
  const segments = artifactId.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) return undefined;
  if (segments.length < 3 || segments[0] !== session.id || !['downloads', 'markdown'].includes(segments[1])) return undefined;
  const name = segments.at(-1) || 'artifact';
  return {
    id: `artifact:${segments.join('/')}`,
    kind: 'file',
    name,
    path: segments.join('/'),
    size: undefined,
    type: 'application/octet-stream',
    url: artifactApiUrlFromRelative(segments.join('/')),
  };
}

async function readFileForSession(
  session: BrowserChatSessionRecord,
  input: { attachmentId?: string; artifactId?: string; limit?: number; offset?: number },
) {
  const attachment = input.attachmentId
    ? [...session.messages]
      .reverse()
      .flatMap((message) => message.attachments || [])
      .find((item) => item.id === input.attachmentId)
    : input.artifactId
      ? artifactAttachmentForSession(session, input.artifactId)
      : undefined;
  if (!attachment) {
    return {
      ok: false,
      actual: '未找到可读取文件。请使用对话附件的 attachmentId，或 file 工具返回的 Artifact ID。',
    };
  }
  const result = await readBrowserChatAttachment({
    attachment,
    absolutePath: uploadedAttachmentAbsolutePath(attachment),
    limit: input.limit,
    offset: input.offset,
  });
  return isBrowserChatImageAttachment(attachment) && result.ok
    ? { ...result, referenceImagePath: uploadedAttachmentAbsolutePath(attachment) }
    : result;
}

type BrowserChatResourceSeed = {
  kind: 'url' | 'axure' | 'tab' | 'file' | 'image' | 'other';
  title: string;
  url?: string;
};

function browserChatCredentialContext(
  session: BrowserChatSessionRecord,
  seeds: BrowserChatResourceSeed[],
  instruction: string,
) {
  const values = new Map<string, string>();
  const credentials: Array<{
    origin: string;
    username: string;
    usernameRef: string;
    passwordRef: string;
  }> = [];
  const allowedOrigins = new Set<string>();
  for (const seed of seeds) {
    if (!seed.url) continue;
    let url: URL;
    try {
      url = new URL(seed.url);
    } catch {
      continue;
    }
    if (!['http:', 'https:'].includes(url.protocol)) continue;
    const accounts = listLoginAccounts({ userId: session.userId, domain: url.hostname })
      .filter((account) => account.status === 'active');
    const mentioned = accounts.filter((account) => new RegExp(`(^|[^a-z0-9])${account.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(instruction));
    const account = mentioned.length === 1 ? mentioned[0] : accounts.length === 1 ? accounts[0] : undefined;
    if (!account || credentials.some((item) => item.origin === url.origin && item.username === account.username)) continue;
    const secret = resolveLoginAccountCredentialById(account.id, session.userId);
    if (!secret) continue;
    const token = randomUUID();
    const usernameRef = `research_credential_${token}_username`;
    const passwordRef = `research_credential_${token}_password`;
    values.set(usernameRef, account.username);
    values.set(passwordRef, secret.password);
    allowedOrigins.add(url.origin);
    if (account.loginUrl) {
      try {
        allowedOrigins.add(new URL(account.loginUrl).origin);
      } catch {
        // The saved account remains usable for the exact seed origin.
      }
    }
    credentials.push({ origin: url.origin, username: account.username, usernameRef, passwordRef });
  }
  for (const account of listLoginAccounts({ userId: session.userId }).filter((item) => item.status === 'active')) {
    const usernamePattern = new RegExp(`(^|[^a-z0-9])${account.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
    const domainPattern = new RegExp(`(^|[^0-9])${account.domain.split('.').at(-1)?.replace(/\D/g, '') || account.domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^0-9]|$)`);
    if (!usernamePattern.test(instruction) && !instruction.includes(account.domain) && !domainPattern.test(instruction)) continue;
    let origin = '';
    try {
      origin = new URL(account.loginUrl || `https://${account.domain}`).origin;
    } catch {
      continue;
    }
    if (credentials.some((item) => item.origin === origin && item.username === account.username)) continue;
    const secret = resolveLoginAccountCredentialById(account.id, session.userId);
    if (!secret) continue;
    const token = randomUUID();
    const usernameRef = `chat_credential_${token}_username`;
    const passwordRef = `chat_credential_${token}_password`;
    values.set(usernameRef, account.username);
    values.set(passwordRef, secret.password);
    allowedOrigins.add(origin);
    credentials.push({ origin, username: account.username, usernameRef, passwordRef });
  }
  return {
    credentials,
    credentialAllowedOrigins: Array.from(allowedOrigins),
    resolveCredential: (credentialRef: string) => values.get(credentialRef),
  };
}

function browserChatCredentialPrompt(credentials: ReturnType<typeof browserChatCredentialContext>['credentials']) {
  if (!credentials.length) return '';
  return [
    '[后台已匹配的安全账号引用]',
    ...credentials.map((item) => `- ${item.origin} / ${item.username}：用户名使用 interact({action:"type",credentialRef:"${item.usernameRef}"})，密码使用 interact({action:"type",credentialRef:"${item.passwordRef}"})。`),
    '账号明文密码不会提供给模型。只能在当前页面 origin 与上述 origin 完全一致时使用 credentialRef；不得把凭据写入 text、日志或最终回复。验证码、OTP、扫码或二次认证必须调用 waitForHumanVerification。',
  ].join('\n');
}

function browserChatRelevantMemoryPrompt(session: BrowserChatSessionRecord, browser: BrowserSession, instruction: string) {
  if (!personalMemoryEnabled()) return '';
  const currentUrl = browserChatMemoryUrl(browser, session);
  const matches = searchPersonalMemory({
    userId: session.userId,
    query: instruction,
    domain: normalizePersonalMemoryDomain(currentUrl || session.targetUrl),
    limit: 6,
  });
  if (!matches.length) return '';
  markPersonalMemoryItemsUsed(matches.map((match) => match.item.id));
  return formatPersonalMemoryForPrompt(matches);
}

function createBrowserChatRuntimeOperationalContext(input: {
  session: BrowserChatSessionRecord;
  browser: BrowserSession;
  instruction: string;
  explicitlySelectedSkills?: SkillRecord[];
}) {
  let cachedKey = '';
  let cachedContext: {
    operationalContext: string;
    resolveCredential?: (credentialRef: string) => string | undefined;
    credentialAllowedOrigins: string[];
  } | undefined;
  return () => {
    const currentUrl = browserChatMemoryUrl(input.browser, input.session);
    let currentOrigin = '';
    try {
      currentOrigin = new URL(currentUrl).origin;
    } catch {
      currentOrigin = normalizePersonalMemoryDomain(currentUrl || input.session.targetUrl);
    }
    const key = currentOrigin || 'global';
    if (cachedContext && cachedKey === key) return cachedContext;
    const skills = runtimeSkillsForUrl(
      store.listSkills().filter((skill) => skill.status === 'ready'),
      input.explicitlySelectedSkills || [],
      currentUrl || input.session.targetUrl,
    );
    const credentialUrl = /^https?:\/\//i.test(currentUrl) ? currentUrl : input.session.targetUrl;
    const credentials = browserChatCredentialContext(
      input.session,
      credentialUrl ? [{ kind: 'url', title: '当前页面', url: credentialUrl }] : [],
      input.instruction,
    );
    cachedKey = key;
    cachedContext = {
      operationalContext: [
        formatSkillsForPrompt(skills),
        browserChatRelevantMemoryPrompt(input.session, input.browser, input.instruction),
        browserChatCredentialPrompt(credentials.credentials),
      ].filter(Boolean).join('\n\n'),
      resolveCredential: credentials.resolveCredential,
      credentialAllowedOrigins: credentials.credentialAllowedOrigins,
    };
    return cachedContext;
  };
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
  const prefix = typeof index === 'number' ? `${index}. ` : '';
  if (attachment.kind === 'tab') {
    const location = attachment.sourceUrl || attachment.url || '新建标签页';
    return `${prefix}[${attachmentKindLabel(attachment)}] ${attachment.name} (${location})`;
  }
  return `${prefix}${browserChatAttachmentMetadata(attachment)}`;
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
  return 256000;
}

function contextCompressionThresholdRatio() {
  const raw = Number(process.env.AI_CONTEXT_COMPRESSION_THRESHOLD || process.env.AI_CONTEXT_COMPRESSION_RATIO || 0.7);
  if (!Number.isFinite(raw) || raw <= 0) return 0.7;
  return raw > 1 ? Math.min(0.98, raw / 100) : Math.min(0.98, raw);
}

function browserChatConversationTokenEstimate(messages: InteractiveBrowserTurnMessage[]) {
  return estimateTextTokens(messages.map((message) => `${message.role}: ${message.content}`).join('\n\n'));
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
    `Input JSON:\n${stringifyJsonSafe(source, 2) || ''}`,
  ].join('\n');
}

function fallbackConversationSummary(input: { previousContext?: BrowserChatConversationContext; messages: BrowserChatMessage[] }) {
  return [
    input.previousContext?.summary ? `此前摘要：${input.previousContext.summary}` : '',
    ...input.messages.map((message) => `${message.role === 'user' ? '用户' : 'AI'}：${messageContentForPrompt(message)}`),
  ].filter(Boolean).join('\n');
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function testOperationFromToolName(name?: string, input?: unknown): NonNullable<TestCaseContent['steps'][number]['operation']> {
  if (name === 'page') return flowInputRecord(input).action === 'wait' ? 'wait' : 'open';
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
    userId: normalizeUserId(session.userId),
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

function preserveInterruptedTurn(session: BrowserChatSessionRecord, assistantMessageId: string | undefined, timestamp: string) {
  if (assistantMessageId) {
    updateAssistantMessage(session, assistantMessageId, (message) => ({
      ...message,
      content: message.content || '本轮对话已由用户中止。已保留中止前已执行的工具和页面记录。',
      status: 'interrupted',
      activity: undefined,
      updatedAt: timestamp,
    }));
  }
  session.steps = session.steps.map((step) => {
    if (step.status !== 'queued' && step.status !== 'running') return step;
    const interruptionNote = '用户已中止本轮对话；已保留中止前的工具执行记录。';
    return {
      ...step,
      status: 'blocked',
      actual: step.actual.includes(interruptionNote) ? step.actual : [step.actual, interruptionNote].filter(Boolean).join('\n\n'),
      note: step.note?.includes(interruptionNote) ? step.note : [step.note, interruptionNote].filter(Boolean).join('\n'),
    };
  });
}

function shouldPreserveRuntimeTurn(existing: BrowserChatSessionRecord, fromDisk: BrowserChatSessionSnapshot) {
  const assistantMessageId = existing.activeAssistantMessageId;
  const abortController = existing.activeAbortController;
  if (!assistantMessageId || !abortController) return false;
  if (abortController.signal.aborted || interruptedAssistantMessageIds.has(assistantMessageId)) return false;
  if (!fromDisk.busy && fromDisk.status !== 'running' && !hasRunningAssistantMessage(fromDisk, assistantMessageId)) return false;
  return hasRunningAssistantMessage(fromDisk, assistantMessageId);
}

function recordFromSnapshot(
  session: BrowserChatSessionSnapshot,
  options: { preserveRunningState?: boolean } = {},
): BrowserChatSessionRecord {
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
  const messages = assignAssistantStepIndexesToLatestMessage((session.messages || []).map((rawMessage) => {
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
  }));
  return {
    ...session,
    userId: normalizeUserId(session.userId),
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

function readSessionSummaries(): BrowserChatSessionSnapshot[] {
  return readBrowserChatSessionSummaries<BrowserChatSessionSnapshot>()
    .filter(isBrowserChatSessionSnapshot);
}

function isBrowserChatSessionSnapshot(value: unknown): value is BrowserChatSessionSnapshot {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { id?: unknown }).id === 'string';
}

function readSessionLogRecords(sessionId: string) {
  return readBrowserChatLogs<BrowserChatLogRecord>(sessionId);
}

function readSessionSnapshot(sessionId: string) {
  const item = readBrowserChatSessionRecord<BrowserChatSessionSnapshot>(sessionId);
  if (!isBrowserChatSessionSnapshot(item)) return undefined;
  return { ...item, logs: trimBrowserChatLogs(readSessionLogRecords(sessionId)) };
}

function writeSessionSnapshot(item: BrowserChatSessionSnapshot, options: { mergePersisted?: boolean } = {}) {
  const logs = options.mergePersisted === false
    ? item.logs
    : mergePersistedLogs(readSessionLogRecords(item.id), item.logs);
  const storedLogs = logs.length > browserChatLogStorageLimit() ? trimBrowserChatLogs(logs) : logs;
  const durableSnapshot = { ...item, logs: [] };
  writeBrowserChatSessionRecord(
    durableSnapshot,
    summaryFromSnapshot({ ...item, logs: trimBrowserChatLogs(storedLogs) }),
    storedLogs,
  );
}

function deleteSessionSnapshot(sessionId: string) {
  deleteBrowserChatSessionRecord(sessionId);
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

function assignAssistantStepIndexesToLatestMessage(messages: BrowserChatMessage[]) {
  // A stale transient step can be removed during recovery and its numeric index
  // reused by the next turn. Disk merging must not attach that reused step to
  // both assistant messages; the later turn is the authoritative owner.
  const claimedStepIndexes = new Set<number>();
  const normalized = [...messages];
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const message = normalized[index];
    if (message.role !== 'assistant' || !message.stepIndexes?.length) continue;
    const stepIndexes = message.stepIndexes.filter((stepIndex) => {
      if (claimedStepIndexes.has(stepIndex)) return false;
      claimedStepIndexes.add(stepIndex);
      return true;
    });
    if (stepIndexes.length !== message.stepIndexes.length) {
      normalized[index] = { ...message, stepIndexes };
    }
  }
  return normalized;
}

function mergePersistedMessages(existing: BrowserChatMessage[] = [], incoming: BrowserChatMessage[] = []) {
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
  return assignAssistantStepIndexesToLatestMessage(
    [...byId.values()].sort((a, b) => messageTimestamp(a) - messageTimestamp(b)),
  );
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

function mergePersistedStep(existing: StepExecutionResult, incoming: StepExecutionResult) {
  if (existing.status !== 'running' && incoming.status === 'running') return existing;
  if (incoming.status !== 'running' && existing.status === 'running') return incoming;
  return stepCompletenessScore(incoming) >= stepCompletenessScore(existing)
    ? { ...existing, ...incoming }
    : { ...incoming, ...existing };
}

function mergePersistedSteps(existing: StepExecutionResult[] = [], incoming: StepExecutionResult[] = []) {
  const byIndex = new Map<number, StepExecutionResult>();
  for (const step of existing) byIndex.set(step.index, step);
  for (const step of incoming) {
    const previous = byIndex.get(step.index);
    byIndex.set(step.index, previous ? mergePersistedStep(previous, step) : step);
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

function mergePersistedLogs(existing: BrowserChatLogRecord[] = [], incoming: BrowserChatLogRecord[] = []) {
  const byKey = new Map<string, BrowserChatLogRecord>();
  const keyOf = (item: BrowserChatLogRecord) => item.id || [item.time, item.phase, item.message, item.stepIndex || ''].join('|');
  for (const item of existing) byKey.set(keyOf(item), item);
  for (const item of incoming) byKey.set(keyOf(item), item);
  return [...byKey.values()]
    .sort((a, b) => timestampValue(a.time) - timestampValue(b.time))
    .slice(-browserChatLogLimit());
}

function mergePersistedConversationContext(
  existing?: BrowserChatConversationContext,
  incoming?: BrowserChatConversationContext,
) {
  if (!existing) return normalizeConversationContext(incoming);
  if (!incoming) return normalizeConversationContext(existing);
  return timestampValue(incoming.updatedAt) >= timestampValue(existing.updatedAt)
    ? normalizeConversationContext(incoming)
    : normalizeConversationContext(existing);
}

function mergePersistedSessionSnapshot(
  existing: BrowserChatSessionSnapshot | undefined,
  incoming: BrowserChatSessionSnapshot,
): BrowserChatSessionSnapshot {
  if (!existing) return incoming;
  const incomingNewer = timestampValue(incoming.updatedAt) >= timestampValue(existing.updatedAt);
  const base = incomingNewer ? { ...existing, ...incoming } : { ...incoming, ...existing };
  return {
    ...base,
    messages: mergePersistedMessages(existing.messages, incoming.messages),
    steps: mergePersistedSteps(existing.steps, incoming.steps),
    consoleErrors: mergeStringLists(existing.consoleErrors, incoming.consoleErrors),
    networkErrors: mergeStringLists(existing.networkErrors, incoming.networkErrors),
    logs: mergePersistedLogs(existing.logs, incoming.logs),
    conversationContext: mergePersistedConversationContext(existing.conversationContext, incoming.conversationContext),
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
    messages: mergePersistedMessages(fromDisk.messages, existing.messages),
    steps: mergePersistedSteps(fromDisk.steps, existing.steps),
    consoleErrors: mergeStringLists(fromDisk.consoleErrors, existing.consoleErrors),
    networkErrors: mergeStringLists(fromDisk.networkErrors, existing.networkErrors),
    logs: mergePersistedLogs(fromDisk.logs, existing.logs),
    conversationContext: mergePersistedConversationContext(fromDisk.conversationContext, existing.conversationContext),
    pendingToolConfirmation: existing.pendingToolConfirmation || fromDisk.pendingToolConfirmation,
  };
}

function applyPersistedSnapshotToRuntime(persistedSnapshot: BrowserChatSessionSnapshot) {
  const existing = sessions.get(persistedSnapshot.id);
  if (!existing) {
    sessions.set(persistedSnapshot.id, recordFromSnapshot(persistedSnapshot));
    return;
  }
  // Deferred progress writes and immediate interruption both make the in-memory
  // record newer than SQLite for a short period. A GET during that window must
  // not revive an older running turn or replace its live AbortController.
  if (runtimeSnapshotIsNewer(existing.updatedAt, persistedSnapshot.updatedAt)) return;
  const preserveRuntimeTurn = shouldPreserveRuntimeTurn(existing, persistedSnapshot);
  const fromDisk = mergeRuntimeSessionState(
    recordFromSnapshot(persistedSnapshot, { preserveRunningState: preserveRuntimeTurn }),
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
  const persisted = readSessionSnapshot(sessionId);
  if (persisted) applyPersistedSnapshotToRuntime(persisted);
  return sessions.get(sessionId);
}

function persistSession(sessionId: string, options: { mergePersisted?: boolean } = {}) {
  try {
    const currentSession = sessions.get(sessionId);
    const incoming = currentSession ? snapshot(currentSession, { fullSteps: true }) : undefined;
    if (!incoming) {
      deleteSessionSnapshot(sessionId);
      return true;
    }
    const persistedSnapshot = options.mergePersisted === false ? undefined : readSessionSnapshot(sessionId);
    const writtenSnapshot = options.mergePersisted === false
      ? incoming
      : mergePersistedSessionSnapshot(persistedSnapshot, incoming);
    writeSessionSnapshot(writtenSnapshot, { mergePersisted: options.mergePersisted });
    if (options.mergePersisted !== false) applyPersistedSnapshotToRuntime(writtenSnapshot);
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
    persistAndNotify(sessionId, { mergePersisted: false });
  }, browserChatProgressPersistDelayMs());
  pendingPersistTimers.set(sessionId, timer);
}

function persistInterruptedSessionInBackground(sessionId: string) {
  setTimeout(() => {
    if (persistAndNotify(sessionId, { mergePersisted: false })) return;
    schedulePersistAndNotify(sessionId);
  }, 0);
}

function persistAndNotify(sessionId: string, options: { defer?: boolean; mergePersisted?: boolean } = {}) {
  if (options.defer) {
    schedulePersistAndNotify(sessionId);
    return true;
  }
  clearPendingPersist(sessionId);
  const persisted = persistSession(sessionId, { mergePersisted: options.mergePersisted });
  if (!persisted) return false;
  notifySessionUpdate(sessionId);
  return true;
}

function persistDeletedSessions(sessionIds: string[]) {
  try {
    for (const sessionId of new Set(sessionIds.filter(Boolean))) {
      deleteSessionSnapshot(sessionId);
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

type BrowserChatTurnGuard = () => void;
type BrowserChatStartOptions = {
  markSessionRunning?: boolean;
  preferExistingPage?: boolean;
};

async function ensureStarted(
  session: BrowserChatSessionRecord,
  assertTurnActive?: BrowserChatTurnGuard,
  options: BrowserChatStartOptions = {},
) {
  assertTurnActive?.();
  const existing = browserStartPromises.get(session.id);
  if (existing) {
    const browser = await existing;
    assertTurnActive?.();
    return browser;
  }
  const startPromise = ensureStartedNow(session, assertTurnActive, options);
  browserStartPromises.set(session.id, startPromise);
  try {
    return await startPromise;
  } finally {
    if (browserStartPromises.get(session.id) === startPromise) browserStartPromises.delete(session.id);
  }
}

function createBrowserChatBrowser(session: BrowserChatSessionRecord, preferExistingPage = false) {
  return new BrowserSession(session.mode, {
    browserSurface: 'electron-embedded',
    browserProfileKey: browserChatBrowserProfileKey(session),
    ...browserChatBrowserExecutionOptions(),
    isMarked: true,
    preferExistingPage,
    runId: session.id,
  });
}

function restoreBrowserSessionPrototype(browser?: BrowserSession) {
  if (browser && Object.getPrototypeOf(browser) !== BrowserSession.prototype) {
    Object.setPrototypeOf(browser, BrowserSession.prototype);
  }
  return browser;
}

async function browserForTurnDecision(
  session: BrowserChatSessionRecord,
  assertTurnActive?: BrowserChatTurnGuard,
  options: BrowserChatStartOptions = {},
) {
  assertTurnActive?.();
  restoreBrowserSessionPrototype(session.browser);
  if (session.browser && session.started && !session.browser.isUsable()) {
    assertTurnActive?.();
    appendLog(session, 'browser:stale', '历史对话的浏览器已关闭或页面已失效，正在重新接管本会话。');
    await session.browser.close({ keepOpen: true }).catch(() => undefined);
    assertTurnActive?.();
    session.browser = undefined;
    session.started = false;
    session.updatedAt = now();
    persistAndNotify(session.id);
  }
  assertTurnActive?.();
  if (!session.browser) session.browser = createBrowserChatBrowser(session, options.preferExistingPage);
  return session.browser;
}

async function ensureStartedNow(
  session: BrowserChatSessionRecord,
  assertTurnActive?: BrowserChatTurnGuard,
  options: BrowserChatStartOptions = {},
) {
  assertTurnActive?.();
  const browser = await browserForTurnDecision(session, assertTurnActive, options);
  assertTurnActive?.();
  if (session.started && browser.isUsable()) {
    appendLog(session, 'browser:reuse', '复用当前会话已有浏览器标签');
    return browser;
  }
  assertTurnActive?.();
  store.applyRuntimeEnv();
  const startedAt = Date.now();
  appendLog(session, 'browser:start', '正在启动或连接浏览器');
  const hasPriorConversation = session.steps.length > 0
    || session.messages.some((message) => message.role === 'assistant' && message.id !== session.activeAssistantMessageId);
  session.browser = browser;
  if (options.markSessionRunning !== false) session.status = 'running';
  session.updatedAt = now();
  persistAndNotify(session.id);
  try {
    await browser.start();
    assertTurnActive?.();
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
    assertTurnActive?.();
    const openStartedAt = Date.now();
    session.targetUrl = url;
    appendLog(session, 'browser:open', `正在打开目标地址：${url}`);
    await browser.open(url);
    assertTurnActive?.();
    appendLog(session, 'browser:url-ready', `目标地址已打开，用时 ${elapsedMs(openStartedAt)}ms`, { elapsedMs: elapsedMs(openStartedAt) });
  } else if (url) {
    session.targetUrl = url;
  }
  session.status = 'idle';
  session.updatedAt = now();
  persistAndNotify(session.id);
  return browser;
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
    userId: normalizeUserId(input.userId),
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
  return snapshot(session);
}

export function getBrowserChatSession(sessionId: string, userId?: string | number) {
  const session = hydrateSession(sessionId);
  if (session && !sessionBelongsToUser(session, userId)) return undefined;
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
  const summaries = new Map(readSessionSummaries().map((session) => [session.id, session]));
  for (const session of sessions.values()) summaries.set(session.id, summarySnapshot(session));
  return [...summaries.values()]
    .filter((session) => sessionBelongsToUser(session, input.userId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function closeBlockedBrowserChatSubagents(
  sessionId: string,
  assistantMessageId?: string,
  options: { force?: boolean } = {},
) {
  const matches = [...blockedSubagents.entries()].filter(([, binding]) => (
    binding.sessionId === sessionId
    && (!assistantMessageId || binding.assistantMessageId === assistantMessageId)
  ));
  for (const [id] of matches) blockedSubagents.delete(id);
  await Promise.all(matches.map(([, binding]) => binding.browser.close(options).catch(() => undefined)));
}

async function stopBrowserChatRuntime(session: BrowserChatSessionRecord, reason: Error) {
  if (session.activeAbortController && !session.activeAbortController.signal.aborted) {
    session.activeAbortController.abort(reason);
  }
  cancelPendingToolConfirmation(session);

  // Block new preview/message work before waiting for a browser launch that is
  // already in flight. The completed launch is then closed below as well.
  session.status = 'closed';
  session.busy = false;

  const browsers = new Set<BrowserSession>();
  const rememberBrowser = (browser?: BrowserSession) => {
    const restored = restoreBrowserSessionPrototype(browser);
    if (restored) browsers.add(restored);
  };
  rememberBrowser(session.browser);

  const pendingStart = browserStartPromises.get(session.id);
  if (pendingStart) {
    rememberBrowser(await pendingStart.catch(() => undefined));
  }
  rememberBrowser(session.browser);

  session.browser = undefined;
  session.started = false;
  session.activeAbortController = undefined;
  session.activeAssistantMessageId = undefined;
  session.pendingToolConfirmation = undefined;

  await Promise.all([...browsers].map((browser) => (
    browser.close({ force: true }).catch(() => undefined)
  )));
  await closeBlockedBrowserChatSubagents(session.id, undefined, { force: true });
}

function preserveInterruptedSubagents(sessionId: string, assistantMessageId?: string) {
  const registry = subagentResults.get(sessionId);
  if (!registry) return;
  for (const record of registry.values()) {
    if (record.status !== 'running' || (assistantMessageId && record.assistantMessageId !== assistantMessageId)) continue;
    updateBrowserChatStoredSubagent(sessionId, record.uuid, {
      status: 'blocked',
      error: '用户已中止主对话；该子 Agent 已停止，已保留此前结果。',
    });
  }
}

export async function closeBrowserChatSession(sessionId: string, userId?: string | number) {
  const session = hydrateSession(sessionId);
  if (!session) return undefined;
  if (!sessionBelongsToUser(session, userId)) return undefined;
  await stopBrowserChatRuntime(session, new Error('Browser chat session closed by user.'));
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
    throw new Error('Browser chat session was removed from memory, but the database could not be updated.');
  }
  return removed.deleted;
}

export async function switchBrowserChatTab(sessionId: string, tabId: string, userId?: string | number) {
  const session = hydrateSession(sessionId);
  if (!session || session.status === 'closed') return undefined;
  if (!sessionBelongsToUser(session, userId)) return undefined;
  const normalizedTabId = String(tabId || '').trim();
  if (!normalizedTabId) throw new Error('Invalid tab id');

  const browser = restoreBrowserSessionPrototype(session.browser);
  if (!session.started || !browser || !browser.isUsable()) {
    throw new Error('当前会话还没有运行中的浏览器，无法切换标签页。');
  }
  const result = await browser.switchLivePreviewTab(normalizedTabId);
  if (!result?.ok) {
    throw new Error(`Switch tab failed: ${result?.actual || 'Unknown error'}`);
  }

  session.tabs = await browser.refreshTabsSnapshot();
  session.targetUrl = exportableTargetUrl(browser.currentUrl()) || session.targetUrl;
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

  const hasBrowserRuntimeHistory = session.logs.some((log) => log.phase.startsWith('browser:'));
  let browser = restoreBrowserSessionPrototype(session.browser);
  if (
    browser
    && session.started
    && browser.isUsable()
    && !session.busy
    && session.status !== 'running'
    && hasBrowserRuntimeHistory
    && !browser.hasNonBlankActivePage()
  ) {
    const stalePreviewBrowser = browser;
    // Detach synchronously before awaiting close. Otherwise a newly started
    // conversation can capture this instance while close() is pending and then
    // fail the browser-identity guard when the preview creates a replacement.
    if (
      session.browser === stalePreviewBrowser
      && !session.busy
      && !session.activeAssistantMessageId
    ) {
      session.browser = undefined;
      session.started = false;
      browser = undefined;
      await stalePreviewBrowser.close({ keepOpen: true }).catch(() => undefined);
    }
  }
  if (!browser || !session.started || !browser.isUsable()) {
    if (!hasBrowserRuntimeHistory) {
      throw new Error('当前会话还没有运行中的浏览器；请先发送AI访问请求，浏览器启动后会自动显示画面。');
    }
    browser = await ensureStarted(session, undefined, {
      markSessionRunning: false,
      preferExistingPage: true,
    });
  }
  if (!browser.isUsable()) {
    throw new Error('无法重新接管当前会话的浏览器，请确认浏览器窗口仍然存在。');
  }
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

export async function dispatchBrowserChatPreviewInput(
  sessionId: string,
  userId: string | number | undefined,
  input: BrowserLiveInput,
) {
  const session = hydrateSession(sessionId);
  if (!session || session.status === 'closed') return undefined;
  if (!sessionBelongsToUser(session, userId)) return undefined;
  const browser = restoreBrowserSessionPrototype(session.browser);
  if (!session.started || !browser || !browser.isUsable()) {
    throw new Error('当前会话还没有运行中的浏览器，无法操作实时界面。');
  }

  const result = await browser.dispatchLiveInput(input);
  session.tabs = browser.getTabsSnapshot();
  session.targetUrl = exportableTargetUrl(browser.currentUrl()) || session.targetUrl;
  return result;
}

async function deleteBrowserChatSessionFromMemory(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  await stopBrowserChatRuntime(session, new Error('Browser chat session deleted by user.'));
  sessions.delete(sessionId);
  subagentResults.delete(sessionId);
  return { deleted: { id: sessionId }, session };
}

function flowInputRecord(input: unknown) {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
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
    const persisted = persistDeletedSessions(removed.map((item) => item.deleted.id));
    if (!persisted) {
      for (const item of removed) sessions.set(item.deleted.id, item.session);
      throw new Error('Browser chat sessions were removed from memory, but the database could not be updated.');
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

export function exportBrowserChatMessageToTestCase(sessionId: string, messageId: string, userId?: string | number) {
  const session = hydrateSession(sessionId);
  if (!session || !sessionBelongsToUser(session, userId)) throw new Error('Browser chat session not found');
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
        operation: testOperationFromToolName(firstTool?.name, firstTool?.input),
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

export function exportBrowserChatMessagesToTestCase(sessionId: string, messageIds: string[], userId?: string | number) {
  const session = hydrateSession(sessionId);
  if (!session || !sessionBelongsToUser(session, userId)) throw new Error('Browser chat session not found');
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

export async function generateBrowserChatMessagesSkill(sessionId: string, messageIds: string[], userId?: string | number) {
  const session = hydrateSession(sessionId);
  if (!session || !sessionBelongsToUser(session, userId)) throw new Error('Browser chat session not found');
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
    domains: generated.domains,
    tags: generated.tags,
    triggerPhrases: generated.triggerPhrases,
    content: generated.content,
    sourceSessionId: session.id,
    status: 'ready',
  });
  return { skill, sourceMessageIds: uniqueMessageIds };
}

export async function generateBrowserChatMessageSkill(sessionId: string, messageId: string, userId?: string | number) {
  return generateBrowserChatMessagesSkill(sessionId, [messageId], userId);
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
  if (firstUserMessage) session.title = browserChatFirstMessageTitle(messageText, attachments);

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
  assistantMessage.activity = {
    phase: 'chat:queued',
    label: '已收到消息，准备执行对话与浏览器操作',
    updatedAt: timestamp,
  };
  persistAndNotify(session.id);
  appendLog(session, 'chat:queued', '已收到消息，统一对话 Agent 正在处理', { messageId: assistantMessage.id });
  void runBrowserChatMessage(
    session,
    messageText,
    modelMessageText,
    userMessage.id,
    assistantMessage.id,
    fromStepIndex,
    abortController,
    attachments,
    selectedSkills,
  );
  return snapshot(session);
}

function latestManualVerificationAssistant(session: BrowserChatSessionRecord) {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message.role !== 'assistant' || message.status !== 'blocked') continue;
    const stepIndexes = new Set(message.stepIndexes || []);
    const waiting = session.steps.some((step) => stepIndexes.has(step.index) && (step.tools || []).some((tool) => tool.name === 'waitForHumanVerification'));
    if (waiting) return { message, messageIndex: index };
  }
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message.role !== 'assistant') continue;
    const subagent = [...blockedSubagents.values()].find((item) => (
      item.sessionId === session.id && item.assistantMessageId === message.id
    ));
    if (subagent) return { message, messageIndex: index, subagent };
  }
  return undefined;
}

export function resumeBrowserChatHumanVerification(sessionId: string, userId?: string | number) {
  const session = hydrateSession(sessionId);
  if (!session || !sessionBelongsToUser(session, userId)) throw new Error('Browser chat session not found');
  if (session.status === 'closed') throw new Error('Browser chat session is closed');
  if (session.busy) throw new Error('Browser chat session is already running');
  const paused = latestManualVerificationAssistant(session);
  if (!paused) throw new Error('当前对话没有等待人工校验的 AI 回合');
  let userMessage: BrowserChatMessage | undefined;
  for (let index = paused.messageIndex - 1; index >= 0; index -= 1) {
    if (session.messages[index].role === 'user') {
      userMessage = session.messages[index];
      break;
    }
  }
  if (!userMessage) throw new Error('无法找到当前 AI 回合对应的用户请求');

  const timestamp = now();
  const abortController = new AbortController();
  interruptedAssistantMessageIds.delete(paused.message.id);
  session.activeAssistantMessageId = paused.message.id;
  session.activeAbortController = abortController;
  session.busy = true;
  session.status = 'running';
  session.error = undefined;
  updateAssistantMessage(session, paused.message.id, (message) => ({
    ...message,
    content: '',
    status: 'running',
    activity: { phase: 'chat:verification:resume', label: '校验已完成，正在从当前页面继续执行', updatedAt: timestamp },
    updatedAt: timestamp,
  }));
  appendLog(session, 'chat:verification:resume', '用户点击“校验完成”，继续当前 AI 执行回合', {
    messageId: paused.message.id,
  });
  session.updatedAt = timestamp;
  persistAndNotify(session.id);

  const instruction = [
    userMessage.content,
    '[系统续跑] 用户已在可见浏览器中完成人工校验。立即读取当前页面的最新状态，从暂停点继续原任务；不要要求用户再发送文字。',
  ].join('\n\n');
  const fromStepIndex = Math.max(0, ...session.steps.map((step) => step.index)) + 1;
  if (paused.subagent) {
    void resumeBlockedBrowserChatSubagent({
      session,
      binding: paused.subagent,
      userMessage,
      assistantMessageId: paused.message.id,
      fromStepIndex,
      abortController,
    });
  } else {
    void runBrowserChatMessage(
      session,
      instruction,
      instruction,
      userMessage.id,
      paused.message.id,
      fromStepIndex,
      abortController,
      [],
      [],
    );
  }
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

  // Revoke ownership before dispatching abort. Abort listeners may settle on a
  // later microtask, but every stale callback is rejected immediately by
  // isActiveBrowserChatTurn and can no longer write into this session.
  markAssistantMessageInterrupted(assistantMessageId);
  cancelPendingToolConfirmation(session);
  const interruptedRuntime = revokeBrowserChatTurn(
    session,
    timestamp,
    new Error('Browser chat operation interrupted by user.'),
  );
  preserveInterruptedTurn(session, assistantMessageId, timestamp);
  preserveInterruptedSubagents(session.id, assistantMessageId);
  void closeBlockedBrowserChatSubagents(session.id, assistantMessageId);

  session.logs = trimBrowserChatLogs([
    ...(session.logs || []),
    {
      id: id('log'),
      time: timestamp,
      phase: 'chat:interrupt:completed',
      message: '已立即撤销当前回合并向正在执行的请求发送中止信号。',
      details: safeJson({ assistantMessageId, abortDispatched: interruptedRuntime.abortDispatched }),
    },
  ]);

  // The stop response must never wait for the old AI/browser request. Persist
  // this finalized snapshot immediately after the response; if SQLite is
  // briefly unavailable, keep retrying the current in-memory snapshot.
  persistInterruptedSessionInBackground(session.id);
  return snapshot(session);
}

async function runBrowserChatSubagents(input: {
  session: BrowserChatSessionRecord;
  assistantMessageId: string;
  abortController: AbortController;
  tasks: BrowserChatSubagentTask[];
  toolCallId?: string;
}): Promise<BrowserActionResult> {
  const requestedTasks = input.tasks.slice(0, 6);
  const normalizedTasks = requestedTasks.map((task) => ({
    title: task.title.replace(/\s+/g, ' ').trim(),
    instruction: task.instruction.replace(/\s+/g, ' ').trim(),
    url: task.url?.trim().toLowerCase() || '',
  }));
  const key = `${input.session.id}:${input.assistantMessageId}:${JSON.stringify(normalizedTasks)}`;
  return runOrReuseBrowserChatSubagentBatch(key, () => executeBrowserChatSubagentBatch({
    ...input,
    tasks: requestedTasks,
  }));
}

function browserChatSubagentSessionRegistry(sessionId: string) {
  let registry = subagentResults.get(sessionId);
  if (!registry) {
    registry = new Map<string, BrowserChatStoredSubagent>();
    subagentResults.set(sessionId, registry);
  }
  return registry;
}

function updateBrowserChatStoredSubagent(
  sessionId: string,
  uuid: string,
  update: Partial<Pick<BrowserChatStoredSubagent, 'status' | 'summary' | 'summaryChars' | 'summaryOriginalChars' | 'summaryTruncated' | 'steps' | 'events' | 'error'>>,
) {
  const record = browserChatSubagentSessionRegistry(sessionId).get(uuid);
  if (!record) return;
  Object.assign(record, update, { updatedAt: now() });
}

function readBrowserChatSubagent(sessionId: string): BrowserChatSubagentReader {
  return async (uuid) => {
    const registry = subagentResults.get(sessionId);
    const record = registry?.get(uuid);
    if (!record) {
      return {
        ok: false,
        actual: JSON.stringify({
          uuid,
          status: 'not_found',
          error: '该子 Agent 不属于当前对话，或所属对话已被删除。',
        }),
      };
    }
    if (record.status === 'running') {
      return {
        ok: false,
        actual: JSON.stringify({
          uuid: record.uuid,
          title: record.title,
          status: record.status,
          error: '该子 Agent 仍在执行中；subagent action=spawn 的批次屏障尚未完成。',
        }),
      };
    }
    return {
      ok: true,
      actual: JSON.stringify({
        uuid: record.uuid,
        title: record.title,
        status: record.status,
        summary: record.summary,
        summaryChars: record.summaryChars,
        summaryOriginalChars: record.summaryOriginalChars,
        summaryTruncated: false,
        partial: record.status === 'failed' && Boolean(record.summary),
        error: record.error,
      }),
    };
  };
}

async function executeBrowserChatSubagentBatch(input: {
  session: BrowserChatSessionRecord;
  assistantMessageId: string;
  abortController: AbortController;
  tasks: BrowserChatSubagentTask[];
  toolCallId?: string;
}): Promise<BrowserActionResult> {
  const { session, assistantMessageId, abortController } = input;
  const batchId = input.toolCallId || id('subagent_batch');
  const requestedTasks = input.tasks.slice(0, 6);
  const ownsTurn = () => isActiveBrowserChatTurn(session, assistantMessageId, abortController);
  const tasks = requestedTasks.map((task) => ({ ...task, id: randomUUID() }));
  const registry = browserChatSubagentSessionRegistry(session.id);
  const createdAt = now();
  tasks.forEach((task, index) => {
    registry.set(task.id, {
      uuid: task.id,
      batchId,
      sessionId: session.id,
      assistantMessageId,
      index,
      title: task.title,
      task: { title: task.title, instruction: task.instruction, url: task.url },
      status: 'running',
      summary: '',
      summaryChars: 0,
      summaryOriginalChars: 0,
      summaryTruncated: false,
      steps: [],
      events: [],
      createdAt,
      updatedAt: createdAt,
    });
  });
  appendLog(session, 'subagents:start', `正在并行执行 ${tasks.length} 个子 Agent；单个分支失败不会中止其他分支`, {
    details: fullLogDetails({ batchId, requestedTasks, tasks }),
    messageId: assistantMessageId,
  });
  persistAndNotify(session.id);
  let confirmationQueue = Promise.resolve();
  const requestSerialConfirmation = async (request: BrowserToolConfirmationRequest) => {
    const previous = confirmationQueue;
    let release!: () => void;
    confirmationQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await requestBrowserChatToolConfirmation(session, assistantMessageId, request, abortController.signal);
    } finally {
      release();
    }
  };

  const inheritedStorageState = session.browser?.isUsable()
    ? await session.browser.exportStorageState().catch(() => undefined)
    : undefined;
  const summaryGuidanceChars = browserChatSubagentSuggestedSummaryChars();

  const settled = await settleBrowserChatSubagents(tasks, async (task, index) => {
    if (!ownsTurn()) throw abortController.signal.reason || new Error('对话已中断');
    appendLog(session, `subagent:${task.id}:start`, `子 Agent ${index + 1} 已启动：${task.title}`, {
      details: { batchId, id: task.id, index, title: task.title, instruction: task.instruction, url: task.url, status: 'running' },
      messageId: assistantMessageId,
    });
    persistAndNotify(session.id);
    const child = new BrowserSession(session.mode, {
      browserSurface: 'external',
      headless: true,
      sharedBrowserRuntimeKey: applicationUserRuntimeKey(session.userId),
      storageState: inheritedStorageState,
      ...browserChatBrowserExecutionOptions(),
      isMarked: true,
      preferExistingPage: false,
      runId: `${session.id}_${task.id}`,
    });
    const childSteps = new Map<number, StepExecutionResult>();
    let latestChildText = '';
    try {
      await child.start();
      if (task.url) await child.open(task.url);
      const getRuntimeOperationalContext = createBrowserChatRuntimeOperationalContext({
        session,
        browser: child,
        instruction: task.instruction,
      });
      const initialRuntimeContext = getRuntimeOperationalContext();
      const result = await executeInteractiveBrowserTurn({
        session: child,
        runId: `${session.id}_${task.id}`,
        targetUrl: task.url || session.targetUrl || child.currentUrl() || 'about:blank',
        instruction: task.instruction,
        modelInstruction: [
          `你是并行子 Agent“${task.title}”。只完成这个独立分支，并返回可追溯事实、来源地址、页面证据、失败原因和未解决问题。`,
          '你拥有完整浏览器工具集。不要等待其他子 Agent，也不要因为其他分支失败而停止。',
          inheritedStorageState
            ? '无头浏览器已经复制主会话当前的 Cookie、localStorage 和 IndexedDB 登录态。请先直接访问目标地址验证登录态，不要重新登录。'
            : '主会话当前没有可复制的浏览器登录态；如果目标页面要求登录，请明确返回登录阻塞，不要猜测页面内容。',
          '你运行在无头浏览器中。遇到必须由用户处理的验证码、扫码、OTP 或设备确认时，不要等待用户操作隐藏页面；请明确报告阻塞证据并把该步骤交回主 Agent。',
          'domChanges.overflow 只表示 MutationObserver 变更队列容量溢出，绝不表示页面下方还有内容。不得因此滚动页面，也不得把“滚动到底部”写入任何任务。只有已经发现明确的懒加载、虚拟列表或无限滚动证据，且目标内容不在 full/text 完整 DOM 中时，才允许滚动。',
          'inspect action=capture 的 full 与 text 都读取已加载页面的完整 DOM；text 是 full 中全部文本的去重阅读视图，不是当前视窗。nextCursor 只是冻结结果的字符分页，不得为分页而滚动。',
          summaryGuidanceChars
            ? `完成工具执行后，直接在你自己的最终回复中写出信息完整、可独立使用的执行总结。配置建议将篇幅控制在约 ${summaryGuidanceChars} 个字符以内，但这不是截断上限；如果完整证据需要更长内容，必须完整返回。优先覆盖来源 URL、已验证事实、字段和表格、图片与 iframe 信息、失败步骤、限制、未读取区域和未解决项；不要为凑字数重复内容。不要再启动子 Agent，也不要要求主 Agent 另行读取结果。`
            : '完成工具执行后，直接在你自己的最终回复中写出信息完整、可独立使用的执行总结。优先覆盖来源 URL、已验证事实、字段和表格、图片与 iframe 信息、失败步骤、限制、未读取区域和未解决项；不要为凑字数重复内容。不要再启动子 Agent，也不要要求主 Agent 另行读取结果。',
          task.instruction,
        ].join('\n\n'),
        operationalContext: initialRuntimeContext.operationalContext,
        conversation: [],
        completedSteps: [],
        mode: session.mode,
        safetyMode: session.safetyMode,
        resolveCredential: initialRuntimeContext.resolveCredential,
        credentialAllowedOrigins: initialRuntimeContext.credentialAllowedOrigins,
        getRuntimeOperationalContext,
        abortSignal: abortController.signal,
        shouldContinue: ownsTurn,
        requestToolConfirmation: session.safetyMode === 'strict'
          ? requestSerialConfirmation
          : undefined,
        onProgress: (step) => {
          if (!ownsTurn()) return;
          childSteps.set(step.index, step);
          updateBrowserChatStoredSubagent(session.id, task.id, {
            status: step.status === 'queued' ? 'running' : step.status,
            steps: [...childSteps.values()].sort((left, right) => left.index - right.index),
          });
          appendLog(session, `subagent:${task.id}:progress`, `${task.title}：${step.action || '正在执行'}`, {
            details: fullLogDetails({ batchId, id: task.id, index, title: task.title, status: step.status, step }),
            messageId: assistantMessageId,
          });
        },
        onDebug: (event) => {
          if (!ownsTurn()) return;
          const eventDetails = unwrapLogDetails(event.details).value;
          if (event.phase === 'ai:runtime:response' || event.phase === 'ai:runtime:object') {
            const eventRecord = eventDetails && typeof eventDetails === 'object' && !Array.isArray(eventDetails)
              ? eventDetails as Record<string, unknown>
              : undefined;
            const aiOutput = eventRecord?.aiOutput && typeof eventRecord.aiOutput === 'object' && !Array.isArray(eventRecord.aiOutput)
              ? eventRecord.aiOutput as Record<string, unknown>
              : undefined;
            const responseText = textFromUnknown(aiOutput?.response ?? aiOutput?.text);
            if (responseText.trim()) latestChildText = responseText;
          }
          const stored = registry.get(task.id);
          if (stored) {
            stored.events.push({ phase: event.phase, message: event.message, stepIndex: event.stepIndex, details: eventDetails });
            stored.updatedAt = now();
          }
          appendLog(session, `subagent:${task.id}:${event.phase}`, event.message, {
            stepIndex: event.stepIndex,
            elapsedMs: elapsedFromDetails(eventDetails),
            details: event.phase === 'ai:runtime:response' || event.phase === 'ai:runtime:object'
              ? fullLogDetails({ batchId, id: task.id, index, title: task.title, event: eventDetails })
              : { batchId, id: task.id, index, title: task.title, event: eventDetails },
            messageId: assistantMessageId,
            deferPersist: true,
          });
        },
      });
      if (!ownsTurn()) throw abortController.signal.reason || new Error('对话已中断');
      const summaryResult = preserveBrowserChatSubagentSummary(
        textFromUnknown(result.reply || result.newSteps.at(-1)?.actual || '子 Agent 已完成，但没有返回额外文本。'),
      );
      const summary = summaryResult.summary;
      const evidence = result.newSteps.map((step) => ({
        index: step.index,
        status: step.status,
        action: step.action,
        expected: step.expected,
        actual: step.actual,
        note: step.note,
        tools: (step.tools || []).map((tool) => ({
          name: tool.name,
          input: tool.input,
          reason: tool.reason,
          ok: tool.ok,
          recovered: tool.recovered,
          transient: tool.transient,
          result: tool.result,
        })),
      }));
      appendLog(session, `subagent:${task.id}:done`, `子 Agent ${index + 1} 已完成：${task.title}`, {
        details: fullLogDetails({
          batchId,
          id: task.id,
          index,
          title: task.title,
          status: result.status,
          ...summaryResult,
          resumable: false,
          steps: result.newSteps,
          stepCount: result.newSteps.length,
        }),
        messageId: assistantMessageId,
      });
      updateBrowserChatStoredSubagent(session.id, task.id, {
        status: result.status,
        ...summaryResult,
        steps: result.newSteps,
      });
      persistAndNotify(session.id);
      return { id: task.id, title: task.title, task, status: result.status, summary, content: summary, evidence };
    } catch (error) {
      if (!ownsTurn()) throw error;
      const message = userFacingErrorMessage(error);
      const steps = [...childSteps.values()].sort((left, right) => left.index - right.index);
      const partialSummaryResult = preserveBrowserChatSubagentSummary(
        latestChildText || steps.map((step) => step.actual).filter(Boolean).join('\n\n'),
      );
      const partialContent = partialSummaryResult.summary;
      const evidence = steps.map((step) => ({
        index: step.index,
        status: step.status,
        action: step.action,
        expected: step.expected,
        actual: step.actual,
        note: step.note,
        tools: (step.tools || []).map((tool) => ({
          name: tool.name,
          input: tool.input,
          reason: tool.reason,
          ok: tool.ok,
          recovered: tool.recovered,
          transient: tool.transient,
          result: tool.result,
        })),
      }));
      appendLog(session, `subagent:${task.id}:failed`, `子 Agent ${index + 1} 失败，其他分支继续：${task.title}`, {
        details: fullLogDetails({
          batchId,
          id: task.id,
          index,
          title: task.title,
          status: 'failed',
          error: message,
          ...partialSummaryResult,
          partial: Boolean(partialContent || evidence.length),
          steps,
        }),
        messageId: assistantMessageId,
      });
      updateBrowserChatStoredSubagent(session.id, task.id, {
        status: 'failed',
        ...partialSummaryResult,
        steps,
        error: message,
      });
      persistAndNotify(session.id);
      return {
        id: task.id,
        title: task.title,
        task,
        status: 'failed' as const,
        error: message,
        partial: Boolean(partialContent || evidence.length),
        summary: partialContent,
        content: partialContent,
        evidence,
      };
    } finally {
      await child.close().catch(() => undefined);
    }
  });

  if (!ownsTurn()) throw abortController.signal.reason || new Error('对话已中断');
  const results = settled.map((settledResult, index) => {
    const task = settledResult.task;
    if (settledResult.result) return settledResult.result;
    const error = userFacingErrorMessage(settledResult.error);
    void index;
    updateBrowserChatStoredSubagent(session.id, task.id, { status: 'failed', error });
    return { id: task.id, title: task.title, task, status: 'failed' as const, error };
  });
  persistAndNotify(session.id);
  const completedCount = results.filter((item) => item.status !== 'failed').length;
  const partialCount = results.filter((item) => item.status === 'failed' && 'partial' in item && item.partial === true).length;
  return {
    ok: true,
    actual: JSON.stringify({
      subagents: results.map((result, index) => ({
        uuid: result.id,
        index,
        title: result.title,
        status: result.status,
      })),
      summary: `${completedCount}/${results.length} 个子 Agent 完成，${partialCount} 个失败分支保留了部分有效内容；任一失败均未中止其他分支。`,
      batchId,
      next: '使用 subagent({ action: "read", uuid }) 每次读取一个结果；如需读取其他结果，必须在后续模型步骤逐个调用。',
    }),
  };
}

async function resumeBlockedBrowserChatSubagent(input: {
  session: BrowserChatSessionRecord;
  binding: BrowserChatBlockedSubagentRuntime;
  userMessage: BrowserChatMessage;
  assistantMessageId: string;
  fromStepIndex: number;
  abortController: AbortController;
}) {
  const { session, binding, userMessage, assistantMessageId, fromStepIndex, abortController } = input;
  const ownsTurn = () => isActiveBrowserChatTurn(session, assistantMessageId, abortController);
  const getRuntimeOperationalContext = createBrowserChatRuntimeOperationalContext({
    session,
    browser: binding.browser,
    instruction: binding.task.instruction,
  });
  const initialRuntimeContext = getRuntimeOperationalContext();
  try {
    const result = await withModelSettings(browserChatModelSettings(session.modelProvider, session.model), () => executeInteractiveBrowserTurn({
      session: binding.browser,
      runId: `${session.id}_${binding.id}_verification_resume`,
      targetUrl: binding.task.url || binding.browser.currentUrl() || session.targetUrl || 'about:blank',
      instruction: `${binding.task.instruction}\n\n[系统续跑] 用户已完成当前可见页面的人工校验，请立即读取最新页面并从暂停点继续。`,
      modelInstruction: [
        `你是并行子 Agent“${binding.title}”，正在继续同一个已暂停的分支。`,
        '用户已点击“校验完成，继续执行”。不要要求用户再发送文字；先读取当前页面状态，再继续原任务。',
        binding.task.instruction,
      ].filter(Boolean).join('\n\n'),
      operationalContext: initialRuntimeContext.operationalContext,
      conversation: [],
      completedSteps: binding.steps,
      mode: session.mode,
      safetyMode: session.safetyMode,
      resolveCredential: initialRuntimeContext.resolveCredential,
      credentialAllowedOrigins: initialRuntimeContext.credentialAllowedOrigins,
      getRuntimeOperationalContext,
      abortSignal: abortController.signal,
      shouldContinue: ownsTurn,
      requestToolConfirmation: session.safetyMode === 'strict'
        ? (request) => requestBrowserChatToolConfirmation(session, assistantMessageId, request, abortController.signal)
        : undefined,
      onProgress: (step) => {
        if (!ownsTurn()) return;
        appendLog(session, `subagent:${binding.id}:progress`, `${binding.title}：${step.action || '正在继续'}`, {
          details: { id: binding.id, title: binding.title, status: step.status, step },
          messageId: assistantMessageId,
          deferPersist: true,
        });
      },
      onDebug: (event) => {
        if (!ownsTurn()) return;
        const eventDetails = unwrapLogDetails(event.details).value;
        appendLog(session, `subagent:${binding.id}:${event.phase}`, event.message, {
          stepIndex: event.stepIndex,
          elapsedMs: elapsedFromDetails(eventDetails),
          details: event.phase === 'ai:runtime:response' || event.phase === 'ai:runtime:object'
            ? fullLogDetails({ id: binding.id, title: binding.title, event: eventDetails })
            : { id: binding.id, title: binding.title, event: eventDetails },
          messageId: assistantMessageId,
          deferPersist: true,
        });
      },
    }));
    if (!ownsTurn()) return;
    const summary = textFromUnknown(result.reply || result.newSteps.at(-1)?.actual || '子 Agent 续跑完成。');
    appendLog(session, `subagent:${binding.id}:done`, `子 Agent 续跑完成：${binding.title}`, {
      details: fullLogDetails({
        id: binding.id,
        title: binding.title,
        status: result.status,
        summary,
        steps: result.newSteps,
        stepCount: result.newSteps.length,
      }),
      messageId: assistantMessageId,
    });
    binding.steps = result.steps;
    if (result.status === 'blocked') {
      const timestamp = now();
      updateAssistantMessage(session, assistantMessageId, (message) => ({
        ...message,
        content: summary,
        status: 'blocked',
        activity: undefined,
        updatedAt: timestamp,
      }));
      session.status = 'idle';
      session.busy = false;
      session.activeAssistantMessageId = undefined;
      session.activeAbortController = undefined;
      session.updatedAt = timestamp;
      persistAndNotify(session.id);
      return;
    }
    blockedSubagents.delete(binding.id);
    await binding.browser.close().catch(() => undefined);
    const continuation = [
      userMessage.content,
      `[系统续跑] 人工校验后，子 Agent“${binding.title}”已返回：\n${summary}`,
      '请在同一个对话回合中继续主任务，不要要求用户再发送文字。',
    ].join('\n\n');
    await runBrowserChatMessage(
      session,
      continuation,
      continuation,
      userMessage.id,
      assistantMessageId,
      fromStepIndex,
      abortController,
      [],
      [],
    );
  } catch (error) {
    if (!ownsTurn()) return;
    blockedSubagents.delete(binding.id);
    await binding.browser.close().catch(() => undefined);
    const timestamp = now();
    const message = userFacingErrorMessage(error);
    appendLog(session, `subagent:${binding.id}:failed`, `子 Agent 续跑失败：${binding.title}`, {
      details: { id: binding.id, title: binding.title, status: 'failed', error: message },
      messageId: assistantMessageId,
    });
    updateAssistantMessage(session, assistantMessageId, (assistant) => ({
      ...assistant,
      content: `人工校验后继续执行失败：${message}`,
      status: 'failed',
      activity: undefined,
      updatedAt: timestamp,
    }));
    session.error = message;
    session.status = 'error';
    session.busy = false;
    session.activeAssistantMessageId = undefined;
    session.activeAbortController = undefined;
    session.updatedAt = timestamp;
    persistAndNotify(session.id);
  }
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
    const assertTurnActive = () => {
      if (isActiveBrowserChatTurn(session, assistantMessageId, abortController)) return;
      throw abortController.signal.reason || new Error('Browser chat operation interrupted by user.');
    };
    try {
      assertTurnActive();
      appendLog(session, 'chat:run:start', '开始处理本轮对话操作');
      const browser = await browserForTurnDecision(session, assertTurnActive);
      assertTurnActive();
      await ensureConversationContextWithinThreshold(session, userMessageId, abortController.signal);
      if (!isActiveBrowserChatTurn(session, assistantMessageId, abortController)) return;
      const getRuntimeOperationalContext = createBrowserChatRuntimeOperationalContext({
        session,
        browser,
        instruction: modelText,
        explicitlySelectedSkills: skills,
      });
      const initialRuntimeContext = getRuntimeOperationalContext();
      appendLog(session, 'ai:prepare', '正在请求 AI 判断是否需要浏览器工具');
      const referenceImagePaths = attachments.map(attachmentAbsolutePath).filter((item): item is string => Boolean(item));
      const result = await executeInteractiveBrowserTurn({
        session: browser,
        runId: session.id,
        targetUrl: session.targetUrl || 'about:blank',
        instruction: text,
        modelInstruction: modelText,
        operationalContext: initialRuntimeContext.operationalContext,
        conversation: conversationForPrompt(session.messages, session.conversationContext, userMessageId),
        completedSteps: session.steps,
        mode: session.mode,
        safetyMode: session.safetyMode,
        referenceImagePaths,
        resolveCredential: initialRuntimeContext.resolveCredential,
        credentialAllowedOrigins: initialRuntimeContext.credentialAllowedOrigins,
        getRuntimeOperationalContext,
        abortSignal: abortController.signal,
        shouldContinue: () => isActiveBrowserChatTurn(session, assistantMessageId, abortController),
        requestToolConfirmation: session.safetyMode === 'strict'
          ? (request) => requestBrowserChatToolConfirmation(session, assistantMessageId, request, abortController.signal)
          : undefined,
        ensureBrowserStarted: async () => {
          assertTurnActive();
          const startedBrowser = await ensureStarted(session, assertTurnActive);
          assertTurnActive();
          if (startedBrowser !== browser) throw new Error('Browser session changed while the AI was deciding; retry this browser tool on the active session.');
        },
        isBrowserStarted: () => session.started && session.browser === browser && browser.isUsable(),
        runSubagents: (tasks, _abortSignal, toolCallId) => runBrowserChatSubagents({ session, assistantMessageId, abortController, tasks, toolCallId }),
        readSubagent: readBrowserChatSubagent(session.id),
        readFile: (input) => readFileForSession(session, input),
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
          // Tool traces arrive once before execution and again with the result.
          // Persist both edges synchronously so the UI first renders a running
          // card, then updates that same card to its completed/failed state.
          persistAndNotify(session.id, { mergePersisted: false });
        },
        onDebug: (event) => {
          if (!isActiveBrowserChatTurn(session, assistantMessageId, abortController)) return;
          const persistImmediately = event.phase === 'ai:runtime:request'
            || event.phase === 'ai:runtime:response'
            || event.phase === 'ai:tool';
          appendLog(session, event.phase, event.message, {
            stepIndex: event.stepIndex,
            elapsedMs: elapsedFromDetails(event.details),
            details: event.details,
            deferPersist: !persistImmediately,
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
      const browserWasStarted = session.started || browser.isUsable();
      const keepCompletedBrowser = browserWasStarted && browserChatKeepBrowserOpenAfterTurn() && Boolean(session.browser?.isUsable());
      const shouldCloseCompletedBrowser = browserWasStarted && !keepCompletedBrowser;
      if (shouldCloseCompletedBrowser) {
        await session.browser?.close({ keepOpen: true }).catch(() => undefined);
        session.browser = undefined;
        session.started = false;
      } else if (!browserWasStarted && session.browser === browser) {
        session.browser = undefined;
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
              : browserWasStarted
                ? '本轮对话操作已完成，最终结果已写入。'
                : '本轮对话已直接完成，没有创建浏览器标签。',
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
