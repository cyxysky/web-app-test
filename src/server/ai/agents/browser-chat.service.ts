import { createHash, randomUUID } from 'node:crypto';
import { generateText } from 'ai';
import { existsSync } from 'node:fs';
import { BrowserSession, type BrowserActionResult, type BrowserLiveInput, type BrowserScreencastFrame, type BrowserSessionMode, type BrowserTabSnapshot } from '@/server/browser/browser-session';
import type {
  BrowserCodeAttachmentBinding,
  BrowserCodeCredentialBinding,
} from '@/server/browser/browser-code-runner';
import { normalizeApplicationUserId } from '@/server/auth/user-context';
import { readBrowserDomainCookies } from '@/server/credentials/browser-domain-cookie-vault';
import { incrementMetric, structuredLog } from '@/server/observability/runtime-observability';
import { artifactContentType } from '@/server/files/file-format-registry';
import {
  executeInteractiveBrowserTurn,
  type BrowserToolConfirmationDecision,
  type BrowserToolConfirmationRequest,
  type BrowserChatReadFileInput,
  type BrowserChatSubagentReader,
  type BrowserChatSubagentTask,
  type InteractiveBrowserTurnMessage,
  type InteractiveBrowserTurnResult,
} from '@/server/ai/agents/browser-chat-executor.agent';
import { generateSkillFromBrowserHistory } from '@/server/ai/agents/skill-generator.agent';
import { browserChatAttachmentMetadata, isBrowserChatImageAttachment, readBrowserChatAttachment } from '@/server/ai/agents/browser-chat-attachment-reader';
import {
  normalizeBrowserChatAttachments,
  uploadedBrowserChatAttachmentPath,
  type BrowserChatAttachment,
} from '@/server/ai/agents/browser-chat-attachments';
import { browserChatFirstMessageTitle } from '@/server/ai/agents/browser-chat-message-title';
import {
  estimateRuntimeTextTokens,
  runtimeContextCompressionThresholdRatio,
  runtimeContextWindowTokens,
} from '@/server/ai/agents/runtime-context-budget';
import {
  alignBrowserChatMessageStepIndexes,
  attachBrowserChatStepOwners,
} from '@/server/ai/agents/browser-chat-step-ownership';
import {
  browserChatSubagentSuggestedSummaryChars,
  preserveBrowserChatSubagentSummary,
  runOrReuseBrowserChatSubagentBatch,
  settleBrowserChatSubagents,
} from '@/server/ai/agents/browser-chat-subagents';
import {
  clearRegisteredBrowserChatTurn,
  registerBrowserChatTurn,
  registeredBrowserChatTurnIsActive,
  revokeBrowserChatTurn,
  revokeRegisteredBrowserChatTurn,
  runtimeSnapshotIsNewer,
  type RegisteredBrowserChatTurn,
} from '@/server/ai/agents/browser-chat-interrupt-state';
import {
  normalizeBrowserChatTurnState,
  transitionBrowserChatSession,
  type BrowserChatTurnState,
} from '@/server/ai/agents/browser-chat-session-state';
import { formatSkillReferencesForUser, formatSkillsForPrompt, runtimeSkillsForUrl } from '@/server/ai/agents/skill-context';
import { isBrowserChatDomObservationText, normalizeBrowserChatFinalReplyText } from '@/server/ai/agents/browser-chat-reply-text';
import {
  extractPersonalMemoryFromTurn,
  formatPersonalMemoryForPrompt,
  markPersonalMemoryItemsUsed,
  normalizePersonalMemoryDomain,
  personalMemoryEnabled,
  searchPersonalMemory,
} from '@/server/ai/personal-memory';
import { createPersonalMemoryTools } from '@/server/ai/personal-memory-tools';
import { getModel, getModelSettings, withModelSettings } from '@/server/ai/model';
import { aiReasoningEffort, aiTelemetry } from '@/server/ai/ai-sdk-runtime';
import { compactBrowserChatLogsForClient } from '@/server/ai/agents/browser-chat-log-client';
import { browserChatAiOutputCycleFromDebugEvent } from '@/lib/browser-chat-output-cycles';
import type {
  BrowserChatAiOutputCycle,
  BrowserChatSubagentRecord,
  ModelProvider,
  SkillRecord,
  StepExecutionResult,
} from '@/server/ai/schemas/runtime.schema';
import { store } from '@/server/db/store';
import { publishRealtimeRefreshEvent } from '@/server/realtime/ws-refresh';
import { createLatestOnlyAsyncScheduler, type LatestOnlyAsyncScheduler } from '@/server/realtime/latest-only-async-scheduler';
import {
  deleteBrowserChatSessionRecordQueued,
  readBrowserChatSessionRecord,
  readBrowserChatSessionSummaries,
  writeBrowserChatSessionDeltaQueued,
} from '@/server/storage/sqlite-record-store';
import {
  browserChatHistoryLimit,
  readBrowserChatLogsPage,
  readBrowserChatMessagesPage,
  readBrowserChatSessionHeader,
  readBrowserChatSessionWindow,
  readBrowserChatStepsPage,
  type BrowserChatHistoryState,
} from '@/server/storage/browser-chat-history-store';
import {
  deleteBrowserChatArtifacts,
  enforceBrowserChatArtifactQuota,
  scheduleBrowserChatArtifactMaintenance,
} from '@/server/storage/browser-chat-artifact-lifecycle';
import { scheduleSqliteMaintenance } from '@/server/storage/sqlite-maintenance';
import {
  applyBrowserChatPersistenceDelta,
  collectBrowserChatPersistenceDelta,
  seedBrowserChatPersistenceCursor,
  type BrowserChatDirtyRecords as PersistenceDirtyRecords,
  type BrowserChatPersistenceCursor as PersistenceCursor,
} from './browser-chat-persistence-delta';
import { artifactApiUrlFromRelative } from '@/lib/artifacts';
import { normalizeModelProvider, resolveRuntimeModelSelection } from '@/lib/model-selection';
import {
  listLoginAccounts,
  resolveLoginAccountCredentialById,
  type LoginAccountMetadata,
} from '@/server/credentials/login-account-vault';

export type { BrowserChatAttachment } from '@/server/ai/agents/browser-chat-attachments';

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
  turnId?: string;
  attemptId?: string;
  toolCallId?: string;
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
  turnState?: BrowserChatTurnState;
  busy: boolean;
  tabs: BrowserTabSnapshot[];
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  error?: string;
  messages: BrowserChatMessage[];
  steps: StepExecutionResult[];
  outputCycles: BrowserChatAiOutputCycle[];
  subagents: BrowserChatSubagentRecord[];
  consoleErrors: string[];
  networkErrors: string[];
  logs: BrowserChatLogRecord[];
  conversationContext?: BrowserChatConversationContext;
  pendingToolConfirmation?: BrowserChatToolConfirmation;
};

export type BrowserChatSessionPage = BrowserChatSessionSnapshot & {
  history: BrowserChatHistoryState;
};

type BrowserChatSessionRecord = Omit<BrowserChatSessionSnapshot, 'turnState'> & {
  turnState: BrowserChatTurnState;
  activeAssistantMessageId?: string;
  activeAbortController?: AbortController;
  browser?: BrowserSession;
  started: boolean;
};

type BrowserChatPersistenceCursor = PersistenceCursor<BrowserChatMessage, StepExecutionResult, BrowserChatLogRecord>;
type BrowserChatDirtyRecords = PersistenceDirtyRecords<BrowserChatMessage, StepExecutionResult, BrowserChatLogRecord>;

export type BrowserChatSessionRealtimePatch = {
  session: Omit<BrowserChatSessionSnapshot, 'logs' | 'messages' | 'pendingToolConfirmation' | 'steps'> & {
    pendingToolConfirmation: BrowserChatToolConfirmation | null;
  };
  summary?: BrowserChatSessionSnapshot;
  logs?: BrowserChatLogRecord[];
  messages?: BrowserChatMessage[];
  steps?: StepExecutionResult[];
  removedLogIds?: string[];
  removedMessageIds?: string[];
  removedStepIndexes?: number[];
};

type BrowserChatActiveTurn = RegisteredBrowserChatTurn<BrowserChatSessionRecord>;

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

type BrowserChatMemoryExtractionJob = {
  key: string;
  run: () => Promise<void>;
  userId: string;
};

type BrowserChatRuntimeState = {
  sessions: Map<string, BrowserChatSessionRecord>;
  activeTurns: Map<string, BrowserChatActiveTurn>;
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
  streamPublisher?: LatestOnlyAsyncScheduler<string, string>;
  pendingSqliteWrites: Map<string, Promise<boolean>>;
  sessionEvictionTimers: Map<string, ReturnType<typeof setTimeout>>;
  persistenceCursors: Map<string, BrowserChatPersistenceCursor>;
  dirtyRecords: Map<string, BrowserChatDirtyRecords>;
  memoryExtractionActive: number;
  memoryExtractionActiveUsers: Set<string>;
  memoryExtractionKeys: Set<string>;
  memoryExtractionQueue: BrowserChatMemoryExtractionJob[];
  browserIdleEpochs: Map<string, number>;
  browserIdleTimers: Map<string, ReturnType<typeof setTimeout>>;
  browserPreviewCounts: Map<string, number>;
  lastPersistWarningAt: number;
};

const browserChatRuntimeState: BrowserChatRuntimeState = ((globalThis as typeof globalThis & {
  __browserChatRuntimeState?: BrowserChatRuntimeState;
}).__browserChatRuntimeState ??= {
  sessions: new Map<string, BrowserChatSessionRecord>(),
  activeTurns: new Map<string, BrowserChatActiveTurn>(),
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
  pendingSqliteWrites: new Map<string, Promise<boolean>>(),
  sessionEvictionTimers: new Map<string, ReturnType<typeof setTimeout>>(),
  persistenceCursors: new Map<string, BrowserChatPersistenceCursor>(),
  dirtyRecords: new Map<string, BrowserChatDirtyRecords>(),
  memoryExtractionActive: 0,
  memoryExtractionActiveUsers: new Set<string>(),
  memoryExtractionKeys: new Set<string>(),
  memoryExtractionQueue: [] as BrowserChatMemoryExtractionJob[],
  browserIdleEpochs: new Map<string, number>(),
  browserIdleTimers: new Map<string, ReturnType<typeof setTimeout>>(),
  browserPreviewCounts: new Map<string, number>(),
  lastPersistWarningAt: 0,
});
browserChatRuntimeState.sessions ??= new Map();
browserChatRuntimeState.activeTurns ??= new Map();
browserChatRuntimeState.browserStartPromises ??= new Map();
browserChatRuntimeState.blockedSubagents ??= new Map();
browserChatRuntimeState.subagentResults ??= new Map();
browserChatRuntimeState.interruptedAssistantMessageIds ??= new Set();
browserChatRuntimeState.toolConfirmations ??= new Map();
browserChatRuntimeState.pendingPersistTimers ??= new Map();
browserChatRuntimeState.pendingSqliteWrites ??= new Map();
browserChatRuntimeState.sessionEvictionTimers ??= new Map();
browserChatRuntimeState.persistenceCursors ??= new Map();
browserChatRuntimeState.dirtyRecords ??= new Map();
browserChatRuntimeState.memoryExtractionActive ??= 0;
browserChatRuntimeState.memoryExtractionActiveUsers ??= new Set();
browserChatRuntimeState.memoryExtractionKeys ??= new Set();
browserChatRuntimeState.memoryExtractionQueue ??= [];
browserChatRuntimeState.browserIdleEpochs ??= new Map();
browserChatRuntimeState.browserIdleTimers ??= new Map();
browserChatRuntimeState.browserPreviewCounts ??= new Map();

const sessions = browserChatRuntimeState.sessions;
const activeTurns = browserChatRuntimeState.activeTurns;
const browserStartPromises = browserChatRuntimeState.browserStartPromises;
const blockedSubagents = browserChatRuntimeState.blockedSubagents;
const subagentResults = browserChatRuntimeState.subagentResults;
const interruptedAssistantMessageIds = browserChatRuntimeState.interruptedAssistantMessageIds;
const toolConfirmations = browserChatRuntimeState.toolConfirmations;
const pendingPersistTimers = browserChatRuntimeState.pendingPersistTimers;
const pendingSqliteWrites = browserChatRuntimeState.pendingSqliteWrites;
const sessionEvictionTimers = browserChatRuntimeState.sessionEvictionTimers;
const persistenceCursors = browserChatRuntimeState.persistenceCursors;
const dirtyRecords = browserChatRuntimeState.dirtyRecords;
const browserIdleEpochs = browserChatRuntimeState.browserIdleEpochs;
const browserIdleTimers = browserChatRuntimeState.browserIdleTimers;
const browserPreviewCounts = browserChatRuntimeState.browserPreviewCounts;

scheduleBrowserChatArtifactMaintenance(() => (
  readBrowserChatSessionSummaries<BrowserChatSessionSnapshot>().map((session) => session.id)
));
scheduleSqliteMaintenance();
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
    .replace(/\{userId\}/g, encodedUserId);
}

function browserChatBrowserProfileKey(session: Pick<BrowserChatSessionSnapshot, 'userId'>) {
  const userId = normalizeUserId(session.userId);
  // Preserve existing paths for common lowercase/numeric IDs. Hash every
  // other valid ID so path normalization cannot merge two users' profiles.
  const profileId = /^[a-z0-9_-]{1,64}$/.test(userId)
    ? userId
    : createHash('sha256').update(userId).digest('hex').slice(0, 32);
  return `user_${profileId}`;
}

function browserChatUserRuntimeKey(userId?: string | number) {
  return normalizeUserId(userId);
}

function browserChatUserBrowserIdleTimeoutMs() {
  const configured = Number(process.env.BROWSER_USER_BROWSER_IDLE_TIMEOUT_MS || 3 * 60 * 1000);
  return Number.isFinite(configured)
    ? Math.min(24 * 60 * 60 * 1000, Math.max(60_000, Math.floor(configured)))
    : 3 * 60 * 1000;
}

function browserChatSessionMemoryTtlMs() {
  const configured = Number(process.env.BROWSER_CHAT_SESSION_MEMORY_TTL_MS || 15 * 60 * 1000);
  return Number.isFinite(configured)
    ? Math.min(24 * 60 * 60 * 1000, Math.max(60_000, Math.floor(configured)))
    : 15 * 60 * 1000;
}

function cancelBrowserChatSessionEviction(sessionId: string) {
  const timer = sessionEvictionTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  sessionEvictionTimers.delete(sessionId);
}

function browserChatSessionHasRuntimeWork(session: BrowserChatSessionRecord) {
  if (session.busy || session.status === 'running' || session.browser || session.pendingToolConfirmation) return true;
  if (activeTurns.has(session.id) || browserStartPromises.has(session.id)) return true;
  if ((browserPreviewCounts.get(browserChatUserRuntimeKey(session.userId)) || 0) > 0) return true;
  return [...blockedSubagents.values()].some((binding) => binding.sessionId === session.id);
}

function evictBrowserChatSessionRuntime(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session || browserChatSessionHasRuntimeWork(session) || pendingPersistTimers.has(sessionId) || pendingSqliteWrites.has(sessionId)) return false;
  browserChatRuntimeState.streamPublisher?.cancel(sessionId);
  sessions.delete(sessionId);
  persistenceCursors.delete(sessionId);
  dirtyRecords.delete(sessionId);
  subagentResults.delete(sessionId);
  interruptedAssistantMessageIds.delete(session.activeAssistantMessageId || '');
  return true;
}

function scheduleBrowserChatSessionEviction(sessionId: string) {
  cancelBrowserChatSessionEviction(sessionId);
  const session = sessions.get(sessionId);
  if (!session || browserChatSessionHasRuntimeWork(session)) return;
  const timer = setTimeout(() => {
    sessionEvictionTimers.delete(sessionId);
    if (!evictBrowserChatSessionRuntime(sessionId)) scheduleBrowserChatSessionEviction(sessionId);
  }, browserChatSessionMemoryTtlMs());
  timer.unref?.();
  sessionEvictionTimers.set(sessionId, timer);
}

function browserChatUserHasActiveWork(userKey: string) {
  if ((browserPreviewCounts.get(userKey) || 0) > 0) return true;
  return [...sessions.values()].some((session) => (
    browserChatUserRuntimeKey(session.userId) === userKey
    && (session.busy || session.status === 'running' || session.turnState === 'awaiting_human')
  ));
}

function cancelBrowserChatUserIdleClose(userId?: string | number) {
  const userKey = browserChatUserRuntimeKey(userId);
  browserIdleEpochs.set(userKey, (browserIdleEpochs.get(userKey) || 0) + 1);
  const timer = browserIdleTimers.get(userKey);
  if (timer) clearTimeout(timer);
  browserIdleTimers.delete(userKey);
}

function scheduleBrowserChatUserIdleClose(userId?: string | number) {
  const userKey = browserChatUserRuntimeKey(userId);
  cancelBrowserChatUserIdleClose(userKey);
  if (browserChatUserHasActiveWork(userKey)) return;
  const epoch = browserIdleEpochs.get(userKey) || 0;
  const timer = setTimeout(() => {
    browserIdleTimers.delete(userKey);
    void (async () => {
      if (browserIdleEpochs.get(userKey) !== epoch || browserChatUserHasActiveWork(userKey)) return;
      const userSessions = [...sessions.values()].filter((session) => (
        browserChatUserRuntimeKey(session.userId) === userKey
        && session.browser
      ));
      const sessionsToClose = userSessions.map((session) => {
        const browser = restoreBrowserSessionPrototype(session.browser);
        if (browser) {
          try {
            session.tabs = browser.getTabsSnapshot();
            session.targetUrl = exportableTargetUrl(browser.currentUrl()) || session.targetUrl;
          } catch {
            // Keep the last application snapshot if the browser died before idle cleanup.
          }
        }
        return { session, browser };
      });
      for (const { session, browser } of sessionsToClose) {
        if (browserIdleEpochs.get(userKey) !== epoch || browserChatUserHasActiveWork(userKey)) return;
        session.browser = undefined;
        session.started = false;
        if (browser) await browser.close({ force: true, preservePages: true }).catch(() => undefined);
        session.updatedAt = now();
        persistAndNotify(session.id);
      }
    })();
  }, browserChatUserBrowserIdleTimeoutMs());
  timer.unref?.();
  browserIdleTimers.set(userKey, timer);
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

function browserChatStreamPublishDelayMs() {
  const raw = Number(process.env.BROWSER_CHAT_STREAM_PUBLISH_DELAY_MS || 32);
  const normalized = Number.isFinite(raw) ? Math.floor(raw) : 32;
  return Math.min(Math.max(normalized, 16), 160);
}

function trimBrowserChatLogs(logs: BrowserChatLogRecord[]) {
  return logs.slice(-browserChatLogLimit());
}

function dirtyRecordsFor(sessionId: string) {
  let dirty = dirtyRecords.get(sessionId);
  if (!dirty) {
    dirty = {
      logs: new Map(),
      messages: new Map(),
      removedLogIds: new Set(),
      removedMessageIds: new Set(),
      removedStepIndexes: new Set(),
      steps: new Map(),
    };
    dirtyRecords.set(sessionId, dirty);
  }
  return dirty;
}

function markMessageDirty(session: BrowserChatSessionRecord, message: BrowserChatMessage) {
  const dirty = dirtyRecordsFor(session.id);
  dirty.removedMessageIds.delete(message.id);
  dirty.messages.set(message.id, message);
}

function markStepDirty(session: BrowserChatSessionRecord, step: StepExecutionResult) {
  const dirty = dirtyRecordsFor(session.id);
  dirty.removedStepIndexes.delete(step.index);
  dirty.steps.set(step.index, step);
}

function replaceSessionSteps(session: BrowserChatSessionRecord, nextSteps: StepExecutionResult[]) {
  const previousByIndex = new Map(session.steps.map((step) => [step.index, step]));
  const nextIndexes = new Set(nextSteps.map((step) => step.index));
  session.steps = nextSteps;
  for (const step of nextSteps) {
    if (previousByIndex.get(step.index) !== step) markStepDirty(session, step);
  }
  const dirty = dirtyRecordsFor(session.id);
  for (const index of previousByIndex.keys()) {
    if (!nextIndexes.has(index)) {
      dirty.steps.delete(index);
      dirty.removedStepIndexes.add(index);
    }
  }
}

function replaceSessionLogs(session: BrowserChatSessionRecord, nextLogs: BrowserChatLogRecord[]) {
  const previousById = new Map((session.logs || []).map((log) => [log.id, log]));
  const trimmed = trimBrowserChatLogs(nextLogs);
  const nextIds = new Set(trimmed.map((log) => log.id));
  session.logs = trimmed;
  const dirty = dirtyRecordsFor(session.id);
  for (const log of trimmed) {
    if (previousById.get(log.id) !== log) {
      dirty.removedLogIds.delete(log.id);
      dirty.logs.set(log.id, log);
    }
  }
  for (const id of previousById.keys()) {
    if (!nextIds.has(id)) {
      dirty.logs.delete(id);
      dirty.removedLogIds.add(id);
    }
  }
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

function personalMemoryExtractionConcurrency() {
  const value = Number(process.env.AI_PERSONAL_MEMORY_EXTRACTION_CONCURRENCY || 2);
  return Number.isFinite(value) ? Math.max(1, Math.min(8, Math.floor(value))) : 2;
}

function personalMemoryExtractionQueueLimit() {
  const value = Number(process.env.AI_PERSONAL_MEMORY_EXTRACTION_QUEUE_LIMIT || 100);
  return Number.isFinite(value) ? Math.max(10, Math.min(1000, Math.floor(value))) : 100;
}

function drainPersonalMemoryExtractionQueue() {
  const runtime = browserChatRuntimeState;
  while (runtime.memoryExtractionActive < personalMemoryExtractionConcurrency()) {
    const index = runtime.memoryExtractionQueue.findIndex((job) => !runtime.memoryExtractionActiveUsers.has(job.userId));
    if (index < 0) return;
    const [job] = runtime.memoryExtractionQueue.splice(index, 1);
    runtime.memoryExtractionActive += 1;
    runtime.memoryExtractionActiveUsers.add(job.userId);
    void job.run().catch(() => undefined).finally(() => {
      runtime.memoryExtractionActive = Math.max(0, runtime.memoryExtractionActive - 1);
      runtime.memoryExtractionActiveUsers.delete(job.userId);
      runtime.memoryExtractionKeys.delete(job.key);
      drainPersonalMemoryExtractionQueue();
    });
  }
}

function schedulePersonalMemoryExtraction(job: BrowserChatMemoryExtractionJob) {
  const runtime = browserChatRuntimeState;
  if (runtime.memoryExtractionKeys.has(job.key)) return 'duplicate' as const;
  if (runtime.memoryExtractionQueue.length >= personalMemoryExtractionQueueLimit()) return 'full' as const;
  runtime.memoryExtractionKeys.add(job.key);
  runtime.memoryExtractionQueue.push(job);
  drainPersonalMemoryExtractionQueue();
  return 'scheduled' as const;
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
  const queueResult = schedulePersonalMemoryExtraction({
    key: `${input.session.id}:${input.userMessageId}:${input.assistantMessageId}`,
    userId: normalizeUserId(input.session.userId),
    run: async () => {
      try {
        const memoryResult = await extractPersonalMemoryFromTurn({
          userId: input.session.userId,
          currentUrl,
          targetUrl: input.session.targetUrl,
          userMessage: input.text,
          assistantReply: input.result.reply,
          conversation,
          steps: input.result.newSteps,
          sourceSessionId: input.session.id,
          sourceMessageIds: [input.userMessageId, input.assistantMessageId],
        });
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
      } catch (error) {
        const current = sessions.get(input.session.id);
        if (!current || current !== input.session) return;
        appendLog(current, 'memory:extract:error', `个性化短记忆提炼失败：${error instanceof Error ? error.message : 'unknown error'}`, {
          elapsedMs: elapsedMs(startedAt),
          messageId: null,
          details: errorLogDetails(error),
        });
      }
    },
  });
  if (queueResult === 'full') {
    appendLog(input.session, 'memory:extract:queued-limit', '个性化短记忆提取队列已满，本轮跳过提取。', {
      messageId: null,
      deferPersist: true,
    });
  }
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
  const { value } = unwrapLogDetails(input);
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') return trimLogText(value, 20_000);
  try {
    const serialized = stringifyCompactLogDetails(value) || String(value);
    return trimLogText(serialized, 20_000);
  } catch {
    return trimLogText(String(value), 20_000);
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

function normalizeAttachments(value: unknown, userId?: unknown): BrowserChatAttachment[] {
  return normalizeBrowserChatAttachments(value, userId);
}

function normalizeSkillIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean)))
    .slice(0, 8);
}

function artifactAttachmentForSession(session: BrowserChatSessionRecord, artifactId: string): BrowserChatAttachment | undefined {
  const segments = artifactId.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) return undefined;
  if (segments.length < 3 || segments[0] !== session.id || !['downloads', 'generated'].includes(segments[1])) return undefined;
  const name = segments.at(-1) || 'artifact';
  return {
    id: `artifact:${segments.join('/')}`,
    kind: 'file',
    name,
    path: segments.join('/'),
    size: undefined,
    type: artifactContentType(name),
    url: artifactApiUrlFromRelative(segments.join('/')),
  };
}

async function readFileForSession(
  session: BrowserChatSessionRecord,
  input: BrowserChatReadFileInput,
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
      actual: '未找到可读取文件。请使用对话附件的 attachmentId，或 downloadFile/generateFile 返回的 Artifact ID。',
    };
  }
  const result = await readBrowserChatAttachment({
    attachment,
    absolutePath: uploadedBrowserChatAttachmentPath(attachment, session.userId),
    includeVisuals: input.includeVisuals,
    limit: input.limit,
    offset: input.offset,
    pages: input.pages,
  });
  return isBrowserChatImageAttachment(attachment) && result.ok
    ? { ...result, referenceImagePath: uploadedBrowserChatAttachmentPath(attachment, session.userId) }
    : result;
}

type BrowserChatResourceSeed = {
  kind: 'url' | 'axure' | 'tab' | 'file' | 'image' | 'other';
  title: string;
  url?: string;
};

type BrowserChatCredentialDescriptor = {
  origins: string[];
  username: string;
  usernameRef: string;
  passwordRef: string;
};

function browserChatResourceKind(title: string, url?: string): BrowserChatResourceSeed['kind'] {
  const value = `${title}\n${url || ''}`.toLowerCase();
  if (value.includes('axure') || value.includes('axshare.com') || /\/start\.html(?:$|[?#])/i.test(value)) return 'axure';
  if (/\.(?:png|jpe?g|gif|webp|bmp|svg)(?:$|[?#])/i.test(value)) return 'image';
  return url ? 'url' : 'other';
}

function httpOrigin(value?: string) {
  if (!value) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : '';
  } catch {
    return '';
  }
}

function instructionMentionsLoginAccount(instruction: string, account: LoginAccountMetadata) {
  const normalized = instruction.toLowerCase();
  return normalized.includes(account.username.toLowerCase())
    || normalized.includes(account.domain.toLowerCase())
    || Boolean(account.loginUrl && normalized.includes(account.loginUrl.toLowerCase()));
}

function browserChatCredentialContext(
  session: BrowserChatSessionRecord,
  seeds: BrowserChatResourceSeed[],
  instruction: string,
) {
  const matches = new Map<string, { account: LoginAccountMetadata; origins: Set<string> }>();
  const addAccount = (account: LoginAccountMetadata, origins: string[]) => {
    const allowedOrigins = origins.filter(Boolean);
    if (!allowedOrigins.length) return;
    const existing = matches.get(account.id);
    if (existing) {
      allowedOrigins.forEach((origin) => existing.origins.add(origin));
      return;
    }
    matches.set(account.id, { account, origins: new Set(allowedOrigins) });
  };

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
      .filter((account) => account.status === 'active' && account.hasPassword);
    const mentioned = accounts.filter((account) => instructionMentionsLoginAccount(instruction, account));
    const account = mentioned.length === 1 ? mentioned[0] : accounts.length === 1 ? accounts[0] : undefined;
    if (!account) continue;
    addAccount(account, [url.origin, httpOrigin(account.loginUrl)]);
  }

  for (const account of listLoginAccounts({ userId: session.userId })) {
    if (account.status !== 'active' || !account.hasPassword || !instructionMentionsLoginAccount(instruction, account)) continue;
    addAccount(account, [httpOrigin(account.loginUrl)]);
  }

  const credentials: BrowserChatCredentialDescriptor[] = [];
  const bindings: BrowserCodeCredentialBinding[] = [];
  for (const { account, origins } of matches.values()) {
    const credential = resolveLoginAccountCredentialById(account.id, session.userId);
    if (!credential) continue;
    const token = randomUUID();
    const usernameRef = `credential_${token}_username`;
    const passwordRef = `credential_${token}_password`;
    const allowedOrigins = Array.from(origins);
    credentials.push({ origins: allowedOrigins, username: account.username, usernameRef, passwordRef });
    bindings.push(
      { ref: usernameRef, value: account.username, allowedOrigins },
      { ref: passwordRef, value: credential.password, allowedOrigins },
    );
  }
  return { credentials, bindings };
}

function browserChatCredentialPrompt(credentials: BrowserChatCredentialDescriptor[]) {
  if (!credentials.length) return '';
  return [
    '[后台已匹配的安全账号引用]',
    ...credentials.map((item) => [
      `- ${item.origins.join('、')} / ${item.username}`,
      `  用户名：await credentialVault.fill(page.getByLabel('用户名'), "${item.usernameRef}")`,
      `  密码：await credentialVault.fill(page.getByLabel('密码'), "${item.passwordRef}")`,
    ].join('\n')),
    'credentialVault.fill 只会把对应值写入真实 Playwright Locator，并且只允许上述 origin；它不会返回账号或密码明文。不得读取已填充输入框的 inputValue/value，不得在 nodeRepl.write、console、工具参数或最终回复中输出凭据或引用。验证码、OTP、扫码或二次认证必须调用 waitForHumanVerification。',
  ].join('\n');
}

function createBrowserChatRuntimeOperationalContext(input: {
  session: BrowserChatSessionRecord;
  browser: BrowserSession;
  text: string;
  modelText: string;
  explicitlySelectedSkills?: SkillRecord[];
}) {
  let cachedKey = '';
  let cachedContext: { operationalContext: string; credentialBindings: BrowserCodeCredentialBinding[] } | undefined;
  return () => {
    const currentUrl = browserChatMemoryUrl(input.browser, input.session);
    const key = httpOrigin(currentUrl) || normalizePersonalMemoryDomain(currentUrl || input.session.targetUrl) || 'global';
    if (cachedContext && cachedKey === key) return cachedContext;
    const skills = runtimeSkillsForUrl(
      store.listSkills(undefined, input.session.userId).filter((skill) => skill.status === 'ready'),
      input.explicitlySelectedSkills || [],
      currentUrl || input.session.targetUrl,
    );
    const memory = browserChatPersonalMemoryContext({
      session: input.session,
      browser: input.browser,
      text: input.text,
      modelText: input.modelText,
      currentUrl,
      logPhase: 'memory:prompt:runtime-refresh',
    });
    const credentialUrl = httpOrigin(currentUrl) ? currentUrl : input.session.targetUrl;
    const credentials = browserChatCredentialContext(
      input.session,
      credentialUrl ? [{
        kind: browserChatResourceKind(credentialUrl, credentialUrl),
        title: '当前页面',
        url: credentialUrl,
      }] : [],
      input.modelText,
    );
    cachedKey = key;
    cachedContext = {
      operationalContext: [
        formatSkillsForPrompt(skills),
        memory.context,
        browserChatCredentialPrompt(credentials.credentials),
      ].filter(Boolean).join('\n\n'),
      credentialBindings: credentials.bindings,
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

function messageContentForPrompt(message: BrowserChatMessage, userId?: string) {
  const selectedSkills = message.skillIds?.length
    ? store.getSkills(message.skillIds, userId).filter((skill) => skill.status === 'ready')
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

function browserChatConversationTokenEstimate(messages: InteractiveBrowserTurnMessage[]) {
  return estimateRuntimeTextTokens(messages.map((message) => `${message.role}: ${message.content}`).join('\n\n'));
}

function buildConversationSummaryPrompt(input: {
  previousContext?: BrowserChatConversationContext;
  messages: BrowserChatMessage[];
  estimatedTokens: number;
  thresholdTokens: number;
  userId?: string;
}) {
  const source = {
    previousSummary: input.previousContext?.summary || '',
    messages: input.messages.map((message) => ({
      id: message.id,
      role: message.role,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      content: messageContentForPrompt(message, input.userId),
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

function fallbackConversationSummary(input: { previousContext?: BrowserChatConversationContext; messages: BrowserChatMessage[]; userId?: string }) {
  return [
    input.previousContext?.summary ? `此前摘要：${input.previousContext.summary}` : '',
    ...input.messages.map((message) => `${message.role === 'user' ? '用户' : 'AI'}：${messageContentForPrompt(message, input.userId)}`),
  ].filter(Boolean).join('\n');
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

type CompletedRunStatus = 'passed' | 'failed' | 'blocked';

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

function browserCodeAttachmentBindingsForSession(
  session: BrowserChatSessionRecord,
): BrowserCodeAttachmentBinding[] {
  const bindings = new Map<string, BrowserCodeAttachmentBinding>();
  for (const message of session.messages) {
    if (message.role !== 'user') continue;
    for (const attachment of message.attachments || []) {
      if (attachment.kind === 'tab' || bindings.has(attachment.id)) continue;
      const absolutePath = uploadedBrowserChatAttachmentPath(attachment, session.userId);
      if (!absolutePath || !existsSync(absolutePath)) continue;
      bindings.set(attachment.id, {
        name: attachment.name,
        path: absolutePath,
        ref: attachment.id,
      });
    }
  }
  return [...bindings.values()];
}

function compactStepForRealtime(step: StepExecutionResult): StepExecutionResult {
  const clientStep = compactStepForClient(step);
  if (!clientStep.tools?.length) return clientStep;
  return {
    ...clientStep,
    tools: clientStep.tools.map((tool) => {
      const realtimeTool = { ...tool };
      delete realtimeTool.rawResult;
      return realtimeTool;
    }),
  };
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
    outputCycles: [],
    subagents: [],
    consoleErrors: [],
    networkErrors: [],
    logs: [],
  };
}

function browserChatTabs(session: BrowserChatSessionRecord): BrowserTabSnapshot[] {
  const savedTabs = Array.isArray(session.tabs) ? session.tabs : [];
  if (!session.browser || !session.started) return savedTabs;
  try {
    return session.browser.getTabsSnapshot();
  } catch {
    return savedTabs;
  }
}

function sessionSnapshotHeader(
  session: BrowserChatSessionRecord,
): Omit<BrowserChatSessionSnapshot, 'logs' | 'messages' | 'steps'> {
  finalizeIdleRunningAssistantMessages(session);
  if (!session.busy && session.status !== 'running') session.mode = configuredBrowserChatMode();
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
    turnState: normalizeBrowserChatTurnState(session),
    busy: session.busy,
    tabs: browserChatTabs(session),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    closedAt: session.closedAt,
    error: session.error,
    consoleErrors: [...session.consoleErrors],
    networkErrors: [...session.networkErrors],
    outputCycles: [...session.outputCycles],
    subagents: [...session.subagents],
    conversationContext: normalizeConversationContext(session.conversationContext),
    pendingToolConfirmation: normalizeToolConfirmation(session.pendingToolConfirmation),
  };
}

function snapshot(session: BrowserChatSessionRecord, options: { fullSteps?: boolean } = {}): BrowserChatSessionSnapshot {
  return {
    ...sessionSnapshotHeader(session),
    messages: [...session.messages],
    steps: options.fullSteps ? [...session.steps] : session.steps.map(compactStepForClient),
    outputCycles: [...session.outputCycles],
    subagents: [...session.subagents],
    logs: [...(session.logs || [])],
  };
}

function summarySnapshot(session: BrowserChatSessionRecord): BrowserChatSessionSnapshot {
  return summaryFromSnapshot({
    ...sessionSnapshotHeader(session),
    messages: [...session.messages],
    steps: [],
    outputCycles: [...session.outputCycles],
    subagents: [...session.subagents],
    consoleErrors: [],
    networkErrors: [],
    logs: [...(session.logs || [])],
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
    const normalized = typeof text === 'string' ? normalizeBrowserChatFinalReplyText(text) : '';
    if (normalized && !isBrowserChatDomObservationText(normalized)) return normalized;
  }
  const fallback = log.message
    .replace(/;\s*turn\s+\d+\/\d+;\s*AI\+tool[\s\S]*$/i, '')
    .trim();
  return /^AI returned no text/i.test(fallback) || isBrowserChatDomObservationText(fallback) ? '' : fallback;
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
    const updated = {
      ...message,
      status: recoveredStatusForStaleAssistantMessage(session, message),
      activity: undefined,
    };
    markMessageDirty(session, updated);
    return updated;
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

const browserChatInterruptedReply = '本轮对话已由用户中止。已保留中止前已执行的工具和页面记录。';

function preserveInterruptedTurn(session: BrowserChatSessionRecord, assistantMessageId: string | undefined, timestamp: string) {
  if (assistantMessageId) {
    updateAssistantMessage(session, assistantMessageId, (message) => ({
      ...message,
      content: browserChatInterruptedReply,
      status: 'interrupted',
      activity: undefined,
      updatedAt: timestamp,
    }));
  }
  replaceSessionSteps(session, session.steps.map((step) => {
    if (step.status !== 'queued' && step.status !== 'running') return step;
    const interruptionNote = '用户已中止本轮对话；已保留中止前的工具执行记录。';
    return {
      ...step,
      status: 'blocked',
      actual: step.actual.includes(interruptionNote) ? step.actual : [step.actual, interruptionNote].filter(Boolean).join('\n\n'),
      note: step.note?.includes(interruptionNote) ? step.note : [step.note, interruptionNote].filter(Boolean).join('\n'),
    };
  }));
}

function shouldPreserveRuntimeTurn(existing: BrowserChatSessionRecord, fromDisk: BrowserChatSessionSnapshot) {
  const assistantMessageId = existing.activeAssistantMessageId;
  const abortController = existing.activeAbortController;
  if (!assistantMessageId || !abortController) return false;
  if (!registeredBrowserChatTurnIsActive(
    activeTurns,
    existing.id,
    existing,
    assistantMessageId,
    abortController,
  )) return false;
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
  const steps = attachBrowserChatStepOwners(
    (session.steps || []).filter((step) => !transientStepIndexes.has(step.index)),
    session.logs || [],
  );
  const messages = alignBrowserChatMessageStepIndexes((session.messages || []).map((rawMessage) => {
    const safeMessage: BrowserChatMessage = {
      ...rawMessage,
      role: rawMessage.role === 'assistant' ? 'assistant' : 'user',
      content: rawMessage.role === 'assistant' && rawMessage.status === 'interrupted'
        ? browserChatInterruptedReply
        : textFromUnknown(rawMessage.content),
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
  }), steps);
  return {
    ...session,
    userId: normalizeUserId(session.userId),
    mode: configuredBrowserChatMode(),
    tabs: session.tabs || [],
    targetUrl: exportableTargetUrl(session.targetUrl),
    safetyMode: normalizeSafetyMode(session.safetyMode),
    modelProvider: modelSettings.provider,
    model: modelSettings.model,
    messages,
    steps,
    outputCycles: session.outputCycles || [],
    subagents: session.subagents || [],
    conversationContext: normalizeConversationContext(session.conversationContext),
    pendingToolConfirmation: preserveRecentRunningState ? normalizeToolConfirmation(session.pendingToolConfirmation) : undefined,
    status,
    turnState: preserveRecentRunningState
      ? normalizeBrowserChatTurnState(session)
      : normalizeBrowserChatTurnState({ ...session, busy: false, status }),
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
  const detailRecord = input.details && typeof input.details === 'object' && !Array.isArray(input.details)
    ? input.details as Record<string, unknown>
    : {};
  const execution = detailRecord.execution && typeof detailRecord.execution === 'object' && !Array.isArray(detailRecord.execution)
    ? detailRecord.execution as Record<string, unknown>
    : {};
  const logMessageId = input.messageId === null ? undefined : input.messageId ?? session.activeAssistantMessageId;
  const stepIndex = phase.startsWith('subagent:') ? undefined : input.stepIndex;
  const logRecord = compactBrowserChatLogsForClient<BrowserChatLogRecord>([{
    id: id('log'),
    time: timestamp,
    phase,
    message,
    details,
    messageId: logMessageId,
    stepIndex,
    elapsedMs: input.elapsedMs,
    turnId: typeof execution.turnId === 'string' ? execution.turnId : undefined,
    attemptId: typeof execution.attemptId === 'string' ? execution.attemptId : undefined,
    toolCallId: typeof execution.toolCallId === 'string' ? execution.toolCallId : undefined,
  }])[0];
  replaceSessionLogs(session, [
    ...(session.logs || []),
    logRecord,
  ]);
  if (logMessageId && logMessageId === session.activeAssistantMessageId) {
    updateAssistantMessage(session, logMessageId, (item) => ({
      ...item,
      activity: item.status === 'running' && runningActivity
        ? { phase, label: runningActivity, updatedAt: timestamp }
        : item.activity,
      stepIndexes: stepIndex
        ? Array.from(new Set([...(item.stepIndexes || []), stepIndex])).sort((a, b) => a - b)
        : item.stepIndexes,
      updatedAt: timestamp,
    }));
  }
  session.updatedAt = timestamp;
  persistAndNotify(session.id, { defer: input.deferPersist === true });
}

function readSessionSummaries(userId?: string | number): BrowserChatSessionSnapshot[] {
  return readBrowserChatSessionSummaries<BrowserChatSessionSnapshot>({
    hasMessagesOnly: true,
    userId: userId === undefined ? undefined : normalizeApplicationUserId(userId),
  })
    .filter(isBrowserChatSessionSnapshot);
}

function isBrowserChatSessionSnapshot(value: unknown): value is BrowserChatSessionSnapshot {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { id?: unknown }).id === 'string';
}

function readSessionSnapshot(sessionId: string) {
  const item = readBrowserChatSessionRecord<BrowserChatSessionSnapshot>(sessionId);
  if (!isBrowserChatSessionSnapshot(item)) return undefined;
  return { ...item, logs: trimBrowserChatLogs(item.logs || []) };
}

function persistenceDelta(item: BrowserChatSessionSnapshot) {
  return collectBrowserChatPersistenceDelta(
    item,
    persistenceCursors.get(item.id),
    dirtyRecords.get(item.id),
  );
}

function advancePersistenceCursor(item: BrowserChatSessionSnapshot, delta: ReturnType<typeof persistenceDelta>) {
  const cursor = persistenceCursors.get(item.id) || {
    logs: new Map<string, BrowserChatLogRecord>(),
    messages: new Map<string, BrowserChatMessage>(),
    steps: new Map<number, StepExecutionResult>(),
  };
  persistenceCursors.set(item.id, applyBrowserChatPersistenceDelta(cursor, delta));
}

function seedPersistenceCursor(
  item: Pick<BrowserChatSessionSnapshot, 'id' | 'logs' | 'messages' | 'steps'>,
  persisted: Pick<BrowserChatSessionSnapshot, 'logs' | 'messages' | 'steps'> = item,
) {
  persistenceCursors.set(item.id, seedBrowserChatPersistenceCursor(item, persisted));
}

function trackSessionSqliteWrite(sessionId: string, operation: Promise<void>) {
  const tracked: Promise<boolean> = operation
    .then(() => {
      return true;
    })
    .catch((error) => {
      persistenceCursors.delete(sessionId);
      dirtyRecords.delete(sessionId);
      warnPersistFailure(error);
      return false;
    })
    .finally(() => {
      if (pendingSqliteWrites.get(sessionId) === tracked) pendingSqliteWrites.delete(sessionId);
    });
  pendingSqliteWrites.set(sessionId, tracked);
  return tracked;
}

function writeSessionSnapshot(item: BrowserChatSessionSnapshot): BrowserChatSessionRealtimePatch {
  const retainedLogs = item.logs.length > browserChatLogStorageLimit() ? trimBrowserChatLogs(item.logs) : item.logs;
  const storedLogs = compactBrowserChatLogsForClient(retainedLogs);
  const persistedItem = storedLogs === item.logs ? item : { ...item, logs: storedLogs };
  const rawDelta = persistenceDelta(persistedItem);
  const delta = {
    ...rawDelta,
    logs: compactBrowserChatLogsForClient(rawDelta.logs),
  };
  const sessionRecord: Partial<BrowserChatSessionSnapshot> = { ...persistedItem };
  delete sessionRecord.messages;
  delete sessionRecord.steps;
  delete sessionRecord.logs;
  const session = sessionRecord as Omit<BrowserChatSessionSnapshot, 'logs' | 'messages' | 'steps'>;
  const realtimeSession: BrowserChatSessionRealtimePatch['session'] = {
    ...session,
    pendingToolConfirmation: session.pendingToolConfirmation ?? null,
  };
  const summary = summaryFromSnapshot(persistedItem);
  const patch: BrowserChatSessionRealtimePatch = {
    session: realtimeSession,
    summary,
    ...(delta.messages.length ? { messages: delta.messages } : {}),
    ...(delta.steps.length ? { steps: delta.steps.map(compactStepForRealtime) } : {}),
    ...(delta.logs.length ? { logs: delta.logs } : {}),
    ...(delta.removedMessageIds.length ? { removedMessageIds: delta.removedMessageIds } : {}),
    ...(delta.removedStepIndexes.length ? { removedStepIndexes: delta.removedStepIndexes } : {}),
    ...(delta.removedLogIds.length ? { removedLogIds: delta.removedLogIds } : {}),
  };
  const realtimeEvent = {
    entityType: 'browserChatSession' as const,
    id: item.id,
    updatedAt: item.updatedAt,
    userId: normalizeApplicationUserId(item.userId),
    patch,
  };
  const sqliteWrite = writeBrowserChatSessionDeltaQueued(
    { ...session, messages: [], steps: [], logs: [] },
    summary,
    delta,
  );
  trackSessionSqliteWrite(item.id, sqliteWrite);
  void publishRealtimeRefreshEvent(realtimeEvent).catch(() => undefined);
  if (dirtyRecords.has(item.id)) {
    advancePersistenceCursor(persistedItem, delta);
    dirtyRecords.delete(item.id);
  } else {
    seedPersistenceCursor(persistedItem);
  }
  return patch;
}

async function publishBrowserChatTextStreamSnapshot(sessionId: string, assistantMessageId: string) {
  const session = sessions.get(sessionId);
  const message = session?.messages.find((item) => item.id === assistantMessageId);
  if (!session || !message || message.role !== 'assistant') return;
  const header = sessionSnapshotHeader(session);
  const patch: BrowserChatSessionRealtimePatch = {
    session: {
      ...header,
      pendingToolConfirmation: header.pendingToolConfirmation ?? null,
    },
    messages: [{
      ...message,
      attachments: message.attachments ? [...message.attachments] : undefined,
      stepIndexes: message.stepIndexes ? [...message.stepIndexes] : undefined,
    }],
  };
  await publishRealtimeRefreshEvent({
    entityType: 'browserChatSession',
    id: session.id,
    updatedAt: session.updatedAt,
    userId: normalizeApplicationUserId(session.userId),
    patch,
  });
}

function browserChatTextStreamPublisher() {
  return browserChatRuntimeState.streamPublisher ??= createLatestOnlyAsyncScheduler({
    delayMs: browserChatStreamPublishDelayMs,
    publish: publishBrowserChatTextStreamSnapshot,
  });
}

function scheduleBrowserChatTextStreamPublish(sessionId: string, assistantMessageId: string) {
  browserChatTextStreamPublisher().schedule(sessionId, assistantMessageId);
}

function deleteSessionSnapshot(sessionId: string, userId: string) {
  const event = {
    entityType: 'browserChatSession',
    id: sessionId,
    updatedAt: now(),
    userId: normalizeApplicationUserId(userId),
    deleted: true,
  } as const;
  void trackSessionSqliteWrite(sessionId, deleteBrowserChatSessionRecordQueued(sessionId))
    .then((stored) => stored ? publishRealtimeRefreshEvent(event) : undefined)
    .catch(() => undefined);
  persistenceCursors.delete(sessionId);
  dirtyRecords.delete(sessionId);
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

function mergePersistedOutputCycles(existing: BrowserChatAiOutputCycle[] = [], incoming: BrowserChatAiOutputCycle[] = []) {
  const byId = new Map<string, BrowserChatAiOutputCycle>();
  for (const cycle of existing) byId.set(cycle.id, cycle);
  for (const cycle of incoming) byId.set(cycle.id, cycle);
  return [...byId.values()];
}

function mergePersistedSubagents(existing: BrowserChatSubagentRecord[] = [], incoming: BrowserChatSubagentRecord[] = []) {
  const byId = new Map<string, BrowserChatSubagentRecord>();
  for (const subagent of existing) byId.set(subagent.id, subagent);
  for (const subagent of incoming) {
    const previous = byId.get(subagent.id);
    byId.set(subagent.id, previous
      ? { ...previous, ...subagent, steps: mergePersistedSteps(previous.steps, subagent.steps) }
      : subagent);
  }
  return [...byId.values()].sort((left, right) => left.index - right.index);
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
  if (!existing) {
    const steps = attachBrowserChatStepOwners(incoming.steps, incoming.logs);
    return { ...incoming, messages: alignBrowserChatMessageStepIndexes(incoming.messages, steps), steps };
  }
  const incomingNewer = timestampValue(incoming.updatedAt) >= timestampValue(existing.updatedAt);
  const base = incomingNewer ? { ...existing, ...incoming } : { ...incoming, ...existing };
  const logs = mergePersistedLogs(existing.logs, incoming.logs);
  const steps = attachBrowserChatStepOwners(mergePersistedSteps(existing.steps, incoming.steps), logs);
  return {
    ...base,
    messages: alignBrowserChatMessageStepIndexes(mergePersistedMessages(existing.messages, incoming.messages), steps),
    steps,
    outputCycles: mergePersistedOutputCycles(existing.outputCycles, incoming.outputCycles),
    subagents: mergePersistedSubagents(existing.subagents, incoming.subagents),
    consoleErrors: mergeStringLists(existing.consoleErrors, incoming.consoleErrors),
    networkErrors: mergeStringLists(existing.networkErrors, incoming.networkErrors),
    logs,
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
    outputCycles: mergePersistedOutputCycles(fromDisk.outputCycles, existing.outputCycles),
    subagents: mergePersistedSubagents(fromDisk.subagents, existing.subagents),
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
    return true;
  }
  // Deferred progress writes and immediate interruption both make the in-memory
  // record newer than SQLite for a short period. A GET during that window must
  // not revive an older running turn or replace its live AbortController.
  if (runtimeSnapshotIsNewer(existing.updatedAt, persistedSnapshot.updatedAt)) return false;
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
  return true;
}

function hydrateSession(sessionId: string) {
  const persisted = readSessionSnapshot(sessionId);
  const applied = persisted ? applyPersistedSnapshotToRuntime(persisted) : false;
  const session = sessions.get(sessionId);
  if (session && persisted && applied) seedPersistenceCursor(session, persisted);
  else if (persisted && !persistenceCursors.has(sessionId)) seedPersistenceCursor(persisted);
  if (session) scheduleBrowserChatSessionEviction(sessionId);
  return session;
}

function persistSession(sessionId: string, options: { deletedUserId?: string; mergePersisted?: boolean } = {}): BrowserChatSessionRealtimePatch | true | false {
  try {
    const currentSession = sessions.get(sessionId);
    const incoming = currentSession ? snapshot(currentSession, { fullSteps: true }) : undefined;
    if (!incoming) {
      if (!options.deletedUserId) return false;
      deleteSessionSnapshot(sessionId, options.deletedUserId);
      return true;
    }
    const shouldMergePersisted = options.mergePersisted === true;
    const persistedSnapshot = shouldMergePersisted ? readSessionSnapshot(sessionId) : undefined;
    const writtenSnapshot = shouldMergePersisted ? mergePersistedSessionSnapshot(persistedSnapshot, incoming) : incoming;
    const patch = writeSessionSnapshot(writtenSnapshot);
    if (shouldMergePersisted) {
      applyPersistedSnapshotToRuntime(writtenSnapshot);
      const runtimeSession = sessions.get(sessionId);
      if (runtimeSession) seedPersistenceCursor(runtimeSession, writtenSnapshot);
    }
    return patch;
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

function persistAndNotify(sessionId: string, options: { defer?: boolean; deletedUserId?: string; mergePersisted?: boolean } = {}) {
  if (options.defer) {
    schedulePersistAndNotify(sessionId);
    return true;
  }
  clearPendingPersist(sessionId);
  const persisted = persistSession(sessionId, {
    deletedUserId: options.deletedUserId,
    mergePersisted: options.mergePersisted,
  });
  if (!persisted) return false;
  scheduleBrowserChatSessionEviction(sessionId);
  return true;
}

async function persistAndNotifyTerminal(sessionId: string) {
  clearPendingPersist(sessionId);
  const persisted = persistSession(sessionId);
  if (!persisted) return false;
  const pendingWrite = pendingSqliteWrites.get(sessionId);
  if (pendingWrite && !(await pendingWrite)) return false;
  scheduleBrowserChatSessionEviction(sessionId);
  return true;
}

function persistDeletedSessions(items: Array<{ id: string; userId: string }>) {
  try {
    for (const item of items) {
      deleteSessionSnapshot(item.id, item.userId);
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
  userId?: string,
): InteractiveBrowserTurnMessage[] {
  const stableMessages = stableConversationMessages(messages)
    .filter((message) => message.id !== currentUserMessageId);
  const uncovered = orderedMessagesAfterCoveredContext(stableMessages, context);
  return [
    ...(context?.summary ? [{
      role: 'user' as const,
      content: `[历史会话总结]\n${context.summary}`,
    }] : []),
    ...uncovered.map((message) => ({ role: message.role, content: messageContentForPrompt(message, userId) })),
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
  const currentConversation = conversationForPrompt(historicalMessages, session.conversationContext, undefined, session.userId);
  const thresholdTokens = Math.floor(runtimeContextWindowTokens() * runtimeContextCompressionThresholdRatio());
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
    userId: session.userId,
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
    const timeoutMs = Math.max(1000, Number(process.env.AI_BROWSER_CHAT_CONTEXT_TIMEOUT_MS || process.env.AI_REQUEST_TIMEOUT_MS || 30000));
    const result = await generateText({
      model: getModel(),
      temperature: 0.1,
      reasoning: aiReasoningEffort(),
      maxRetries: 0,
      prompt,
      abortSignal,
      timeout: timeoutMs,
      telemetry: aiTelemetry('browser-chat-context-summary'),
    });
    const summary = compactText(result.text || '', 12000) || fallbackConversationSummary({ previousContext, messages: sourceMessages, userId: session.userId });
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
        estimatedTokensAfter: browserChatConversationTokenEstimate(conversationForPrompt(historicalMessages, session.conversationContext, undefined, session.userId)),
        thresholdTokens,
        context: session.conversationContext,
      }),
    });
    persistAndNotify(session.id);
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
  preferExistingPage?: boolean;
};

async function ensureStarted(
  session: BrowserChatSessionRecord,
  assertTurnActive?: BrowserChatTurnGuard,
  options: BrowserChatStartOptions = {},
) {
  cancelBrowserChatUserIdleClose(session.userId);
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
  const browserProfileKey = browserChatBrowserProfileKey(session);
  return new BrowserSession(session.mode, {
    browserSurface: 'electron-embedded',
    browserProfileKey,
    ...(process.env.ELECTRON_EMBEDDED_BROWSER === 'true' ? {} : { sharedBrowserRuntimeKey: browserProfileKey }),
    ...browserChatBrowserExecutionOptions(),
    isMarked: true,
    preferExistingPage,
    runId: session.id,
  });
}

function configuredBrowserChatMode(): BrowserSessionMode {
  return process.env.AI_BROWSER_MODE?.trim().toLowerCase() === 'dom' ? 'dom' : 'code';
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
  const savedTabs = (session.tabs || [])
    .map((tab) => ({ ...tab, url: exportableTargetUrl(tab.url) }))
    .filter((tab) => Boolean(tab.url));
  session.browser = browser;
  session.updatedAt = now();
  persistAndNotify(session.id);
  try {
    await browser.start();
    assertTurnActive?.();
    const savedCookies = readBrowserDomainCookies(session.userId);
    if (savedCookies.length) {
      const injectedCount = await browser.injectCookies(savedCookies);
      assertTurnActive?.();
      const domainCount = new Set(savedCookies.map((cookie) => new URL(cookie.url).hostname)).size;
      appendLog(
        session,
        'browser:cookies:injected',
        `已为当前用户注入 ${injectedCount} 个 Cookie，覆盖 ${domainCount} 个域名。`,
      );
    }
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
  if (savedTabs.length) {
    try {
      const restored = await browser.restoreTabsFromSnapshot(savedTabs);
      session.tabs = restored.tabs;
      appendLog(
        session,
        'browser:restore-tabs',
        `已恢复 ${restored.restored}/${restored.attempted} 个标签页${restored.failedUrls.length ? `，${restored.failedUrls.length} 个地址加载失败` : ''}`,
        { details: { attempted: restored.attempted, created: restored.created, restored: restored.restored, failed: restored.failedUrls.length } },
      );
    } catch (error) {
      appendLog(session, 'browser:restore-tabs-failed', `标签页恢复失败，将继续打开会话目标地址：${userFacingErrorMessage(error)}`);
    }
  }
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
  if (!session.busy) transitionBrowserChatSession(session, { type: 'sessionRecovered', at: now() });
  else session.updatedAt = now();
  persistAndNotify(session.id);
  return browser;
}

export function createBrowserChatSession(input: {
  targetUrl?: string;
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
    title: input.title?.trim() || '',
    userId: normalizeUserId(input.userId),
    browserGroupId: '',
    targetUrl: exportableTargetUrl(input.targetUrl || ''),
    mode: configuredBrowserChatMode(),
    safetyMode: normalizeSafetyMode(input.safetyMode),
    modelProvider: modelSettings.provider,
    model: modelSettings.model,
    status: 'idle',
    turnState: 'idle',
    busy: false,
    tabs: [],
    started: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: [],
    steps: [],
    outputCycles: [],
    subagents: [],
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

export function getBrowserChatSessionPage(sessionId: string, userId?: string | number) {
  const persisted = readBrowserChatSessionWindow<
    BrowserChatSessionSnapshot,
    BrowserChatMessage,
    StepExecutionResult,
    BrowserChatLogRecord
  >(sessionId);
  const live = sessions.get(sessionId);
  if (!persisted && !live) return undefined;
  const base = live ? {
    ...sessionSnapshotHeader(live),
    messages: [],
    steps: [],
    logs: [],
  } : persisted as BrowserChatSessionPage;
  if (!sessionBelongsToUser(base, userId)) return undefined;
  if (!persisted) {
    return {
      ...base,
      messages: live?.messages.slice(-80) || [],
      steps: live?.steps.slice(-120).map(compactStepForClient) || [],
      logs: compactBrowserChatLogsForClient(live?.logs.slice(-200) || []),
      history: {
        messages: { hasMore: false },
        steps: { hasMore: false },
        logs: { hasMore: false },
      },
    } satisfies BrowserChatSessionPage;
  }
  return {
    ...base,
    messages: persisted.messages,
    steps: persisted.steps.map(compactStepForClient),
    logs: compactBrowserChatLogsForClient(persisted.logs),
    history: persisted.history,
  } satisfies BrowserChatSessionPage;
}

export function getBrowserChatSessionHistory(
  sessionId: string,
  userId: string | number | undefined,
  input: {
    logCursor?: string;
    logLimit?: number;
    messageCursor?: string;
    messageLimit?: number;
    stepCursor?: string;
    stepLimit?: number;
  },
) {
  const session = sessions.get(sessionId) || readBrowserChatSessionHeader<BrowserChatSessionSnapshot>(sessionId);
  if (session && !sessionBelongsToUser(session, userId)) return undefined;
  if (!session) return undefined;
  const messages = input.messageCursor
    ? readBrowserChatMessagesPage<BrowserChatMessage>(sessionId, {
        cursor: input.messageCursor,
        limit: browserChatHistoryLimit(input.messageLimit, 80),
      })
    : undefined;
  const steps = input.stepCursor
    ? readBrowserChatStepsPage<StepExecutionResult>(sessionId, {
        cursor: input.stepCursor,
        limit: browserChatHistoryLimit(input.stepLimit, 120),
      })
    : undefined;
  const logs = input.logCursor
    ? readBrowserChatLogsPage<BrowserChatLogRecord>(sessionId, {
        cursor: input.logCursor,
        limit: browserChatHistoryLimit(input.logLimit, 200),
      })
    : undefined;
  return {
    outputCycles: session.outputCycles || [],
    subagents: session.subagents || [],
    ...(messages ? { messages: messages.items } : {}),
    ...(steps ? { steps: steps.items.map(compactStepForClient) } : {}),
    ...(logs ? { logs: compactBrowserChatLogsForClient(logs.items) } : {}),
    history: {
      ...(messages ? { messages: { cursor: messages.cursor, hasMore: messages.hasMore } } : {}),
      ...(steps ? { steps: { cursor: steps.cursor, hasMore: steps.hasMore } } : {}),
      ...(logs ? { logs: { cursor: logs.cursor, hasMore: logs.hasMore } } : {}),
    },
  };
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

export function getBrowserChatSessionLogs(
  sessionId: string,
  userId?: string | number,
  input: { cursor?: string; limit?: number; messageId?: string } = {},
) {
  const session = sessions.get(sessionId) || readBrowserChatSessionHeader<BrowserChatSessionSnapshot>(sessionId);
  if (session && !sessionBelongsToUser(session, userId)) return undefined;
  if (!session) return undefined;
  const page = readBrowserChatLogsPage<BrowserChatLogRecord>(sessionId, input);
  return {
    logs: page.items,
    history: { cursor: page.cursor, hasMore: page.hasMore },
  };
}

export function listBrowserChatSessions(input: { userId?: string | number } = {}) {
  const summaries = new Map(readSessionSummaries(input.userId).map((session) => [session.id, session]));
  for (const session of sessions.values()) summaries.set(session.id, summarySnapshot(session));
  return [...summaries.values()]
    .filter((session) => session.messages.length > 0 && sessionBelongsToUser(session, input.userId))
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

async function stopBrowserChatRuntime(
  session: BrowserChatSessionRecord,
  reason: Error,
  options: { forceBrowser?: boolean } = {},
) {
  revokeRegisteredBrowserChatTurn(activeTurns, session.id, reason);
  if (session.activeAbortController && !session.activeAbortController.signal.aborted) {
    session.activeAbortController.abort(reason);
  }
  cancelPendingToolConfirmation(session);

  // Block new preview/message work before waiting for a browser launch that is
  // already in flight. The completed launch is then closed below as well.
  transitionBrowserChatSession(session, { type: 'sessionClosed', at: now() });

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
  await Promise.all([...browsers].map((browser) => (
    browser.close({ closePages: true, force: options.forceBrowser }).catch(() => undefined)
  )));
  await closeBlockedBrowserChatSubagents(session.id, undefined, { force: true });
  scheduleBrowserChatUserIdleClose(session.userId);
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
  const persisted = persistAndNotify(sessionId, { deletedUserId: normalizeApplicationUserId(removed.session.userId) });
  const pendingWrite = pendingSqliteWrites.get(sessionId);
  if (!persisted || (pendingWrite && !(await pendingWrite))) {
    sessions.set(sessionId, removed.session);
    throw new Error('Browser chat session was removed from memory, but the database could not be updated.');
  }
  await deleteBrowserChatArtifacts(sessionId).catch((error) => warnPersistFailure(error));
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
  if (!session.busy) transitionBrowserChatSession(session, { type: 'sessionRecovered', at: session.updatedAt });
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
    onTabsChanged?: (tabs: BrowserTabSnapshot[]) => void;
    video?: boolean;
  },
) {
  const session = hydrateSession(sessionId);
  if (!session || session.status === 'closed') return undefined;
  if (!sessionBelongsToUser(session, userId)) return undefined;

  const browser = restoreBrowserSessionPrototype(session.browser);
  if (!browser || !session.started || !browser.isUsable()) {
    throw new Error('当前会话没有运行中的测试浏览器；打开预览不会自动启动或重新打开浏览器。');
  }
  const userKey = browserChatUserRuntimeKey(session.userId);
  cancelBrowserChatUserIdleClose(userKey);
  let handle: Awaited<ReturnType<BrowserSession['startScreencast']>>;
  try {
    handle = await browser.startScreencast({
      onActivePageChanged: handlers.onActivePageChanged,
      onError: handlers.onError,
      onFrame: (frame) => {
        session.targetUrl = exportableTargetUrl(frame.url) || session.targetUrl;
        return handlers.onFrame(frame);
      },
      onTabsChanged: (tabs) => {
        session.tabs = tabs;
        handlers.onTabsChanged?.(tabs);
      },
      video: handlers.video,
    });
  } catch (error) {
    scheduleBrowserChatUserIdleClose(userKey);
    throw error;
  }
  browserPreviewCounts.set(userKey, (browserPreviewCounts.get(userKey) || 0) + 1);
  let stopped = false;
  return {
    ...handle,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      try {
        await handle.stop();
      } finally {
        const remaining = Math.max(0, (browserPreviewCounts.get(userKey) || 1) - 1);
        if (remaining) browserPreviewCounts.set(userKey, remaining);
        else browserPreviewCounts.delete(userKey);
        scheduleBrowserChatUserIdleClose(userKey);
      }
    },
  };
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
  if (input.kind === 'tab' && result.ok) {
    session.updatedAt = now();
    persistAndNotify(session.id);
  }
  return result;
}

async function deleteBrowserChatSessionFromMemory(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  await stopBrowserChatRuntime(session, new Error('Browser chat session deleted by user.'));
  cancelBrowserChatSessionEviction(sessionId);
  sessions.delete(sessionId);
  persistenceCursors.delete(sessionId);
  dirtyRecords.delete(sessionId);
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
    const persisted = persistDeletedSessions(removed.map((item) => ({
      id: item.deleted.id,
      userId: normalizeApplicationUserId(item.session.userId),
    })));
    const pendingWrites = removed
      .map((item) => pendingSqliteWrites.get(item.deleted.id))
      .filter((item): item is Promise<boolean> => Boolean(item));
    const writesSucceeded = persisted && (await Promise.all(pendingWrites)).every(Boolean);
    if (!writesSucceeded) {
      for (const item of removed) sessions.set(item.deleted.id, item.session);
      throw new Error('Browser chat sessions were removed from memory, but the database could not be updated.');
    }
    await Promise.all(removed.map((item) => deleteBrowserChatArtifacts(item.deleted.id).catch((error) => warnPersistFailure(error))));
  }
  return { deleted, requested: uniqueIds.length };
}

export async function generateBrowserChatMessagesSkill(
  sessionId: string,
  messageIds: string[],
  userId: string | number | undefined,
  summaryDirection: string,
) {
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
    .filter((step) => selectedIdSet.has(step.messageId || '') || selectedStepIndexSet.has(step.index))
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
  const generated = await generateSkillFromBrowserHistory({
    browserMode: session.mode,
    consoleErrors: session.consoleErrors,
    constraints: `Skill 总结方向（必须优先遵循）：${compactText(summaryDirection, 2_000)}`,
    goal: turnDescriptions.join('\n\n') || titleSeed,
    networkErrors: session.networkErrors,
    sourceId: session.id,
    status: statusFromSteps(selectedSteps),
    steps: selectedSteps,
    targetUrl,
    title: `对话 Skill - ${compactText(titleSeed, 36)}`,
  });
  const skill = store.upsertSkill({
    title: generated.title,
    description: generated.description,
    domains: generated.domains,
    triggerPhrases: generated.triggerPhrases,
    content: generated.content,
    sourceSessionId: session.id,
    status: 'ready',
    userId: session.userId,
  });
  return { skill, sourceMessageIds: uniqueMessageIds };
}

export async function sendBrowserChatMessage(
  sessionId: string,
  content: string,
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
  const attachments = normalizeAttachments(attachmentsInput, session.userId);
  const skillIds = normalizeSkillIds(skillIdsInput);
  const selectedSkills = store.getSkills(skillIds, session.userId).filter((skill) => skill.status === 'ready');
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
  if (session.busy || activeTurns.has(session.id)) throw new Error('Browser chat session is already running');
  // Operation mode is shared application configuration. A conversation or
  // mounted user must never preserve or override an older mode value.
  store.applyRuntimeEnv();
  session.mode = configuredBrowserChatMode();
  cancelPendingToolConfirmation(session);
  cancelOrphanToolConfirmationsForSession(session.id);
  transitionBrowserChatSession(session, { type: 'confirmationCleared' });
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
  markMessageDirty(session, userMessage);
  markMessageDirty(session, assistantMessage);
  const abortController = new AbortController();
  registerBrowserChatTurn(activeTurns, session.id, {
    session,
    assistantMessageId: assistantMessage.id,
    abortController,
  });
  transitionBrowserChatSession(session, {
    type: 'turnStarted',
    assistantMessageId: assistantMessage.id,
    abortController,
    at: timestamp,
  });
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
  registerBrowserChatTurn(activeTurns, session.id, {
    session,
    assistantMessageId: paused.message.id,
    abortController,
  });
  transitionBrowserChatSession(session, {
    type: 'turnStarted',
    assistantMessageId: paused.message.id,
    abortController,
    at: timestamp,
  });
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
  markMessageDirty(session, session.messages[index]);
}

function appendBrowserChatOutputCycle(session: BrowserChatSessionRecord, cycle: BrowserChatAiOutputCycle) {
  session.outputCycles = [...(session.outputCycles || []), cycle];
  session.updatedAt = now();
}

function upsertBrowserChatSubagent(session: BrowserChatSessionRecord, record: BrowserChatSubagentRecord) {
  const current = session.subagents || [];
  const index = current.findIndex((item) => item.id === record.id);
  if (index < 0) session.subagents = [...current, record].sort((left, right) => left.index - right.index);
  else {
    const next = [...current];
    next[index] = record;
    session.subagents = next;
  }
  session.updatedAt = now();
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
  incrementMetric('browser_chat_persistence_errors_total');
  structuredLog({ event: 'browser_chat.persistence_failed', level: 'warn', error });
}

function runningAssistantActivity(step: StepExecutionResult, timestamp: string) {
  const latestTool = step.tools?.at(-1);
  if (latestTool?.recovered === true && latestTool.transient === true) {
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
  if (phase === 'ai:runtime:attempt') return message;
  if (phase === 'ai:runtime:request') return '正在请求 AI 模型';
  if (phase === 'ai:runtime:response') return 'AI 已返回，正在处理结果';
  if (phase === 'ai:runtime:object') return 'AI 已返回，正在解析动作';
  if (phase === 'ai:runtime:attempt-failed' || phase === 'ai:runtime:retry') return message;
  if (phase === 'ai:runtime:retry-exhausted') return 'AI 请求重试已耗尽';
  if (phase === 'ai:runtime:retry-skipped') return 'AI 请求失败，该错误不可重试';
  if (phase === 'ai:runtime:attempt-succeeded') return 'AI 已返回，正在处理结果';
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
    && registeredBrowserChatTurnIsActive(
      activeTurns,
      session.id,
      session,
      assistantMessageId,
      abortController,
    )
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
      .filter((key) => key !== 'reason')
      .sort()
      .map((key) => [key, omitToolPresentationFields(record[key])]));
  };
  try {
    return JSON.stringify(omitToolPresentationFields(value)) || '';
  } catch {
    return '';
  }
}

function browserChatToolConfirmationScope(
  session: BrowserChatSessionRecord,
  request: BrowserToolConfirmationRequest,
) {
  let inputText = '';
  try {
    inputText = JSON.stringify(request.input) || '';
  } catch {
    inputText = '';
  }
  const text = `${request.prompt}\n${request.reason || ''}\n${inputText}`.toLowerCase();
  const operations: Array<[string, RegExp]> = [
    ['delete', /\b(?:delete|remove|destroy)\b|删除|移除|清空/],
    ['payment', /\b(?:pay|purchase|checkout|order|transfer)\b|支付|购买|下单|转账/],
    ['publish', /\b(?:publish|send|approve|authorize)\b|发布|发送|批准|授权/],
    ['logout', /\blogout\b|退出登录|登出/],
    ['login', /\blogin\b|登录/],
    ['submit', /\bsubmit\b|提交|确认/],
  ];
  const operation = operations.find(([, pattern]) => pattern.test(text))?.[0];
  if (!operation) return undefined;
  const currentUrl = session.browser?.currentUrl() || session.targetUrl;
  let origin = currentUrl;
  try {
    origin = new URL(currentUrl).origin;
  } catch {
    origin = currentUrl || 'unknown-origin';
  }
  return `${request.toolName}:${operation}:${origin}`;
}

function createBrowserChatTurnToolConfirmation(
  session: BrowserChatSessionRecord,
  assistantMessageId: string,
  abortSignal: AbortSignal,
) {
  const confirmedScopes = new Set<string>();
  return async (request: BrowserToolConfirmationRequest): Promise<BrowserToolConfirmationDecision> => {
    const scope = browserChatToolConfirmationScope(session, request);
    if (scope && confirmedScopes.has(scope)) {
      appendLog(session, 'tool:confirmation:reused', `已复用本轮用户对 ${request.prompt} 的确认。`, {
        stepIndex: request.stepIndex,
        messageId: assistantMessageId,
        details: { scope, toolName: request.toolName },
      });
      return 'confirmed';
    }
    const decision = await requestBrowserChatToolConfirmation(
      session,
      assistantMessageId,
      request,
      abortSignal,
    );
    if (decision === 'confirmed' && scope) confirmedScopes.add(scope);
    return decision;
  };
}

function cancelPendingToolConfirmation(session: BrowserChatSessionRecord) {
  const pending = session.pendingToolConfirmation;
  if (!pending) return false;
  const resolver = toolConfirmations.get(pending.id);
  if (resolver) {
    resolver.resolve('cancelled');
  } else {
    transitionBrowserChatSession(session, { type: 'confirmationCleared' });
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
        transitionBrowserChatSession(session, { type: 'confirmationCleared' });
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
    transitionBrowserChatSession(session, {
      type: 'confirmationPending',
      confirmation: pending,
      at: requestedAt,
    });
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
    transitionBrowserChatSession(session, { type: 'confirmationCleared', at: now() });
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
  // Prefer the live runtime record. Interrupt must not wait for persistence
  // rehydration while an AI request is actively running.
  const registeredTurn = activeTurns.get(sessionId);
  const session = sessions.get(sessionId) || registeredTurn?.session || hydrateSession(sessionId);
  if (!session) return undefined;
  if (!sessionBelongsToUser(session, userId)) return undefined;
  const timestamp = now();
  const reason = new Error('Browser chat operation interrupted by user.');
  transitionBrowserChatSession(session, { type: 'turnStopping', at: timestamp });
  const assistantMessageIds = new Set([
    registeredTurn?.assistantMessageId,
    session.activeAssistantMessageId,
    latestRunningAssistantMessageId(session),
  ].filter((value): value is string => Boolean(value)));
  const assistantMessageId = registeredTurn?.assistantMessageId
    || session.activeAssistantMessageId
    || latestRunningAssistantMessageId(session);

  // Delete the execution registration before dispatching abort. This is the
  // irreversible stop boundary: persisted state, delayed request retries, and
  // child-Agent completions cannot recreate ownership for this execution.
  for (const messageId of assistantMessageIds) markAssistantMessageInterrupted(messageId);
  const registeredRevocation = revokeRegisteredBrowserChatTurn(activeTurns, sessionId, reason);
  const runtimeRecords = new Set<BrowserChatSessionRecord>([
    session,
    ...(registeredTurn?.session ? [registeredTurn.session] : []),
  ]);
  let sessionAbortDispatched = false;
  for (const runtimeRecord of runtimeRecords) {
    cancelPendingToolConfirmation(runtimeRecord);
    const revoked = revokeBrowserChatTurn(runtimeRecord, timestamp, reason);
    sessionAbortDispatched ||= revoked.abortDispatched;
    if (assistantMessageIds.size === 0) {
      preserveInterruptedTurn(runtimeRecord, undefined, timestamp);
    } else {
      for (const messageId of assistantMessageIds) {
        preserveInterruptedTurn(runtimeRecord, messageId, timestamp);
      }
    }
  }
  preserveInterruptedSubagents(session.id, assistantMessageId);
  void closeBlockedBrowserChatSubagents(session.id, assistantMessageId);

  replaceSessionLogs(session, [
    ...(session.logs || []),
    {
      id: id('log'),
      time: timestamp,
      phase: 'chat:interrupt:completed',
      message: '已立即撤销当前回合并向正在执行的请求发送中止信号。',
      details: safeJson({
        assistantMessageId,
        abortDispatched: Boolean(registeredRevocation?.abortDispatched || sessionAbortDispatched),
        executionRevoked: Boolean(registeredTurn),
      }),
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
  const session = sessions.get(sessionId);
  if (session) {
    upsertBrowserChatSubagent(session, {
      id: record.uuid,
      messageId: record.assistantMessageId,
      batchId: record.batchId,
      index: record.index,
      title: record.title,
      status: record.status,
      summary: record.summary || undefined,
      resumable: blockedSubagents.has(record.uuid),
      toolCount: record.steps.reduce((count: number, step: StepExecutionResult) => count + (step.tools || []).length, 0),
      steps: [...record.steps],
      error: record.error,
    });
  }
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
          error: '该子 Agent 仍在执行中；spawnSubagents 的批次屏障尚未完成。',
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
    upsertBrowserChatSubagent(session, {
      id: task.id,
      messageId: assistantMessageId,
      batchId,
      index,
      title: task.title,
      status: 'running',
      resumable: false,
      toolCount: 0,
      steps: [],
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
    const browserProfileKey = browserChatBrowserProfileKey(session);
    const child = new BrowserSession(session.mode, {
      browserSurface: 'external',
      headless: true,
      browserProfileKey,
      sharedBrowserRuntimeKey: browserProfileKey,
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
      if (!ownsTurn()) throw abortController.signal.reason || new Error('对话已中断');
      if (task.url) await child.open(task.url);
      if (!ownsTurn()) throw abortController.signal.reason || new Error('对话已中断');
      const getRuntimeOperationalContext = createBrowserChatRuntimeOperationalContext({
        session,
        browser: child,
        text: task.instruction,
        modelText: task.instruction,
      });
      const initialRuntimeContext = getRuntimeOperationalContext();
      const result = await executeInteractiveBrowserTurn({
        session: child,
        runId: `${session.id}_${task.id}`,
        turnId: `${assistantMessageId}:subagent:${task.id}`,
        targetUrl: task.url || session.targetUrl || child.currentUrl() || 'about:blank',
        instruction: task.instruction,
        modelInstruction: [
          `你是并行子 Agent“${task.title}”。只完成这个独立分支，并返回可追溯事实、来源地址、页面证据、失败原因和未解决问题。`,
          '你拥有完整浏览器工具集。不要等待其他子 Agent，也不要因为其他分支失败而停止。',
          inheritedStorageState
            ? '无头浏览器已经复制主会话当前的 Cookie、localStorage 和 IndexedDB 登录态。请先直接访问目标地址验证登录态，不要重新登录。'
            : '主会话当前没有可复制的浏览器登录态；如果目标页面要求登录，请明确返回登录阻塞，不要猜测页面内容。',
          '你运行在无头浏览器中。遇到必须由用户处理的验证码、扫码、OTP 或设备确认时，不要等待用户操作隐藏页面；请明确报告阻塞证据并把该步骤交回主 Agent。',
          session.mode === 'code'
            ? '浏览器检查与操作统一使用 browserCode，在一个受限程序中直接调用真实 Playwright page/context，并返回可追溯的结构化证据。'
            : '浏览器检查与操作使用 inspect 获取当前结构化页面状态，再使用 browser/interact 完成动作；只操作 inspect 返回的可见、可交互节点。',
          '只有已经发现明确的懒加载、虚拟列表或无限滚动证据，且目标内容尚未加载时才滚动；不要把滚动当作默认页面读取方式。',
          summaryGuidanceChars
            ? `完成工具执行后，直接在你自己的最终回复中写出信息完整、可独立使用的执行总结。配置建议将篇幅控制在约 ${summaryGuidanceChars} 个字符以内，但这不是截断上限；如果完整证据需要更长内容，必须完整返回。优先覆盖来源 URL、已验证事实、字段和表格、图片与 iframe 信息、失败步骤、限制、未读取区域和未解决项；不要为凑字数重复内容。不要再启动子 Agent，也不要要求主 Agent 另行读取结果。`
            : '完成工具执行后，直接在你自己的最终回复中写出信息完整、可独立使用的执行总结。优先覆盖来源 URL、已验证事实、字段和表格、图片与 iframe 信息、失败步骤、限制、未读取区域和未解决项；不要为凑字数重复内容。不要再启动子 Agent，也不要要求主 Agent 另行读取结果。',
          task.instruction,
        ].filter(Boolean).join('\n\n'),
        operationalContext: initialRuntimeContext.operationalContext,
        conversation: [],
        completedSteps: [],
        mode: session.mode,
        safetyMode: session.safetyMode,
        useToolLoopAgent: true,
        credentialBindings: initialRuntimeContext.credentialBindings,
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
          const outputCycle = browserChatAiOutputCycleFromDebugEvent({
            details: event.details,
            id: id('cycle'),
            messageId: assistantMessageId,
            phase: event.phase,
            stepIndex: event.stepIndex,
            subagentId: task.id,
            batchId,
          });
          if (outputCycle) appendBrowserChatOutputCycle(session, outputCycle);
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
            elapsedMs: elapsedFromDetails(eventDetails),
            details: event.phase === 'ai:runtime:response' || event.phase === 'ai:runtime:object'
              ? fullLogDetails({ batchId, id: task.id, index, title: task.title, childStepIndex: event.stepIndex, event: eventDetails })
              : { batchId, id: task.id, index, title: task.title, childStepIndex: event.stepIndex, event: eventDetails },
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
      next: '使用 readSubagent({ uuid }) 每次读取一个结果；如需读取其他结果，必须在后续模型步骤逐个调用。',
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
    text: binding.task.instruction,
    modelText: binding.task.instruction,
  });
  const initialRuntimeContext = getRuntimeOperationalContext();
  try {
    const result = await withModelSettings(browserChatModelSettings(session.modelProvider, session.model), () => executeInteractiveBrowserTurn({
      session: binding.browser,
      runId: `${session.id}_${binding.id}_verification_resume`,
      turnId: `${assistantMessageId}:subagent:${binding.id}:verification-resume`,
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
      useToolLoopAgent: true,
      credentialBindings: initialRuntimeContext.credentialBindings,
      getRuntimeOperationalContext,
      abortSignal: abortController.signal,
      shouldContinue: ownsTurn,
      requestToolConfirmation: session.safetyMode === 'strict'
        ? (request) => requestBrowserChatToolConfirmation(session, assistantMessageId, request, abortController.signal)
        : undefined,
      onProgress: (step) => {
        if (!ownsTurn()) return;
        const nextSteps = [...binding.steps.filter((item) => item.index !== step.index), step].sort((left, right) => left.index - right.index);
        binding.steps = nextSteps;
        updateBrowserChatStoredSubagent(session.id, binding.id, {
          status: step.status === 'queued' ? 'running' : step.status,
          steps: nextSteps,
        });
        appendLog(session, `subagent:${binding.id}:progress`, `${binding.title}：${step.action || '正在继续'}`, {
          details: { id: binding.id, title: binding.title, status: step.status, step },
          messageId: assistantMessageId,
          deferPersist: true,
        });
      },
      onDebug: (event) => {
        if (!ownsTurn()) return;
        const outputCycle = browserChatAiOutputCycleFromDebugEvent({
          details: event.details,
          id: id('cycle'),
          messageId: assistantMessageId,
          phase: event.phase,
          stepIndex: event.stepIndex,
          subagentId: binding.id,
        });
        if (outputCycle) appendBrowserChatOutputCycle(session, outputCycle);
        const eventDetails = unwrapLogDetails(event.details).value;
        appendLog(session, `subagent:${binding.id}:${event.phase}`, event.message, {
          elapsedMs: elapsedFromDetails(eventDetails),
          details: event.phase === 'ai:runtime:response' || event.phase === 'ai:runtime:object'
            ? fullLogDetails({ id: binding.id, title: binding.title, childStepIndex: event.stepIndex, event: eventDetails })
            : { id: binding.id, title: binding.title, childStepIndex: event.stepIndex, event: eventDetails },
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
    updateBrowserChatStoredSubagent(session.id, binding.id, {
      status: result.status,
      summary,
      steps: result.steps,
      error: undefined,
    });
    if (result.status === 'blocked') {
      const timestamp = now();
      updateAssistantMessage(session, assistantMessageId, (message) => ({
        ...message,
        content: summary,
        status: 'blocked',
        activity: undefined,
        updatedAt: timestamp,
      }));
      clearRegisteredBrowserChatTurn(activeTurns, session.id, assistantMessageId, abortController);
      transitionBrowserChatSession(session, { type: 'turnBlocked', at: timestamp });
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
    clearRegisteredBrowserChatTurn(activeTurns, session.id, assistantMessageId, abortController);
    transitionBrowserChatSession(session, { type: 'turnFinished', at: timestamp, error: message });
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
        text,
        modelText,
        explicitlySelectedSkills: skills,
      });
      const initialRuntimeContext = getRuntimeOperationalContext();
      appendLog(session, 'ai:prepare', '正在请求 AI 判断是否需要浏览器工具');
      const referenceImagePaths = attachments
        .filter(isBrowserChatImageAttachment)
        .map((attachment) => uploadedBrowserChatAttachmentPath(attachment, session.userId))
        .filter((item): item is string => Boolean(item));
      const requestTurnToolConfirmation = session.safetyMode === 'strict'
        ? createBrowserChatTurnToolConfirmation(session, assistantMessageId, abortController.signal)
        : undefined;
      const result = await executeInteractiveBrowserTurn({
        session: browser,
        runId: session.id,
        turnId: assistantMessageId,
        targetUrl: session.targetUrl || 'about:blank',
        instruction: text,
        modelInstruction: modelText,
        operationalContext: initialRuntimeContext.operationalContext,
        conversation: conversationForPrompt(session.messages, session.conversationContext, userMessageId, session.userId),
        completedSteps: session.steps,
        mode: session.mode,
        safetyMode: session.safetyMode,
        memoryTools: createPersonalMemoryTools({
          userId: session.userId,
          currentUrl: browserChatMemoryUrl(browser, session),
          sourceSessionId: session.id,
          sourceMessageIds: [userMessageId, assistantMessageId],
          userMessages: session.messages
            .filter((message) => message.role === 'user')
            .map((message) => message.content),
        }),
        referenceImagePaths,
        credentialBindings: initialRuntimeContext.credentialBindings,
        getRuntimeOperationalContext,
        abortSignal: abortController.signal,
        shouldContinue: () => isActiveBrowserChatTurn(session, assistantMessageId, abortController),
        requestToolConfirmation: requestTurnToolConfirmation,
        ensureBrowserStarted: async () => {
          assertTurnActive();
          const startedBrowser = await ensureStarted(session, assertTurnActive);
          assertTurnActive();
          if (startedBrowser !== browser) throw new Error('Browser session changed while the AI was deciding; retry this browser tool on the active session.');
        },
        runSubagents: (tasks, _abortSignal, toolCallId) => runBrowserChatSubagents({ session, assistantMessageId, abortController, tasks, toolCallId }),
        readSubagent: readBrowserChatSubagent(session.id),
        readFile: (input) => readFileForSession(session, input),
        attachmentBindings: browserCodeAttachmentBindingsForSession(session),
        onTextStream: ({ text: streamedText }) => {
          if (!isActiveBrowserChatTurn(session, assistantMessageId, abortController)) return;
          const timestamp = now();
          updateAssistantMessage(session, assistantMessageId, (message) => ({
            ...message,
            content: streamedText,
            activity: {
              phase: 'ai:text:streaming',
              label: 'AI 正在生成回复',
              updatedAt: timestamp,
            },
            status: 'running',
            updatedAt: timestamp,
          }));
          session.updatedAt = timestamp;
          scheduleBrowserChatTextStreamPublish(session.id, assistantMessageId);
          persistAndNotify(session.id, { defer: true, mergePersisted: false });
        },
        onProgress: (step) => {
          if (!isActiveBrowserChatTurn(session, assistantMessageId, abortController)) return;
          const ownedStep = { ...step, messageId: assistantMessageId };
          const index = session.steps.findIndex((item) => item.index === step.index);
          if (index >= 0) session.steps[index] = { ...session.steps[index], ...ownedStep };
          else session.steps.push(ownedStep);
          markStepDirty(session, session.steps.find((item) => item.index === step.index) || ownedStep);
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
          const outputCycle = browserChatAiOutputCycleFromDebugEvent({
            details: event.details,
            id: id('cycle'),
            messageId: assistantMessageId,
            phase: event.phase,
            stepIndex: event.stepIndex,
          });
          if (outputCycle) appendBrowserChatOutputCycle(session, outputCycle);
          const persistImmediately = event.phase === 'ai:runtime:request'
            || event.phase === 'ai:runtime:response'
            || event.phase === 'ai:tool'
            || event.phase === 'ai:runtime:attempt'
            || event.phase === 'ai:runtime:attempt-failed'
            || event.phase === 'ai:runtime:attempt-succeeded'
            || event.phase === 'ai:runtime:retry'
            || event.phase === 'ai:runtime:retry-exhausted'
            || event.phase === 'ai:runtime:retry-skipped';
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
      replaceSessionSteps(session, result.steps.map((step) => (
        step.index >= fromStepIndex ? { ...step, messageId: assistantMessageId } : step
      )));
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
      const keepCompletedBrowser = browserWasStarted
        && (result.status === 'blocked' || browserChatKeepBrowserOpenAfterTurn())
        && Boolean(session.browser?.isUsable());
      const shouldCloseCompletedBrowser = result.status !== 'blocked' && browserWasStarted && !keepCompletedBrowser;
      if (shouldCloseCompletedBrowser) {
        await session.browser?.close().catch(() => undefined);
        session.browser = undefined;
        session.started = false;
      } else if (!browserWasStarted && session.browser === browser) {
        session.browser = undefined;
      }
      clearRegisteredBrowserChatTurn(activeTurns, session.id, assistantMessageId, abortController);
      if (result.status === 'blocked') {
        transitionBrowserChatSession(session, { type: 'turnBlocked', at: completedAt });
      } else {
        transitionBrowserChatSession(session, { type: 'turnFinished', at: completedAt });
      }
      replaceSessionLogs(session, [
        ...(session.logs || []),
        {
          id: id('log'),
          time: completedAt,
          phase: result.status === 'blocked' ? 'chat:run:blocked' : 'chat:run:done',
          message: result.status === 'blocked'
            ? '已暂停自动操作，等待用户完成人工验证后继续。'
            : shouldCloseCompletedBrowser
            ? '本轮对话操作已完成，最终结果已写入，浏览器已自动关闭。'
            : keepCompletedBrowser
              ? '本轮对话操作已完成，最终结果已写入，浏览器已保留供后续对话复用。'
              : browserWasStarted
                ? '本轮对话操作已完成，最终结果已写入。'
                : '本轮对话已直接完成，没有创建浏览器标签。',
          messageId: assistantMessageId,
        },
      ]);
      await persistAndNotifyTerminal(session.id);
      if (result.status !== 'blocked') scheduleBrowserChatUserIdleClose(session.userId);
      void enforceBrowserChatArtifactQuota(session.id).catch((error) => warnPersistFailure(error));
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
      transitionBrowserChatSession(session, {
        type: 'turnFinished',
        at: now(),
        error: message,
        interrupted,
      });
      updateAssistantMessage(session, assistantMessageId, (item) => ({
        ...item,
        content: interrupted ? browserChatInterruptedReply : `执行异常：${message}`,
        updatedAt: session.updatedAt,
        status: interrupted ? 'interrupted' : 'failed',
        activity: undefined,
      }));
      clearRegisteredBrowserChatTurn(activeTurns, session.id, assistantMessageId, abortController);
      await persistAndNotifyTerminal(session.id);
      scheduleBrowserChatUserIdleClose(session.userId);
    } finally {
      clearRegisteredBrowserChatTurn(activeTurns, session.id, assistantMessageId, abortController);
      if (session.pendingToolConfirmation?.messageId === assistantMessageId) {
        cancelPendingToolConfirmation(session);
        transitionBrowserChatSession(session, { type: 'confirmationCleared' });
      }
      transitionBrowserChatSession(session, {
        type: 'turnRuntimeReleased',
        assistantMessageId,
        abortController,
      });
    }
  });
}
