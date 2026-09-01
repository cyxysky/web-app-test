import { createHash, randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { BrowserSession, type BrowserActionResult, type BrowserLiveInput, type BrowserLiveNativeEvent, type BrowserScreencastFrame, type BrowserTabSnapshot } from '@/server/browser/browser-session';
import type {
  BrowserCodeAttachmentBinding,
  BrowserCodeCredentialBinding,
} from '@/server/browser/browser-code-runner';
import { normalizeApplicationUserId } from '@/server/auth/user-context';
import { readBrowserDomainCookies } from '@/server/credentials/browser-domain-cookie-vault';
import { incrementMetric, structuredLog } from '@/server/observability/runtime-observability';
import { archiveAiOperationsChatSession } from '@/server/observability/ai-operations-chat-archive';
import { artifactContentType } from '@/server/files/file-format-registry';
import {
  executeInteractiveBrowserTurn,
  type BrowserToolConfirmationDecision,
  type BrowserToolConfirmationRequest,
  type BrowserChatReadFileInput,
  type BrowserChatSubagentReader,
  type BrowserChatSubagentTask,
  type InteractiveBrowserTurnResult,
} from '@/server/ai/agents/browser-chat-executor.agent';
import { generateSkillFromBrowserHistory } from '@/server/ai/agents/skill-generator.agent';
import {
  browserChatAttachmentMetadata,
  isBrowserChatImageAttachment,
  readBrowserChatAttachment,
  readBrowserChatFileVisuals,
  type BrowserChatFileVisualInput,
} from '@/server/ai/agents/browser-chat-attachment-reader';
import {
  normalizeBrowserChatAttachments,
  normalizeBrowserChatUploadPath,
  uploadedBrowserChatAttachmentPath,
  type BrowserChatAttachment,
} from '@/server/ai/agents/browser-chat-attachments';
import { browserChatFirstMessageTitle } from '@/server/ai/agents/browser-chat-message-title';
import { browserChatSessionTitleParts } from '@/lib/browser-chat-title';
import {
  browserChatArtifactsFromSteps,
  mergeBrowserChatArtifactSummaries,
  type BrowserChatArtifactSummary,
} from '@/lib/browser-chat-artifacts';
import {
  appendInterruptedBrowserChatTurn,
  appendTerminalBrowserChatTurn,
  compactBrowserChatModelTranscript,
  normalizeBrowserChatModelContext,
  serializableBrowserChatModelMessages,
  type BrowserChatModelContext,
} from '@/server/ai/agents/browser-chat-model-context';
import {
  estimateRuntimeMessageContext,
  runtimeContextWindowTokens,
} from '@/server/ai/agents/runtime-context-budget';
import { browserChatContextUsageFromDebugRecord } from '@/server/ai/agents/browser-chat-context-usage';
import {
  alignBrowserChatMessageStepIndexes,
  attachBrowserChatStepOwners,
} from '@/server/ai/agents/browser-chat-step-ownership';
import {
  browserChatSubagentConfirmationMessage,
  browserChatSubagentInputMessage,
  browserChatSubagentMessagesFromModelMessages,
  browserChatSubagentMessagesFromProgress,
  browserChatSubagentSuggestedSummaryChars,
  limitBrowserChatSubagentMessages,
  preserveBrowserChatSubagentSummary,
  resolvedBrowserChatSubagentStatus,
  runBrowserChatSubagentAttemptWithRetry,
  runOrReuseBrowserChatSubagentBatch,
  settleBrowserChatSubagents,
  type BrowserChatSubagentConfirmationInteraction,
} from '@/server/ai/agents/browser-chat-subagents';
import {
  clearRegisteredBrowserChatTurn,
  registerBrowserChatTurn,
  registeredBrowserChatTurnIsActive,
  revokeBrowserChatTurn,
  revokeRegisteredBrowserChatTurn,
  revokeRegisteredBrowserChatTurnByAssistantMessageId,
  runtimeSnapshotIsNewer,
  type RegisteredBrowserChatTurn,
} from '@/server/ai/agents/browser-chat-interrupt-state';
import {
  normalizeBrowserChatTurnState,
  transitionBrowserChatSession,
  type BrowserChatTurnState,
} from '@/server/ai/agents/browser-chat-session-state';
import {
  formatLoadedSkillsForPrompt,
  formatSkillReferencesForUser,
  formatSkillSummariesForPrompt,
  runtimeSkills,
} from '@/server/ai/agents/skill-context';
import { expandMultilingualRetrievalQuery } from '@/server/ai/retrieval-query';
import { isBrowserChatDomObservationText, normalizeBrowserChatFinalReplyText } from '@/server/ai/agents/browser-chat-reply-text';
import { officeDraftCatalogForPrompt } from '@/server/ai/agents/file-artifact-tools';
import {
  extractPersonalMemoryFromTurn,
  formatPersonalMemoryForPrompt,
  markPersonalMemoryItemsUsed,
  normalizePersonalMemoryDomain,
  personalMemoryEnabled,
  searchPersonalMemory,
} from '@/server/ai/personal-memory';
import { createPersonalMemoryTools } from '@/server/ai/personal-memory-tools';
import { withModelSettings } from '@/server/ai/model';
import { modelCapabilities } from '@/lib/model-capabilities';
import { ApiRequestError } from '@/server/http/api-request';
import { compactBrowserChatLogsForClient } from '@/server/ai/agents/browser-chat-log-client';
import {
  compactBrowserChatLogDetails,
  trimBrowserChatRuntimeItems,
  trimBrowserChatRuntimeLogs,
} from '@/server/ai/agents/browser-chat-runtime-memory';
import {
  activeBrowserChatAssistantMessage,
  browserChatClientRecordsForMessage,
} from '@/server/ai/agents/browser-chat-client-window';
import {
  browserChatAiOutputCycleFromDebugEvent,
  sortBrowserChatAiOutputCycles,
} from '@/lib/browser-chat-output-cycles';
import type {
  BrowserChatAiOutputCycle,
  BrowserChatSubagentMessage,
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
  BROWSER_CHAT_MESSAGE_PAGE_SIZE,
  readAllBrowserChatMessages,
  readAllBrowserChatSteps,
  readBrowserChatSessionHeader,
  readBrowserChatSessionOwner,
  readBrowserChatSessionWindow,
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
import { artifactPath, artifactsRoot } from '@/server/storage/paths';
import { enabledModelProviders, normalizeModelProvider, resolveRuntimeModelSelection } from '@/lib/model-selection';
import {
  listLoginAccounts,
  resolveLoginAccountCredentialById,
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
  artifacts?: BrowserChatArtifactSummary[];
  activity?: {
    phase: string;
    label: string;
    updatedAt: string;
  };
  status?: 'queued' | 'running' | 'passed' | 'failed' | 'blocked' | 'interrupted';
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

export type BrowserChatSafetyMode = 'strict' | 'full';

export type BrowserChatQueuedTurn = {
  id: string;
  userMessageId: string;
  safetyMode: BrowserChatSafetyMode;
  modelProvider: ModelProvider;
  model: string;
  queuedAt: string;
};

export type BrowserChatToolConfirmation = {
  id: string;
  messageId: string;
  subagentId?: string;
  stepIndex?: number;
  toolName: string;
  inputSignature: string;
  reason?: string;
  prompt: string;
  screenshotUrl?: string;
  requestedAt: string;
};

export type BrowserChatSessionSnapshot = {
  id: string;
  title: string;
  titleFileName?: string;
  userId?: string;
  browserGroupId: string;
  targetUrl: string;
  noVncUrl?: string;
  safetyMode: BrowserChatSafetyMode;
  modelProvider: ModelProvider;
  model: string;
  status: 'idle' | 'running' | 'closed' | 'error';
  turnState?: BrowserChatTurnState;
  busy: boolean;
  hasMessages?: boolean;
  contextUsage?: BrowserChatContextUsage;
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
  queuedTurns: BrowserChatQueuedTurn[];
  pendingToolConfirmation?: BrowserChatToolConfirmation;
};

export type BrowserChatContextUsage = {
  currentTokens: number;
  imageTokens: number;
  maxTokens: number;
  textTokens: number;
  toolTokens: number;
};

type BrowserChatPersistedSessionSnapshot = BrowserChatSessionSnapshot & {
  modelContext?: BrowserChatModelContext;
};

type BrowserChatSessionRecord = Omit<BrowserChatPersistedSessionSnapshot, 'turnState'> & {
  turnState: BrowserChatTurnState;
  modelContext: BrowserChatModelContext;
  activeAssistantMessageId?: string;
  activeAbortController?: AbortController;
  browser?: BrowserSession;
  started: boolean;
  runtimeCompacted?: boolean;
  runtimeHasPersistedMessages?: boolean;
  usedMemoryIdsByTurn?: Map<string, Set<string>>;
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
  outputCycles: BrowserChatAiOutputCycle[];
};

type BrowserChatStoredSubagent = {
  uuid: string;
  batchId: string;
  sessionId: string;
  assistantMessageId: string;
  index: number;
  title: string;
  task: BrowserChatSubagentTask;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'blocked';
  content: string;
  summary: string;
  summaryChars: number;
  summaryOriginalChars: number;
  summaryTruncated: boolean;
  toolCount: number;
  currentAction?: string;
  steps: StepExecutionResult[];
  outputCycles: BrowserChatAiOutputCycle[];
  messages: BrowserChatSubagentMessage[];
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
  selectedSessionIds: Map<string, string>;
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
  selectedSessionIds: new Map<string, string>(),
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
browserChatRuntimeState.selectedSessionIds ??= new Map();
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
const selectedSessionIds = browserChatRuntimeState.selectedSessionIds;
const persistenceCursors = browserChatRuntimeState.persistenceCursors;
const dirtyRecords = browserChatRuntimeState.dirtyRecords;
const browserIdleEpochs = browserChatRuntimeState.browserIdleEpochs;
const browserIdleTimers = browserChatRuntimeState.browserIdleTimers;
const browserPreviewCounts = browserChatRuntimeState.browserPreviewCounts;

type BrowserChatMemoryEstimate = {
  bytes: number;
  nodes: number;
  truncated: boolean;
  seen: WeakSet<object>;
};

function estimateBrowserChatRetainedValue(value: unknown, estimate: BrowserChatMemoryEstimate, depth = 0) {
  if (estimate.nodes >= 50_000) {
    estimate.truncated = true;
    return;
  }
  if (typeof value === 'string') {
    estimate.nodes += 1;
    estimate.bytes += Buffer.byteLength(value, 'utf8');
    return;
  }
  if (typeof value !== 'object' || value === null || depth >= 8) return;
  if (estimate.seen.has(value)) return;
  estimate.seen.add(value);
  estimate.nodes += 1;
  if (Buffer.isBuffer(value)) {
    estimate.bytes += value.byteLength;
    return;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    estimate.bytes += value.byteLength;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) estimateBrowserChatRetainedValue(item, estimate, depth + 1);
    return;
  }
  for (const child of Object.values(value)) {
    estimateBrowserChatRetainedValue(child, estimate, depth + 1);
  }
}

function browserChatMemoryDiagnostics() {
  const totals = {
    messages: 0,
    steps: 0,
    logs: 0,
    outputCycles: 0,
    subagents: 0,
    queuedTurns: 0,
    modelTranscriptMessages: 0,
    activeModelMessages: 0,
  };
  const estimate: BrowserChatMemoryEstimate = {
    bytes: 0,
    nodes: 0,
    truncated: false,
    seen: new WeakSet(),
  };
  let sessionsWithBrowser = 0;
  for (const session of sessions.values()) {
    if (session.browser) sessionsWithBrowser += 1;
    totals.messages += session.messages.length;
    totals.steps += session.steps.length;
    totals.logs += session.logs.length;
    totals.outputCycles += session.outputCycles.length;
    totals.subagents += session.subagents.length;
    totals.queuedTurns += session.queuedTurns.length;
    totals.modelTranscriptMessages += session.modelContext.transcript.length;
    totals.activeModelMessages += session.modelContext.activeMessages.length;
    estimateBrowserChatRetainedValue(session.messages, estimate);
    estimateBrowserChatRetainedValue(session.steps, estimate);
    estimateBrowserChatRetainedValue(session.logs, estimate);
    estimateBrowserChatRetainedValue(session.outputCycles, estimate);
    estimateBrowserChatRetainedValue(session.subagents, estimate);
    estimateBrowserChatRetainedValue(session.modelContext, estimate);
  }
  return {
    runtimeSessions: sessions.size,
    sessionsWithBrowser,
    selectedSessions: selectedSessionIds.size,
    activeTurns: activeTurns.size,
    browserStarts: browserStartPromises.size,
    blockedSubagents: blockedSubagents.size,
    subagentResultSessions: subagentResults.size,
    pendingToolConfirmations: toolConfirmations.size,
    pendingPersistTimers: pendingPersistTimers.size,
    pendingSqliteWrites: pendingSqliteWrites.size,
    persistenceCursors: persistenceCursors.size,
    dirtyRecordSets: dirtyRecords.size,
    memoryExtractionActive: browserChatRuntimeState.memoryExtractionActive,
    memoryExtractionQueued: browserChatRuntimeState.memoryExtractionQueue.length,
    browserPreviewSessions: browserPreviewCounts.size,
    retained: totals,
    retainedPayloadEstimateMb: Math.round(estimate.bytes / 1024 / 1024 * 10) / 10,
    retainedPayloadSampleNodes: estimate.nodes,
    retainedPayloadEstimateTruncated: estimate.truncated,
  };
}

export type BrowserChatRuntimeBrowser = {
  id: string;
  kind: 'session' | 'subagent';
  sessionId: string;
  userId: string;
  title: string;
  status: string;
  busy: boolean;
  tabCount: number;
  currentUrl: string;
  updatedAt: string;
};

export function readBrowserChatRuntimeStatus() {
  const browsers: BrowserChatRuntimeBrowser[] = [];
  for (const session of sessions.values()) {
    const browser = restoreBrowserSessionPrototype(session.browser);
    if (!browser?.isUsable()) continue;
    browsers.push({
      id: `session:${session.id}`,
      kind: 'session',
      sessionId: session.id,
      userId: session.userId || '',
      title: session.title || session.id,
      status: session.status,
      busy: session.busy || activeTurns.has(session.id),
      tabCount: browser.getTabsSnapshot().length,
      currentUrl: browser.currentUrl(),
      updatedAt: session.updatedAt,
    });
  }
  for (const binding of blockedSubagents.values()) {
    const session = sessions.get(binding.sessionId);
    const browser = restoreBrowserSessionPrototype(binding.browser);
    if (!browser?.isUsable()) continue;
    browsers.push({
      id: `subagent:${binding.id}`,
      kind: 'subagent',
      sessionId: binding.sessionId,
      userId: session?.userId || '',
      title: binding.title,
      status: 'blocked',
      busy: false,
      tabCount: browser.getTabsSnapshot().length,
      currentUrl: browser.currentUrl(),
      updatedAt: session?.updatedAt || now(),
    });
  }
  return {
    diagnostics: browserChatMemoryDiagnostics(),
    activeConversations: new Set([
      ...activeTurns.keys(),
      ...[...sessions.values()]
        .filter((session) => session.busy || session.queuedTurns.length > 0)
        .map((session) => session.id),
    ]).size,
    browserCount: browsers.length,
    browsers: browsers.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
  };
}

const memoryDiagnosticProviders = ((globalThis as typeof globalThis & {
  __webpilotMemoryDiagnosticProviders?: Map<string, () => unknown>;
}).__webpilotMemoryDiagnosticProviders ??= new Map());
memoryDiagnosticProviders.set('browserChat', browserChatMemoryDiagnostics);

scheduleBrowserChatArtifactMaintenance(() => (
  readBrowserChatSessionSummaries<BrowserChatSessionSnapshot>().map((session) => session.id)
));
scheduleSqliteMaintenance();
const runningHydrationGraceMs = 2 * 60 * 1000;

function browserChatTurnHardTimeoutMs() {
  const configured = Number(process.env.AI_BROWSER_CHAT_TURN_HARD_TIMEOUT_MS || 20 * 60 * 1000);
  return Number.isFinite(configured)
    ? Math.min(24 * 60 * 60 * 1000, Math.max(60_000, Math.floor(configured)))
    : 20 * 60 * 1000;
}

function browserChatTurnTimeoutOptions() {
  const timeoutMs = browserChatTurnHardTimeoutMs();
  return {
    timeoutMs,
    timeoutMessage: `Browser chat turn exceeded the ${Math.round(timeoutMs / 60_000)} minute hard limit.`,
  };
}

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

function cancelBrowserChatSessionEviction(sessionId: string) {
  const timer = sessionEvictionTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  sessionEvictionTimers.delete(sessionId);
}

function browserChatSessionIsSelected(session: Pick<BrowserChatSessionRecord, 'id' | 'userId'>) {
  return selectedSessionIds.get(browserChatUserRuntimeKey(session.userId)) === session.id;
}

function browserChatSessionHasActiveRuntimeWork(session: BrowserChatSessionRecord) {
  if (session.busy || session.status === 'running' || session.pendingToolConfirmation || session.queuedTurns.length) return true;
  if (activeTurns.has(session.id) || browserStartPromises.has(session.id)) return true;
  if ((browserPreviewCounts.get(session.id) || 0) > 0) return true;
  return [...blockedSubagents.values()].some((binding) => binding.sessionId === session.id);
}

function browserChatSessionHasRuntimeWork(session: BrowserChatSessionRecord) {
  return Boolean(session.browser) || browserChatSessionHasActiveRuntimeWork(session);
}

function evictBrowserChatSessionRuntime(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session || browserChatSessionHasRuntimeWork(session) || pendingPersistTimers.has(sessionId) || pendingSqliteWrites.has(sessionId)) return false;
  browserChatRuntimeState.streamPublisher?.cancel(sessionId);
  sessions.delete(sessionId);
  persistenceCursors.delete(sessionId);
  dirtyRecords.delete(sessionId);
  subagentResults.delete(sessionId);
  browserPreviewCounts.delete(sessionId);
  interruptedAssistantMessageIds.delete(session.activeAssistantMessageId || '');
  return true;
}

function compactIdleBrowserChatSessionRuntime(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session || browserChatSessionHasActiveRuntimeWork(session)) return false;
  if (pendingPersistTimers.has(sessionId) || pendingSqliteWrites.has(sessionId)) return false;
  session.runtimeHasPersistedMessages = session.runtimeHasPersistedMessages || session.messages.length > 0;
  session.messages = [];
  session.steps = [];
  session.logs = [];
  session.outputCycles = [];
  session.subagents = [];
  session.consoleErrors = [];
  session.networkErrors = [];
  session.modelContext = normalizeBrowserChatModelContext(undefined);
  session.usedMemoryIdsByTurn?.clear();
  session.usedMemoryIdsByTurn = undefined;
  session.runtimeCompacted = true;
  persistenceCursors.delete(sessionId);
  dirtyRecords.delete(sessionId);
  subagentResults.delete(sessionId);
  return true;
}

async function releaseInactiveBrowserChatSessionRuntime(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session || browserChatSessionIsSelected(session) || browserChatSessionHasActiveRuntimeWork(session)) return false;
  cancelBrowserChatSessionEviction(sessionId);
  clearPendingPersist(sessionId);
  const browser = restoreBrowserSessionPrototype(session.browser);
  if (browser) {
    try {
      session.tabs = browser.getTabsSnapshot();
      session.targetUrl = exportableTargetUrl(browser.currentUrl()) || session.targetUrl;
    } catch {
      // The persisted conversation remains usable even when its browser already exited.
    }
    session.browser = undefined;
    session.started = false;
    await browser.close({ preservePages: true }).catch(() => undefined);
  }
  const persisted = persistSession(sessionId, { mergePersisted: false });
  if (!persisted) return false;
  const pendingWrite = pendingSqliteWrites.get(sessionId);
  if (pendingWrite && !(await pendingWrite)) return false;
  if (browserChatSessionIsSelected(session) || browserChatSessionHasActiveRuntimeWork(session)) return false;
  session.logs = [];
  persistenceCursors.delete(sessionId);
  dirtyRecords.delete(sessionId);
  subagentResults.delete(sessionId);
  return evictBrowserChatSessionRuntime(sessionId);
}

function scheduleBrowserChatSessionEviction(sessionId: string, retryDelayMs = 0) {
  cancelBrowserChatSessionEviction(sessionId);
  const session = sessions.get(sessionId);
  if (!session) return;
  if (browserChatSessionHasActiveRuntimeWork(session)) return;
  const timer = setTimeout(() => {
    sessionEvictionTimers.delete(sessionId);
    void (async () => {
      const current = sessions.get(sessionId);
      const selected = Boolean(current && browserChatSessionIsSelected(current));
      const released = selected && Boolean(current?.browser)
        ? compactIdleBrowserChatSessionRuntime(sessionId)
        : selected
          ? evictBrowserChatSessionRuntime(sessionId)
        : await releaseInactiveBrowserChatSessionRuntime(sessionId);
      if (!released && sessions.has(sessionId)) scheduleBrowserChatSessionEviction(sessionId, 1_000);
    })();
  }, retryDelayMs);
  timer.unref?.();
  sessionEvictionTimers.set(sessionId, timer);
}

function browserChatUserHasActiveWork(userKey: string) {
  return [...sessions.values()].some((session) => (
    browserChatUserRuntimeKey(session.userId) === userKey
    && (
      (browserPreviewCounts.get(session.id) || 0) > 0
      || session.busy
      || session.status === 'running'
      || session.turnState === 'awaiting_human'
      || session.queuedTurns.length > 0
    )
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

function browserChatLogLimit() {
  const raw = Number(process.env.BROWSER_CHAT_LOG_LIMIT || 512);
  const normalized = Number.isFinite(raw) ? Math.floor(raw) : 512;
  return Math.min(Math.max(normalized, 64), 10000);
}

function browserChatLogDetailCharacterLimit() {
  const raw = Number(process.env.BROWSER_CHAT_LOG_DETAIL_CHARACTER_LIMIT || 96 * 1024);
  const normalized = Number.isFinite(raw) ? Math.floor(raw) : 96 * 1024;
  return Math.min(Math.max(normalized, 8 * 1024), 1024 * 1024);
}

function browserChatLogCharacterLimit() {
  const raw = Number(process.env.BROWSER_CHAT_LOG_CHARACTER_LIMIT || 2 * 1024 * 1024);
  const normalized = Number.isFinite(raw) ? Math.floor(raw) : 2 * 1024 * 1024;
  return Math.min(Math.max(normalized, 256 * 1024), 128 * 1024 * 1024);
}

function browserChatOutputCycleLimit() {
  const raw = Number(process.env.BROWSER_CHAT_OUTPUT_CYCLE_LIMIT || 256);
  const normalized = Number.isFinite(raw) ? Math.floor(raw) : 256;
  return Math.min(Math.max(normalized, 32), 2_000);
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
  return trimBrowserChatRuntimeLogs(logs, {
    maxCharacters: browserChatLogCharacterLimit(),
    maxCount: browserChatLogLimit(),
    maxDetailCharacters: browserChatLogDetailCharacterLimit(),
  });
}

function trimBrowserChatOutputCycles(cycles: readonly BrowserChatAiOutputCycle[]) {
  return trimBrowserChatRuntimeItems(cycles, browserChatOutputCycleLimit());
}

function compactBrowserChatRuntimeWindow(session: BrowserChatSessionRecord) {
  session.messages = session.messages.slice(-browserChatRuntimeMessageLimit);
  session.steps = session.steps.slice(-browserChatRuntimeStepLimit);
  session.logs = trimBrowserChatLogs(session.logs || []).slice(-browserChatRuntimeLogLimit);
  if (!dirtyRecords.has(session.id)) seedPersistenceCursor(session);
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

function markMessageRemoved(session: BrowserChatSessionRecord, messageId: string) {
  const dirty = dirtyRecordsFor(session.id);
  dirty.messages.delete(messageId);
  dirty.removedMessageIds.add(messageId);
}

function markStepDirty(session: BrowserChatSessionRecord, step: StepExecutionResult) {
  const dirty = dirtyRecordsFor(session.id);
  dirty.removedStepIndexes.delete(step.index);
  dirty.steps.set(step.index, step);
}

function replaceSessionSteps(session: BrowserChatSessionRecord, nextSteps: StepExecutionResult[]) {
  const boundedSteps = compactBrowserChatStepsForRuntime(nextSteps);
  const previousByIndex = new Map(session.steps.map((step) => [step.index, step]));
  // Tool execution publishes a start edge and a completion edge. Fold those
  // edges together so a late status update can never discard a result that
  // the detail dialog needs to inspect.
  const mergedSteps = boundedSteps.map((step) => {
    const previous = previousByIndex.get(step.index);
    return previous ? mergePersistedStep(previous, step) : step;
  });
  const nextIndexes = new Set(mergedSteps.map((step) => step.index));
  session.steps = mergedSteps;
  for (const step of mergedSteps) {
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
  session.logs = trimmed;
  const dirty = dirtyRecordsFor(session.id);
  for (const log of trimmed) {
    if (previousById.get(log.id) !== log) {
      dirty.removedLogIds.delete(log.id);
      dirty.logs.set(log.id, log);
    }
  }
  // Trimming is only an in-memory ring-buffer operation. Older logs remain in
  // SQLite and are read through the paginated history endpoint when requested.
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
  retrievalQueries?: string[];
}) {
  const currentUrl = input.currentUrl || browserChatMemoryUrl(input.browser, input.session);
  const currentDomain = normalizePersonalMemoryDomain(currentUrl || input.session.targetUrl);
  if (!personalMemoryEnabled()) return { context: '', itemIds: [] as string[], domain: currentDomain };
  const results = searchPersonalMemory({
    userId: input.session.userId,
    query: input.retrievalQueries?.length
      ? input.retrievalQueries
      : [input.text, input.modelText, input.session.title].filter(Boolean).join('\n'),
    domain: currentUrl || input.session.targetUrl,
  }).filter((result) => (
    (!input.domainOnly || result.item.scope === 'domain')
    && !input.excludedIds?.has(result.item.id)
  ));
  if (!results.length) return { context: '', itemIds: [] as string[], domain: currentDomain };
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
  const value = Number(process.env.AI_PERSONAL_MEMORY_EXTRACTION_QUEUE_LIMIT || 24);
  return Number.isFinite(value) ? Math.max(8, Math.min(200, Math.floor(value))) : 24;
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
  const sessionId = input.session.id;
  const sessionUserId = input.session.userId;
  const targetUrl = input.session.targetUrl;
  const userMessageId = input.userMessageId;
  const assistantMessageId = input.assistantMessageId;
  const currentUrl = browserChatMemoryUrl(input.browser, input.session);
  const conversation = input.session.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-24)
    .map((message) => ({
      role: message.role,
      content: compactText(message.content, 4_000),
    }));
  const userMessage = compactText(input.text, 8_000);
  const assistantReply = compactText(input.result.reply, 16_000);
  const extractionSteps = input.result.newSteps.slice(-32).map(compactStepForRealtime);
  const startedAt = Date.now();
  const queueResult = schedulePersonalMemoryExtraction({
    key: `${sessionId}:${userMessageId}:${assistantMessageId}`,
    userId: normalizeUserId(sessionUserId),
    run: async () => {
      try {
        const memoryResult = await extractPersonalMemoryFromTurn({
          userId: sessionUserId,
          currentUrl,
          targetUrl,
          userMessage,
          assistantReply,
          conversation,
          steps: extractionSteps,
          sourceSessionId: sessionId,
          sourceMessageIds: [userMessageId, assistantMessageId],
        });
        const current = sessions.get(sessionId);
        if (!current) return;
        const details = {
          currentDomain: normalizePersonalMemoryDomain(currentUrl || targetUrl),
          ...memoryResult.diagnostics,
        };
        if (memoryResult.skipped) {
          appendLog(current, 'memory:extract:skipped', `个性化短记忆提炼已跳过：${memoryResult.reason || 'unknown reason'}。`, {
            elapsedMs: elapsedMs(startedAt),
            messageId: null,
            details,
          });
          return;
        }
        if (!memoryResult.items.length) {
          appendLog(
            current,
            'memory:extract:empty',
            `模型返回 ${memoryResult.diagnostics.candidateCount} 条记忆候选，规则保留 ${memoryResult.diagnostics.acceptedCount} 条，本轮未写入记忆。`,
            {
              elapsedMs: elapsedMs(startedAt),
              messageId: null,
              details,
            },
          );
          return;
        }
        appendLog(current, 'memory:extract:done', `模型返回 ${memoryResult.diagnostics.candidateCount} 条记忆候选，过滤 ${memoryResult.diagnostics.rejectedCount} 条，已保存 ${memoryResult.items.length} 条。`, {
          elapsedMs: elapsedMs(startedAt),
          messageId: null,
          details: {
            ...details,
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
        const current = sessions.get(sessionId);
        if (!current) return;
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
  } else if (queueResult === 'duplicate') {
    appendLog(input.session, 'memory:extract:duplicate', '本轮个性化短记忆提取任务已经存在，已跳过重复任务。', {
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
  if (!enabledModelProviders(config).length) {
    throw new Error('尚未启用模型服务商，请先在模型配置中开启至少一个服务商。');
  }
  const selection = resolveRuntimeModelSelection(config, {
    fallbackProvider: config?.provider,
    model: modelInput,
    provider: providerInput,
  });
  return {
    ...selection,
    supportsImageInput: modelCapabilities(
      config?.providers?.[selection.provider],
      selection.provider,
      selection.model,
    ).imageInput,
  };
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
    subagentId: typeof record.subagentId === 'string' && record.subagentId.trim()
      ? record.subagentId.trim()
      : undefined,
    stepIndex: typeof record.stepIndex === 'number' && Number.isFinite(record.stepIndex) ? Math.floor(record.stepIndex) : undefined,
    toolName,
    inputSignature,
    reason: typeof record.reason === 'string' && record.reason.trim() ? compactText(record.reason, 300) : undefined,
    prompt: compactText(prompt, 500),
    screenshotUrl: typeof record.screenshotUrl === 'string' && record.screenshotUrl.trim()
      ? record.screenshotUrl.trim()
      : undefined,
    requestedAt: typeof record.requestedAt === 'string' ? record.requestedAt : now(),
  };
}

function now() {
  return new Date().toISOString();
}

function browserChatTurnUsedMemoryIds(session: BrowserChatSessionRecord, assistantMessageId: string) {
  const byTurn = session.usedMemoryIdsByTurn || new Map<string, Set<string>>();
  session.usedMemoryIdsByTurn = byTurn;
  const existing = byTurn.get(assistantMessageId);
  if (existing) return existing;
  while (byTurn.size >= 8) {
    const oldestTurnId = byTurn.keys().next().value;
    if (!oldestTurnId) break;
    byTurn.delete(oldestTurnId);
  }
  const usedMemoryIds = new Set<string>();
  byTurn.set(assistantMessageId, usedMemoryIds);
  return usedMemoryIds;
}

function id(prefix: string) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function elapsedMs(startedAt: number) {
  return Date.now() - startedAt;
}

function elapsedFromDetails(details: unknown) {
  const unwrapped = unwrapLogDetails(details).value;
  if (!unwrapped || typeof unwrapped !== 'object' || Array.isArray(unwrapped)) return undefined;
  const record = unwrapped as Record<string, unknown>;
  const direct = record.elapsedMs;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  const aiOutput = record.aiOutput && typeof record.aiOutput === 'object' && !Array.isArray(record.aiOutput)
    ? record.aiOutput as Record<string, unknown>
    : undefined;
  const timings = aiOutput?.timings && typeof aiOutput.timings === 'object' && !Array.isArray(aiOutput.timings)
    ? aiOutput.timings as Record<string, unknown>
    : undefined;
  const total = timings?.totalElapsedMs ?? aiOutput?.elapsedMs;
  return typeof total === 'number' && Number.isFinite(total) ? total : undefined;
}

function trimLogText(value: string, max = 3000) {
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function unwrapLogDetails(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { value, full: false };
  const record = value as Record<string, unknown>;
  if (record.__browserChatFullLogDetails !== true) return { value, full: false };
  const payload = record.value;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return {
      value: {
        ...payload as Record<string, unknown>,
        ...(record.execution ? { execution: record.execution } : {}),
      },
      full: true,
    };
  }
  return { value: payload, full: true };
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
  if (typeof value === 'string') {
    const text = value.trim();
    return full
      ? compactBrowserChatLogDetails(text, browserChatLogDetailCharacterLimit())
      : trimLogText(text, 20_000);
  }
  try {
    const serialized = (full ? stringifyJsonSafe(value, 2) : stringifyCompactLogDetails(value)) || String(value);
    const text = serialized.trim();
    return full
      ? compactBrowserChatLogDetails(text, browserChatLogDetailCharacterLimit())
      : trimLogText(text, 20_000);
  } catch {
    const fallback = String(value);
    const text = fallback.trim();
    return full
      ? compactBrowserChatLogDetails(text, browserChatLogDetailCharacterLimit())
      : trimLogText(text, 20_000);
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
  const name = segments.at(-1) || 'artifact';
  const type = artifactContentType(name);
  const managedArtifact = segments.length >= 3 && ['downloads', 'generated', 'screenshots'].includes(segments[1]);
  const rootScreenshot = segments.length === 2 && type.startsWith('image/');
  if (segments[0] !== session.id || (!managedArtifact && !rootScreenshot)) return undefined;
  return {
    id: `artifact:${segments.join('/')}`,
    kind: 'file',
    name,
    path: segments.join('/'),
    size: undefined,
    type,
    url: artifactApiUrlFromRelative(segments.join('/')),
  };
}

async function readFileForSession(
  session: BrowserChatSessionRecord,
  input: BrowserChatReadFileInput,
  historicalMessages: BrowserChatMessage[] = [],
) {
  const attachment = input.attachmentId
    ? mergePersistedMessages(historicalMessages, session.messages)
      .reverse()
      .flatMap((message) => message.attachments || [])
      .find((item) => item.id === input.attachmentId)
    : input.artifactId
      ? artifactAttachmentForSession(session, input.artifactId)
      : undefined;
  if (!attachment) {
    return {
      ok: false,
      actual: '未找到可读取文件。请使用对话附件的 attachmentId，或 file action=download/action=generate 返回的 Artifact ID。',
    };
  }
  const result = await readBrowserChatAttachment({
    attachment,
    absolutePath: uploadedBrowserChatAttachmentPath(attachment, session.userId),
    includeVisuals: input.includeVisuals,
    limit: input.limit,
    offset: input.offset,
    pages: input.pages,
    previewRoot: artifactPath(session.id, 'attachment-previews'),
  });
  return isBrowserChatImageAttachment(attachment) && result.ok
    ? { ...result, referenceImagePath: uploadedBrowserChatAttachmentPath(attachment, session.userId) }
    : result;
}

type BrowserChatCredentialDescriptor = {
  accountId: string;
  defaultDomain: string;
  label: string;
  loginUrl: string;
  username: string;
  usernameRef: string;
  passwordRef: string;
};

function browserChatCredentialContext(
  session: BrowserChatSessionRecord,
  references: Map<string, { passwordRef: string; usernameRef: string }>,
) {
  const credentials: BrowserChatCredentialDescriptor[] = [];
  const bindings: BrowserCodeCredentialBinding[] = [];
  const accounts = listLoginAccounts({ userId: session.userId })
    .filter((account) => account.status === 'active' && account.hasPassword);
  for (const account of accounts) {
    // Provisioning a binding only makes the account available to browserCode; it
    // is not evidence that the page actually consumed the credential.
    const credential = resolveLoginAccountCredentialById(account.id, session.userId, { trackUsage: false });
    if (!credential) continue;
    let refs = references.get(account.id);
    if (!refs) {
      const token = randomUUID();
      refs = {
        usernameRef: `credential_${token}_username`,
        passwordRef: `credential_${token}_password`,
      };
      references.set(account.id, refs);
    }
    const { usernameRef, passwordRef } = refs;
    credentials.push({
      accountId: account.id,
      defaultDomain: account.domain,
      label: account.label,
      loginUrl: account.loginUrl,
      username: account.username,
      usernameRef,
      passwordRef,
    });
    bindings.push(
      { ref: usernameRef, value: account.username, allowedOrigins: [] },
      { ref: passwordRef, value: credential.password, allowedOrigins: [] },
    );
  }
  return { credentials, bindings };
}

function browserChatCredentialPrompt(credentials: BrowserChatCredentialDescriptor[]) {
  if (!credentials.length) return '';
  return [
    '[后台已匹配的安全账号引用]',
    ...credentials.map((item) => [
      `<account id="${item.accountId}">`,
      `  Name: ${item.label}`,
      `  Default site: ${item.defaultDomain}`,
      `  Login URL: ${item.loginUrl}`,
      '  Scope: 任意 HTTP(S) 页面',
      `  Username: ${item.username}`,
      `  用户名：await credentialVault.fill(page.getByLabel('用户名'), "${item.usernameRef}")`,
      `  密码：await credentialVault.fill(page.getByLabel('密码'), "${item.passwordRef}")`,
      '</account>',
    ].join('\n')),
    'credentialVault.fill 只会把对应值写入当前浏览器会话中的真实 Playwright Locator；保存的默认站点仅用于识别账号和提供登录地址，不限制账号在哪个 HTTP(S) 站点使用。它不会返回账号或密码明文。不得读取已填充输入框的 inputValue/value，不得在 nodeRepl.write、console、工具参数或最终回复中输出凭据或引用。验证码、OTP、扫码或二次认证必须调用 waitForHumanVerification。',
  ].join('\n');
}

async function createBrowserChatRuntimeOperationalContext(input: {
  session: BrowserChatSessionRecord;
  browser: BrowserSession;
  text: string;
  modelText: string;
  explicitlySelectedSkills?: SkillRecord[];
  usedMemoryIds?: Set<string>;
  historicalMessages?: BrowserChatMessage[];
  historicalSteps?: StepExecutionResult[];
}) {
  const loadedSkills = new Map<string, SkillRecord>();
  const credentialReferences = new Map<string, { passwordRef: string; usernameRef: string }>();
  const usedMemoryIds = input.usedMemoryIds || new Set<string>();
  const explicitlySelectedSkillIds = new Set((input.explicitlySelectedSkills || []).map((skill) => skill.id));
  const query = [input.text, input.modelText, input.session.title].filter(Boolean).join('\n');
  const retrievalQueries = await expandMultilingualRetrievalQuery(query);
  let availableSkillIds = new Set<string>();
  const getContext = async () => {
    const currentUrl = browserChatMemoryUrl(input.browser, input.session);
    const allSkills = store.listSkills(undefined, input.session.userId).filter((skill) => skill.status === 'ready');
    const activeLoadedSkills = [...loadedSkills.values()];
    const activeLoadedSkillIds = new Set(activeLoadedSkills.map((skill) => skill.id));
    const explicitlySelectedSkills = allSkills.filter((skill) => explicitlySelectedSkillIds.has(skill.id));
    const skills = runtimeSkills(
      allSkills,
      explicitlySelectedSkills,
      activeLoadedSkillIds,
      retrievalQueries,
    );
    availableSkillIds = new Set(skills.map((skill) => skill.id));
    const memory = browserChatPersonalMemoryContext({
      session: input.session,
      browser: input.browser,
      text: input.text,
      modelText: input.modelText,
      currentUrl,
      logPhase: 'memory:prompt:runtime-refresh',
      retrievalQueries,
    });
    const unusedMemoryIds = memory.itemIds.filter((memoryId) => !usedMemoryIds.has(memoryId));
    if (unusedMemoryIds.length) {
      markPersonalMemoryItemsUsed(unusedMemoryIds);
      unusedMemoryIds.forEach((memoryId) => usedMemoryIds.add(memoryId));
    }
    const credentials = browserChatCredentialContext(
      input.session,
      credentialReferences,
    );
    const officeDraftCatalog = await officeDraftCatalogForPrompt(input.session.id);
    return {
      operationalContext: [
        formatLoadedSkillsForPrompt(activeLoadedSkills),
        formatSkillSummariesForPrompt(skills),
        memory.context,
        conversationFileRegistry(input.session, input.historicalMessages, input.historicalSteps),
        officeDraftCatalog,
        browserChatCredentialPrompt(credentials.credentials),
      ].filter(Boolean).join('\n\n'),
      credentialBindings: credentials.bindings,
    };
  };
  return Object.assign(getContext, {
    readSkill: async (skillId: string): Promise<BrowserActionResult> => {
      const normalizedSkillId = skillId.trim();
      const skill = store.getSkill(normalizedSkillId, input.session.userId);
      if (!availableSkillIds.has(normalizedSkillId) || !skill || skill.status !== 'ready') {
        return { ok: false, actual: 'Skill is not available in the current runtime candidate list.' };
      }
      if (loadedSkills.has(skill.id)) {
        return { ok: false, actual: 'Skill is already loaded in the current runtime context.' };
      }
      loadedSkills.set(skill.id, skill);
      availableSkillIds.delete(skill.id);
      return {
        ok: true,
        actual: `Skill loaded into the current runtime context: ${skill.id}.`,
      };
    },
  });
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

async function readFileVisualsForSession(
  session: BrowserChatSessionRecord,
  input: BrowserChatFileVisualInput,
) {
  const attachment = artifactAttachmentForSession(session, input.artifactId);
  if (!attachment) {
    return {
      ok: false,
      actual: 'fileVisual could not find this artifact in the current conversation. Use the exact Artifact ID returned by a successful file generation or download.',
    };
  }
  return readBrowserChatFileVisuals({
    attachment,
    absolutePath: uploadedBrowserChatAttachmentPath(attachment, session.userId),
    request: input,
    previewRoot: artifactPath(session.id, 'attachment-previews'),
  });
}

/** Persistent file inventory survives model-context compression. */
function conversationFileRegistry(
  session: BrowserChatSessionRecord,
  historicalMessages: BrowserChatMessage[] = [],
  historicalSteps: StepExecutionResult[] = [],
) {
  const messages = mergePersistedMessages(historicalMessages, session.messages);
  const steps = mergePersistedSteps(historicalSteps, session.steps);
  const uploads = new Map<string, BrowserChatAttachment>();
  for (const message of [...messages].reverse()) {
    for (const attachment of message.attachments || []) {
      const absolutePath = uploadedBrowserChatAttachmentPath(attachment, session.userId);
      if (attachment.kind !== 'tab' && !uploads.has(attachment.id) && absolutePath && existsSync(absolutePath)) {
        uploads.set(attachment.id, attachment);
      }
    }
  }
  const artifacts = mergeBrowserChatArtifactSummaries(
    ...messages.map((message) => message.artifacts),
    browserChatArtifactsFromSteps(steps),
  ).reverse();
  const lines = [
    ...[...uploads.values()].map((attachment) => (
      `- upload | name=${JSON.stringify(attachment.name)} | attachmentId=${attachment.id} | read=file(action=read, attachmentId=${JSON.stringify(attachment.id)})`
    )),
    ...artifacts.flatMap((artifact) => {
      const relative = artifact.path
        ? path.relative(artifactsRoot(), artifact.path).replace(/\\/g, '/')
        : '';
      const artifactId = relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : '';
      const attachment = artifactId ? artifactAttachmentForSession(session, artifactId) : undefined;
      const absolutePath = attachment ? uploadedBrowserChatAttachmentPath(attachment, session.userId) : undefined;
      if (!artifactId || !absolutePath || !existsSync(absolutePath)) return [];
      return [`- artifact | name=${JSON.stringify(artifact.fileName)} | artifactId=${artifactId} | documentId=${artifact.documentId || '-'} | read=file(action=read, artifactId=${JSON.stringify(artifactId)})`];
    }),
  ];
  if (!lines.length) return '';
  return [
    '[Conversation file registry — persistent runtime metadata]',
    'Every listed file is shared by this conversation. Use its listed ID with file action=read; never guess a host path. Before Office generation, file action=plan returns the exact mounted asset names for job.asset_path(name).',
    ...lines.slice(0, 200),
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
  return clientStep;
}

const browserChatDetailedStepRetention = 8;

function compactHistoricalAiRequest(
  aiRequest: NonNullable<StepExecutionResult['aiRequest']>,
): NonNullable<StepExecutionResult['aiRequest']> {
  const options = aiRequest.options || {};
  const retainedOptionKeys = [
    'agentStepIndex',
    'imageCount',
    'modelContextSegmentation',
    'modelContextStats',
  ];
  if (
    aiRequest.systemPrompt === undefined
    && aiRequest.messages.length === 0
    && Object.keys(options).every((key) => retainedOptionKeys.includes(key))
  ) return aiRequest;
  const retainedOptions = Object.fromEntries(
    retainedOptionKeys.flatMap((key) => key in options ? [[key, options[key]]] : []),
  );
  return {
    ...aiRequest,
    systemPrompt: undefined,
    messages: [],
    options: retainedOptions,
  };
}

function compactBrowserChatStepsForRuntime(steps: readonly StepExecutionResult[]) {
  const detailedIndexes = new Set(
    steps.slice(-browserChatDetailedStepRetention).map((step) => step.index),
  );
  return steps.map((step) => {
    if (!step.aiRequest || detailedIndexes.has(step.index)) return step;
    const aiRequest = compactHistoricalAiRequest(step.aiRequest);
    return aiRequest === step.aiRequest ? step : { ...step, aiRequest };
  });
}

function compactBrowserChatSubagentSteps(steps: readonly StepExecutionResult[] = []) {
  return steps.map(compactStepForClient);
}

function compactBrowserChatSubagentRecord(record: BrowserChatSubagentRecord): BrowserChatSubagentRecord {
  return {
    ...record,
    steps: compactBrowserChatSubagentSteps(record.steps),
    outputCycles: trimBrowserChatOutputCycles(record.outputCycles || []),
  };
}

function browserCodeAttachmentBindingsForSession(
  session: BrowserChatSessionRecord,
  historicalMessages: BrowserChatMessage[] = [],
): BrowserCodeAttachmentBinding[] {
  const bindings = new Map<string, BrowserCodeAttachmentBinding>();
  for (const message of mergePersistedMessages(historicalMessages, session.messages)) {
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
      // `file action=unoApi` is a complete inspection result. Its full
      // runtime reflection must reach the client-side result dialog rather
      // than being reduced to a status-only tool card.
      if (realtimeTool.name !== 'file') delete realtimeTool.rawResult;
      return realtimeTool;
    }),
  };
}

function summaryFromSnapshot(session: BrowserChatSessionSnapshot): BrowserChatSessionSnapshot {
  const { modelContext: _modelContext, ...summarySession } = session as BrowserChatSessionSnapshot & {
    modelContext?: BrowserChatModelContext;
  };
  void _modelContext;
  return {
    ...summarySession,
    userId: normalizeUserId(session.userId),
    hasMessages: session.hasMessages ?? session.messages.length > 0,
    messages: [],
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

function browserChatContextUsage(session: BrowserChatSessionRecord): BrowserChatContextUsage {
  const fallbackMax = runtimeContextWindowTokens({
    provider: session.modelProvider,
    model: session.model,
  });
  if (session.contextUsage && session.contextUsage.currentTokens > 0) {
    return { ...session.contextUsage, maxTokens: fallbackMax };
  }
  for (let index = session.steps.length - 1; index >= 0; index -= 1) {
    const rawStats = session.steps[index]?.aiRequest?.options?.modelContextStats;
    if (!rawStats || typeof rawStats !== 'object' || Array.isArray(rawStats)) continue;
    const stats = rawStats as Record<string, unknown>;
    const currentTokens = Number(stats.estimatedTotalTokens);
    const maxTokens = Number(stats.windowTokens);
    if (!Number.isFinite(currentTokens) || currentTokens < 0) continue;
    const textTokens = Number(stats.estimatedTextTokens);
    const imageTokens = Number(stats.estimatedImageTokens);
    const toolTokens = Number(stats.estimatedToolSchemaTokens);
    return {
      currentTokens: Math.round(currentTokens),
      imageTokens: Number.isFinite(imageTokens) && imageTokens > 0 ? Math.round(imageTokens) : 0,
      maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.round(maxTokens) : fallbackMax,
      textTokens: Number.isFinite(textTokens) && textTokens > 0 ? Math.round(textTokens) : 0,
      toolTokens: Number.isFinite(toolTokens) && toolTokens > 0 ? Math.round(toolTokens) : 0,
    };
  }
  const activeMessages = session.modelContext.activeMessages.length
    ? session.modelContext.activeMessages
    : session.messages.map((message) => ({
        role: message.role,
        content: message.content,
        attachments: (message.attachments || []).map((attachment) => ({
          name: attachment.name,
          type: attachment.kind === 'image' || attachment.type.startsWith('image/') ? 'image' : attachment.type,
        })),
      }));
  const estimated = estimateRuntimeMessageContext(activeMessages);
  return {
    currentTokens: estimated.totalTokens,
    imageTokens: estimated.imageTokens,
    maxTokens: fallbackMax,
    textTokens: estimated.textTokens,
    toolTokens: 0,
  };
}

function browserChatContextUsageFromDebugDetails(
  details: unknown,
  model: { provider?: string; model?: string },
): BrowserChatContextUsage | undefined {
  const unwrapped = unwrapLogDetails(details).value;
  if (!unwrapped || typeof unwrapped !== 'object' || Array.isArray(unwrapped)) return undefined;
  return browserChatContextUsageFromDebugRecord(
    unwrapped as Record<string, unknown>,
    runtimeContextWindowTokens(model),
  );
}

function refreshBrowserChatTerminalContextUsage(session: BrowserChatSessionRecord) {
  const estimated = estimateRuntimeMessageContext(session.modelContext.activeMessages);
  const toolTokens = Math.max(0, browserChatContextUsage(session).toolTokens);
  session.contextUsage = {
    currentTokens: estimated.totalTokens + toolTokens,
    imageTokens: estimated.imageTokens,
    maxTokens: runtimeContextWindowTokens({
      provider: session.modelProvider,
      model: session.model,
    }),
    textTokens: estimated.textTokens,
    toolTokens,
  };
}

function sessionSnapshotHeader(
  session: BrowserChatSessionRecord,
): Omit<BrowserChatSessionSnapshot, 'logs' | 'messages' | 'steps'> {
  finalizeIdleRunningAssistantMessages(session);
  const firstUserMessage = session.messages.find((message) => message.role === 'user');
  const titleFileName = session.titleFileName
    || browserChatSessionTitleParts(session.title, firstUserMessage?.attachments).fileName;
  return {
    id: session.id,
    title: session.title,
    ...(titleFileName ? { titleFileName } : {}),
    userId: session.userId,
    browserGroupId: session.browserGroupId,
    targetUrl: session.targetUrl,
    noVncUrl: browserChatNoVncUrl(session),
    safetyMode: normalizeSafetyMode(session.safetyMode),
    modelProvider: normalizeModelProvider(session.modelProvider),
    model: browserChatModelSettings(session.modelProvider, session.model).model,
    status: session.status,
    turnState: normalizeBrowserChatTurnState(session),
    busy: session.busy,
    hasMessages: session.runtimeCompacted
      ? Boolean(session.runtimeHasPersistedMessages)
      : session.messages.length > 0,
    contextUsage: browserChatContextUsage(session),
    tabs: browserChatTabs(session),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    closedAt: session.closedAt,
    error: session.error,
    consoleErrors: [...session.consoleErrors],
    networkErrors: [...session.networkErrors],
    outputCycles: [...session.outputCycles],
    subagents: [...session.subagents],
    queuedTurns: [...session.queuedTurns],
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
    logs: compactBrowserChatLogsForClient(session.logs || []),
  };
}

type BrowserChatClientSessionSnapshot = BrowserChatSessionSnapshot & {
  history: BrowserChatHistoryState;
};

function clientSnapshot(session: BrowserChatSessionRecord): BrowserChatClientSessionSnapshot {
  const header = sessionSnapshotHeader(session);
  const activeMessage = activeBrowserChatAssistantMessage(session);
  const activeStepIndexes = new Set(activeMessage?.stepIndexes || []);
  const latestMessages = session.messages.slice(-BROWSER_CHAT_MESSAGE_PAGE_SIZE);
  const messages = activeMessage && !latestMessages.some((message) => message.id === activeMessage.id)
    ? [
        activeMessage,
        ...session.messages
          .filter((message) => message.id !== activeMessage.id)
          .slice(-(BROWSER_CHAT_MESSAGE_PAGE_SIZE - 1)),
      ].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    : latestMessages;
  const records = activeMessage
    ? browserChatClientRecordsForMessage(session, activeMessage.id, { includeSubagents: true })
    : { outputCycles: [], subagents: [] };
  return {
    ...header,
    messages,
    steps: activeMessage
      ? session.steps
          .filter((step) => activeStepIndexes.has(step.index) && (!step.messageId || step.messageId === activeMessage.id))
          .map(compactStepForClient)
      : [],
    logs: activeMessage
      ? compactBrowserChatLogsForClient(session.logs.filter((log) => log.messageId === activeMessage.id))
      : [],
    outputCycles: records.outputCycles,
    subagents: records.subagents,
    history: {
      messages: { hasMore: false },
      steps: { hasMore: false },
      logs: { hasMore: false },
    },
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

function assistantMessageMatchesClientTurn(
  session: Pick<BrowserChatSessionSnapshot, 'messages'>,
  assistantMessageId: string | undefined,
  clientMessageId: string,
) {
  if (!assistantMessageId) return false;
  const message = session.messages.find((item) => item.id === assistantMessageId);
  return message?.role === 'assistant' && message.clientMessageId === clientMessageId;
}

function runningAssistantMessageIdsForClientTurn(
  session: Pick<BrowserChatSessionSnapshot, 'messages'>,
  clientMessageId: string,
) {
  return session.messages
    .filter((message) => (
      message.role === 'assistant'
      && message.status === 'running'
      && message.clientMessageId === clientMessageId
    ))
    .map((message) => message.id);
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
  if (session.busy || session.status === 'running' || activeTurns.has(session.id)) return false;
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

function markRecoveredRunningAssistantMessagesDirty(
  session: BrowserChatSessionRecord,
  persisted: Pick<BrowserChatSessionSnapshot, 'messages'>,
) {
  const persistedMessages = new Map(persisted.messages.map((message) => [message.id, message]));
  for (const message of session.messages) {
    const previous = persistedMessages.get(message.id);
    if (previous?.role !== 'assistant' || previous.status !== 'running' || message.status === 'running') continue;
    markMessageDirty(session, message);
  }
}

function markAssistantMessageInterrupted(assistantMessageId?: string) {
  if (!assistantMessageId) return;
  interruptedAssistantMessageIds.add(assistantMessageId);
  if (interruptedAssistantMessageIds.size <= 500) return;
  const oldest = interruptedAssistantMessageIds.values().next().value;
  if (oldest) interruptedAssistantMessageIds.delete(oldest);
}

const browserChatInterruptedReply = '本轮对话已由用户中止。';
const browserChatInterruptionNote = '> 本轮对话已由用户中止。中止前已经生成的内容和工具记录已保留。';

function preserveInterruptedModelContext(
  session: BrowserChatSessionRecord,
  assistantMessageId: string,
  assistantContent: string,
) {
  const assistantIndex = session.messages.findIndex((message) => message.id === assistantMessageId);
  if (assistantIndex < 0) return;
  const userMessage = [...session.messages.slice(0, assistantIndex)].reverse()
    .find((message) => message.role === 'user');
  if (!userMessage) return;
  session.modelContext = normalizeBrowserChatModelContext({
    ...session.modelContext,
    version: 1,
    transcript: compactBrowserChatModelTranscript(
      appendInterruptedBrowserChatTurn(session.modelContext.transcript, userMessage.content, assistantContent),
    ),
    activeMessages: appendInterruptedBrowserChatTurn(session.modelContext.activeMessages, userMessage.content, assistantContent),
  });
}

function preserveInterruptedTurn(session: BrowserChatSessionRecord, assistantMessageId: string, timestamp: string) {
  const currentMessage = session.messages.find((message) => message.id === assistantMessageId);
  const currentContent = currentMessage?.content.trim() || '';
  preserveInterruptedModelContext(session, assistantMessageId, currentContent);
  updateAssistantMessage(session, assistantMessageId, (message) => ({
    ...message,
    content: currentContent
      ? currentContent.includes(browserChatInterruptionNote)
        ? currentContent
        : `${currentContent}\n\n${browserChatInterruptionNote}`
      : browserChatInterruptedReply,
    status: 'interrupted',
    activity: undefined,
    updatedAt: timestamp,
  }));
  replaceSessionSteps(session, session.steps.map((step) => {
    if (step.status !== 'queued' && step.status !== 'running') return step;
    if (step.messageId !== assistantMessageId) return step;
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
  session: BrowserChatPersistedSessionSnapshot,
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
  }), steps);
  return {
    ...session,
    userId: normalizeUserId(session.userId),
    tabs: session.tabs || [],
    targetUrl: exportableTargetUrl(session.targetUrl),
    safetyMode: normalizeSafetyMode(session.safetyMode),
    modelProvider: modelSettings.provider,
    model: modelSettings.model,
    messages,
    steps: compactBrowserChatStepsForRuntime(steps),
    outputCycles: trimBrowserChatOutputCycles(session.outputCycles || []),
    subagents: (session.subagents || []).map(compactBrowserChatSubagentRecord),
    queuedTurns: session.queuedTurns || [],
    modelContext: normalizeBrowserChatModelContext(session.modelContext),
    pendingToolConfirmation: preserveRecentRunningState ? normalizeToolConfirmation(session.pendingToolConfirmation) : undefined,
    status,
    turnState: preserveRecentRunningState
      ? normalizeBrowserChatTurnState(session)
      : normalizeBrowserChatTurnState({ ...session, busy: false, status }),
    busy: preserveRecentRunningState ? session.busy : false,
    logs: trimBrowserChatLogs(session.logs || []),
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
  const logRecord: BrowserChatLogRecord = {
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
  };
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
    .filter(isBrowserChatSessionSnapshot)
    .map(summaryFromSnapshot);
}

function isBrowserChatSessionSnapshot(value: unknown): value is BrowserChatSessionSnapshot {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { id?: unknown }).id === 'string';
}

function readSessionSnapshot(sessionId: string) {
  const item = readBrowserChatSessionRecord<BrowserChatPersistedSessionSnapshot>(sessionId);
  if (!isBrowserChatSessionSnapshot(item)) return undefined;
  return { ...item, logs: trimBrowserChatLogs(item.logs || []) };
}

const browserChatRuntimeMessageLimit = 96;
const browserChatRuntimeStepLimit = 128;
const browserChatRuntimeLogLimit = 256;

function readRuntimeSessionSnapshot(sessionId: string) {
  const item = readBrowserChatSessionWindow<
    BrowserChatPersistedSessionSnapshot,
    BrowserChatMessage,
    StepExecutionResult,
    BrowserChatLogRecord
  >(sessionId, {
    logLimit: browserChatRuntimeLogLimit,
    messageLimit: browserChatRuntimeMessageLimit,
    stepLimit: browserChatRuntimeStepLimit,
  });
  if (!isBrowserChatSessionSnapshot(item)) return undefined;
  const { history: _history, ...snapshot } = item;
  void _history;
  return { ...snapshot, logs: trimBrowserChatLogs(snapshot.logs || []) };
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

function writeSessionSnapshot(item: BrowserChatPersistedSessionSnapshot): BrowserChatSessionRealtimePatch {
  const persistedLogs = item.logs.length > browserChatLogStorageLimit() ? trimBrowserChatLogs(item.logs) : item.logs;
  const persistedItem = persistedLogs === item.logs ? item : { ...item, logs: persistedLogs };
  const persistenceChanges = persistenceDelta(persistedItem);
  const realtimeChanges = {
    ...persistenceChanges,
    logs: compactBrowserChatLogsForClient(persistenceChanges.logs),
  };
  const sessionRecord: Partial<BrowserChatPersistedSessionSnapshot> = { ...persistedItem };
  delete sessionRecord.messages;
  delete sessionRecord.steps;
  delete sessionRecord.logs;
  const persistedSession = sessionRecord as Omit<BrowserChatPersistedSessionSnapshot, 'logs' | 'messages' | 'steps'>;
  const { modelContext: _modelContext, ...session } = persistedSession;
  void _modelContext;
  const activeMessage = activeBrowserChatAssistantMessage(persistedItem);
  const realtimeRecords = activeMessage
    ? browserChatClientRecordsForMessage(persistedItem, activeMessage.id, { includeSubagents: true })
    : { outputCycles: [], subagents: [] };
  const realtimeSession: BrowserChatSessionRealtimePatch['session'] = {
    ...session,
    outputCycles: realtimeRecords.outputCycles,
    subagents: realtimeRecords.subagents,
    pendingToolConfirmation: session.pendingToolConfirmation ?? null,
  };
  const summary = summaryFromSnapshot(persistedItem);
  const patch: BrowserChatSessionRealtimePatch = {
    session: realtimeSession,
    summary,
    ...(realtimeChanges.messages.length ? { messages: realtimeChanges.messages } : {}),
    ...(realtimeChanges.steps.length ? { steps: realtimeChanges.steps.map(compactStepForRealtime) } : {}),
    ...(realtimeChanges.logs.length ? { logs: realtimeChanges.logs } : {}),
    ...(realtimeChanges.removedMessageIds.length ? { removedMessageIds: realtimeChanges.removedMessageIds } : {}),
    ...(realtimeChanges.removedStepIndexes.length ? { removedStepIndexes: realtimeChanges.removedStepIndexes } : {}),
    ...(realtimeChanges.removedLogIds.length ? { removedLogIds: realtimeChanges.removedLogIds } : {}),
  };
  const realtimeEvent = {
    entityType: 'browserChatSession' as const,
    id: item.id,
    updatedAt: item.updatedAt,
    userId: normalizeApplicationUserId(item.userId),
    patch,
  };
  const sqliteWrite = writeBrowserChatSessionDeltaQueued(
    { ...persistedSession, messages: [], steps: [], logs: [] },
    summary,
    persistenceChanges,
  );
  trackSessionSqliteWrite(item.id, sqliteWrite);
  void publishRealtimeRefreshEvent(realtimeEvent).catch(() => undefined);
  if (dirtyRecords.has(item.id)) {
    advancePersistenceCursor(persistedItem, persistenceChanges);
    dirtyRecords.delete(item.id);
  } else {
    seedPersistenceCursor(persistedItem);
  }
  const runtimeSession = sessions.get(item.id);
  if (runtimeSession && !browserChatSessionIsSelected(runtimeSession)) {
    runtimeSession.logs = [];
    persistenceCursors.get(item.id)?.logs.clear();
  }
  return patch;
}

async function publishBrowserChatTextStreamSnapshot(sessionId: string, assistantMessageId: string) {
  const session = sessions.get(sessionId);
  const message = session?.messages.find((item) => item.id === assistantMessageId);
  if (!session || !message || message.role !== 'assistant') return;
  const header = sessionSnapshotHeader(session);
  const realtimeRecords = browserChatClientRecordsForMessage(session, message.id, { includeSubagents: true });
  const patch: BrowserChatSessionRealtimePatch = {
    session: {
      ...header,
      outputCycles: realtimeRecords.outputCycles,
      subagents: realtimeRecords.subagents,
      pendingToolConfirmation: header.pendingToolConfirmation ?? null,
    },
    messages: [{
      ...message,
      artifacts: message.artifacts ? [...message.artifacts] : undefined,
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
      artifacts: mergeBrowserChatArtifactSummaries(previous.artifacts, message.artifacts),
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
  if (step.status && step.status !== 'running') score += 10;
  return score;
}

function toolCompletenessScore(tool: NonNullable<StepExecutionResult['tools']>[number]) {
  let score = 0;
  if (tool.rawResult !== undefined) score += 8;
  if (tool.result !== undefined) score += 4;
  if (tool.ok !== undefined) score += 2;
  if (tool.error !== undefined) score += 1;
  return score;
}

function toolMergeKey(tool: NonNullable<StepExecutionResult['tools']>[number], index: number) {
  return tool.id ? `id:${tool.id}` : `position:${index}:${tool.name}`;
}

function mergePersistedTools(existing: StepExecutionResult['tools'], incoming: StepExecutionResult['tools']) {
  if (!existing?.length) return incoming;
  if (!incoming?.length) return existing;
  const existingByKey = new Map(existing.map((tool, index) => [toolMergeKey(tool, index), tool]));
  const consumed = new Set<string>();
  const merged = incoming.map((tool, index) => {
    const key = toolMergeKey(tool, index);
    const previous = existingByKey.get(key);
    consumed.add(key);
    if (!previous) return tool;
    const preferred = toolCompletenessScore(tool) >= toolCompletenessScore(previous) ? tool : previous;
    const fallback = preferred === tool ? previous : tool;
    return {
      ...fallback,
      ...preferred,
      input: preferred.input ?? fallback.input,
      reason: preferred.reason ?? fallback.reason,
      result: preferred.result ?? fallback.result,
      rawResult: preferred.rawResult ?? fallback.rawResult,
      ok: preferred.ok ?? fallback.ok,
      error: preferred.error ?? fallback.error,
      contextBefore: preferred.contextBefore ?? fallback.contextBefore,
      contextAfter: preferred.contextAfter ?? fallback.contextAfter,
      screenshots: preferred.screenshots ?? fallback.screenshots,
    };
  });
  existing.forEach((tool, index) => {
    if (!consumed.has(toolMergeKey(tool, index))) merged.push(tool);
  });
  return merged;
}

function mergePersistedStep(existing: StepExecutionResult, incoming: StepExecutionResult) {
  const preferred = existing.status !== 'running' && incoming.status === 'running'
    ? existing
    : incoming.status !== 'running' && existing.status === 'running'
      ? incoming
      : stepCompletenessScore(incoming) >= stepCompletenessScore(existing)
        ? incoming
        : existing;
  const fallback = preferred === incoming ? existing : incoming;
  return {
    ...fallback,
    ...preferred,
    tools: mergePersistedTools(existing.tools, incoming.tools),
    aiRequest: preferred.aiRequest ?? fallback.aiRequest,
    visualContext: preferred.visualContext ?? fallback.visualContext,
  };
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
  return trimBrowserChatLogs(
    [...byKey.values()].sort((a, b) => timestampValue(a.time) - timestampValue(b.time)),
  );
}

function mergePersistedOutputCycles(existing: BrowserChatAiOutputCycle[] = [], incoming: BrowserChatAiOutputCycle[] = []) {
  const byId = new Map<string, BrowserChatAiOutputCycle>();
  for (const cycle of existing) byId.set(cycle.id, cycle);
  for (const cycle of incoming) byId.set(cycle.id, cycle);
  return trimBrowserChatOutputCycles(sortBrowserChatAiOutputCycles([...byId.values()]));
}

function mergePersistedSubagents(existing: BrowserChatSubagentRecord[] = [], incoming: BrowserChatSubagentRecord[] = []) {
  const byId = new Map<string, BrowserChatSubagentRecord>();
  for (const subagent of existing) byId.set(subagent.id, subagent);
  for (const subagent of incoming) {
    const previous = byId.get(subagent.id);
    if (!previous) {
      byId.set(subagent.id, subagent);
      continue;
    }
    const messages = new Map((previous.messages || []).map((message) => [message.id, message]));
    for (const message of subagent.messages || []) messages.set(message.id, message);
    byId.set(subagent.id, {
      ...previous,
      ...subagent,
      steps: mergePersistedSteps(previous.steps, subagent.steps),
      outputCycles: mergePersistedOutputCycles(previous.outputCycles, subagent.outputCycles),
      messages: [...messages.values()],
    });
  }
  return [...byId.values()]
    .map(compactBrowserChatSubagentRecord)
    .sort((left, right) => left.index - right.index);
}

function mergePersistedSessionSnapshot(
  existing: BrowserChatPersistedSessionSnapshot | undefined,
  incoming: BrowserChatPersistedSessionSnapshot,
): BrowserChatPersistedSessionSnapshot {
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
    modelContext: incomingNewer
      ? normalizeBrowserChatModelContext(incoming.modelContext)
      : normalizeBrowserChatModelContext(existing.modelContext),
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
    modelContext: normalizeBrowserChatModelContext(existing.modelContext),
    pendingToolConfirmation: existing.pendingToolConfirmation || fromDisk.pendingToolConfirmation,
  };
}

function applyPersistedSnapshotToRuntime(persistedSnapshot: BrowserChatPersistedSessionSnapshot) {
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

function restoreCompactedBrowserChatSession(session: BrowserChatSessionRecord) {
  if (!session.runtimeCompacted) return session;
  const persisted = readRuntimeSessionSnapshot(session.id);
  if (!persisted) return session;
  const restored = recordFromSnapshot(persisted);
  const browser = session.browser;
  const started = session.started;
  const tabs = session.tabs;
  const targetUrl = session.targetUrl;
  Object.assign(session, restored, {
    browser,
    runtimeCompacted: false,
    runtimeHasPersistedMessages: undefined,
    started,
    tabs: tabs.length ? tabs : restored.tabs,
    targetUrl: targetUrl || restored.targetUrl,
  });
  seedPersistenceCursor(session, persisted);
  markRecoveredRunningAssistantMessagesDirty(session, persisted);
  return session;
}

function hydrateSession(sessionId: string) {
  const existing = sessions.get(sessionId);
  if (existing) {
    restoreCompactedBrowserChatSession(existing);
    scheduleBrowserChatSessionEviction(sessionId);
    startNextQueuedBrowserChatTurn(existing);
    return existing;
  }
  const persisted = readRuntimeSessionSnapshot(sessionId);
  const applied = persisted ? applyPersistedSnapshotToRuntime(persisted) : false;
  const session = sessions.get(sessionId);
  if (session && persisted && applied) {
    seedPersistenceCursor(session, persisted);
    markRecoveredRunningAssistantMessagesDirty(session, persisted);
  }
  else if (persisted && !persistenceCursors.has(sessionId)) seedPersistenceCursor(persisted);
  if (session) {
    scheduleBrowserChatSessionEviction(sessionId);
    startNextQueuedBrowserChatTurn(session);
  }
  return session;
}

function persistSession(sessionId: string, options: { deletedUserId?: string; mergePersisted?: boolean } = {}): BrowserChatSessionRealtimePatch | true | false {
  try {
    const currentSession = sessions.get(sessionId);
    const persistedHeader = currentSession?.runtimeCompacted
      ? readBrowserChatSessionHeader<BrowserChatPersistedSessionSnapshot>(sessionId)
      : undefined;
    const incoming: BrowserChatPersistedSessionSnapshot | undefined = currentSession ? {
      ...snapshot(currentSession, { fullSteps: true }),
      ...(persistedHeader ? {
        consoleErrors: persistedHeader.consoleErrors || [],
        contextUsage: persistedHeader.contextUsage,
        networkErrors: persistedHeader.networkErrors || [],
        outputCycles: persistedHeader.outputCycles || [],
        subagents: persistedHeader.subagents || [],
      } : {}),
      modelContext: normalizeBrowserChatModelContext(persistedHeader?.modelContext || currentSession.modelContext),
    } : undefined;
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

async function persistBrowserChatCheckpoint(sessionId: string) {
  clearPendingPersist(sessionId);
  const persisted = persistSession(sessionId, { mergePersisted: false });
  if (!persisted) return false;
  const pendingWrite = pendingSqliteWrites.get(sessionId);
  return pendingWrite ? pendingWrite : true;
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
  return new BrowserSession({
    browserSurface: 'electron-embedded',
    browserProfileKey,
    ...(process.env.ELECTRON_EMBEDDED_BROWSER === 'true' ? {} : { sharedBrowserRuntimeKey: browserProfileKey }),
    ...browserChatBrowserExecutionOptions(),
    browserCodeStateSessionId: session.id,
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
    const staleBrowser = session.browser;
    await session.browser.close({ keepOpen: true }).catch(() => undefined);
    assertTurnActive?.();
    // Browser tools are created once per model turn and retain this object.
    // Restart it in place so the current turn also reconnects to the tab group.
    session.browser = staleBrowser;
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
    queuedTurns: [],
    consoleErrors: [],
    networkErrors: [],
    logs: [],
    modelContext: normalizeBrowserChatModelContext(undefined),
  };
  session.browserGroupId = `session:${session.id}`;
  const userKey = browserChatUserRuntimeKey(session.userId);
  const previouslySelectedSessionId = selectedSessionIds.get(userKey);
  selectedSessionIds.set(userKey, session.id);
  sessions.set(session.id, session);
  cancelBrowserChatSessionEviction(session.id);
  if (previouslySelectedSessionId && previouslySelectedSessionId !== session.id) {
    scheduleBrowserChatSessionEviction(previouslySelectedSessionId);
  }
  persistAndNotify(session.id);
  return clientSnapshot(session);
}

function durableBrowserChatSnapshot(session: BrowserChatSessionRecord) {
  const persisted = readSessionSnapshot(session.id);
  const runtimeSnapshot: BrowserChatPersistedSessionSnapshot = {
    ...snapshot(session, { fullSteps: true }),
    modelContext: normalizeBrowserChatModelContext(session.modelContext),
  };
  return mergePersistedSessionSnapshot(persisted, runtimeSnapshot);
}

export function selectBrowserChatSessionRuntime(sessionId: string, userId?: string | number) {
  const runtimeSession = sessions.get(sessionId);
  const owner = runtimeSession || readBrowserChatSessionOwner(sessionId);
  if (!owner || !sessionBelongsToUser(owner, userId)) return false;
  const userKey = browserChatUserRuntimeKey(owner.userId);
  const previouslySelectedSessionId = selectedSessionIds.get(userKey);
  selectedSessionIds.set(userKey, sessionId);
  if (runtimeSession && browserChatSessionHasRuntimeWork(runtimeSession)) {
    cancelBrowserChatSessionEviction(sessionId);
  } else if (runtimeSession) {
    scheduleBrowserChatSessionEviction(sessionId);
  }
  if (previouslySelectedSessionId && previouslySelectedSessionId !== sessionId) {
    scheduleBrowserChatSessionEviction(previouslySelectedSessionId);
  }
  return true;
}

export async function releaseBrowserChatSessionRuntime(sessionId: string, userId?: string | number) {
  const runtimeSession = sessions.get(sessionId);
  const owner = runtimeSession || readBrowserChatSessionOwner(sessionId);
  if (!owner || !sessionBelongsToUser(owner, userId)) return false;
  const userKey = browserChatUserRuntimeKey(owner.userId);
  if (selectedSessionIds.get(userKey) === sessionId) selectedSessionIds.delete(userKey);
  if (!runtimeSession) return true;
  if (browserChatSessionHasActiveRuntimeWork(runtimeSession)) {
    scheduleBrowserChatSessionEviction(sessionId);
    return true;
  }
  return releaseInactiveBrowserChatSessionRuntime(sessionId);
}

export function getBrowserChatSession(sessionId: string, userId?: string | number) {
  const runtimeSession = sessions.get(sessionId);
  const persisted = runtimeSession
    ? durableBrowserChatSnapshot(runtimeSession)
    : readSessionSnapshot(sessionId);
  if (!persisted || !sessionBelongsToUser(persisted, userId)) return undefined;
  const { modelContext: _modelContext, ...clientSession } = persisted;
  void _modelContext;
  return {
    ...clientSession,
    steps: clientSession.steps.map(compactStepForClient),
    logs: compactBrowserChatLogsForClient(clientSession.logs || []),
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
  return clientSnapshot(session);
}

export function updateBrowserChatSessionTitle(sessionId: string, title: string, userId?: string | number) {
  const session = hydrateSession(sessionId);
  if (!session || !sessionBelongsToUser(session, userId)) return undefined;
  const normalized = title.trim();
  if (!normalized || normalized.length > 240) throw new Error('Invalid browser chat session title');
  session.title = normalized;
  session.titleFileName = undefined;
  session.updatedAt = now();
  persistAndNotify(session.id);
  return clientSnapshot(session);
}

export function listBrowserChatSessions(input: { userId?: string | number } = {}) {
  const summaries = new Map(readSessionSummaries(input.userId).map((session) => [session.id, session]));
  for (const session of sessions.values()) summaries.set(session.id, summarySnapshot(session));
  return [...summaries.values()]
    .filter((session) => session.hasMessages && sessionBelongsToUser(session, input.userId))
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
  if (session.queuedTurns.length) {
    const queuedMessageIds = new Set(session.queuedTurns.map((item) => item.userMessageId));
    session.queuedTurns = [];
    session.messages = session.messages.map((message) => {
      if (!queuedMessageIds.has(message.id) || message.status !== 'queued') return message;
      const interruptedMessage = { ...message, status: 'interrupted' as const, updatedAt: now() };
      markMessageDirty(session, interruptedMessage);
      return interruptedMessage;
    });
  }

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
    if ((record.status !== 'running' && record.status !== 'queued') || (assistantMessageId && record.assistantMessageId !== assistantMessageId)) continue;
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
  return clientSnapshot(session);
}

export async function closeBrowserChatRuntimeBrowser(browserId: string) {
  const separator = browserId.indexOf(':');
  const kind = separator > 0 ? browserId.slice(0, separator) : '';
  const id = separator > 0 ? browserId.slice(separator + 1) : '';
  if (!id) return false;

  if (kind === 'subagent') {
    const binding = blockedSubagents.get(id);
    if (!binding) return false;
    blockedSubagents.delete(id);
    await binding.browser.close({ closePages: true, force: true }).catch(() => undefined);
    updateBrowserChatStoredSubagent(binding.sessionId, id, {
      status: 'failed',
      error: '测试浏览器已由管理员手动关闭。',
    });
    return true;
  }

  if (kind !== 'session') return false;
  const session = sessions.get(id);
  if (!session?.browser) return false;
  if (browserChatSessionHasActiveRuntimeWork(session)) {
    await stopBrowserChatRuntime(session, new Error('Test browser closed by administrator.'), { forceBrowser: true });
    transitionBrowserChatSession(session, { type: 'sessionRecovered', at: now() });
  } else {
    const browser = restoreBrowserSessionPrototype(session.browser);
    session.browser = undefined;
    session.started = false;
    if (browser) await browser.close({ closePages: true, force: true }).catch(() => undefined);
  }
  session.updatedAt = now();
  persistAndNotify(session.id);
  return true;
}

export async function deleteBrowserChatSession(sessionId: string, userId?: string | number) {
  const session = hydrateSession(sessionId);
  if (session && !sessionBelongsToUser(session, userId)) return undefined;
  const removed = await deleteBrowserChatSessionFromMemory(sessionId);
  if (!removed) return undefined;
  const durableSnapshot = durableBrowserChatSnapshot(removed.session);
  try {
    archiveAiOperationsChatSession({
      ...durableSnapshot,
      logs: [...(durableSnapshot.logs || [])],
    });
  } catch (error) {
    sessions.set(sessionId, removed.session);
    throw error;
  }
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
  return clientSnapshot(session);
}

export async function startBrowserChatScreencast(
  sessionId: string,
  userId: string | number | undefined,
  handlers: {
    onActivePageChanged?: () => void;
    onError?: (error: unknown) => void;
    onFrame: (frame: BrowserScreencastFrame) => void | Promise<void>;
    onNativeEvent?: (event: BrowserLiveNativeEvent) => void;
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
      onNativeEvent: handlers.onNativeEvent,
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
  const previewKey = session.id;
  browserPreviewCounts.set(previewKey, (browserPreviewCounts.get(previewKey) || 0) + 1);
  let stopped = false;
  return {
    ...handle,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      try {
        await handle.stop();
      } finally {
        const remaining = Math.max(0, (browserPreviewCounts.get(previewKey) || 1) - 1);
        if (remaining) browserPreviewCounts.set(previewKey, remaining);
        else browserPreviewCounts.delete(previewKey);
        scheduleBrowserChatUserIdleClose(userKey);
        scheduleBrowserChatSessionEviction(session.id);
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

  let resolvedInput = input;
  if (input.kind === 'files') {
    const configuredMaxTotalBytes = Number(process.env.WEBPILOT_LIVE_FILE_MAX_BYTES || 100 * 1024 * 1024);
    const maxTotalBytes = Number.isFinite(configuredMaxTotalBytes)
      ? Math.min(512 * 1024 * 1024, Math.max(1024, configuredMaxTotalBytes))
      : 100 * 1024 * 1024;
    let totalBytes = 0;
    const files = input.files.slice(0, 8).map((file) => {
      const relativePath = normalizeBrowserChatUploadPath(file.path, session.userId);
      if (!relativePath || relativePath.split('/').length < 3) return undefined;
      const absolutePath = artifactPath(...relativePath.split('/'));
      if (!existsSync(absolutePath)) return undefined;
      const metadata = statSync(absolutePath);
      totalBytes += metadata.size;
      if (!metadata.isFile() || totalBytes > maxTotalBytes) return undefined;
      return {
        mimeType: String(file.mimeType || 'application/octet-stream').slice(0, 160),
        name: path.basename(String(file.name || path.basename(relativePath))).slice(0, 180),
        path: absolutePath,
      };
    }).filter((file): file is NonNullable<typeof file> => Boolean(file));
    if (!files.length || files.length !== input.files.length) {
      return { ok: false, actual: 'One or more uploaded files are invalid or unavailable.' };
    }
    resolvedInput = { ...input, files };
  }

  const result = await browser.dispatchLiveInput(resolvedInput);
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
  const userKey = browserChatUserRuntimeKey(session.userId);
  if (selectedSessionIds.get(userKey) === sessionId) selectedSessionIds.delete(userKey);
  sessions.delete(sessionId);
  persistenceCursors.delete(sessionId);
  dirtyRecords.delete(sessionId);
  subagentResults.delete(sessionId);
  browserPreviewCounts.delete(sessionId);
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
  const removed: Array<{
    deleted: { id: string };
    durableSnapshot: BrowserChatPersistedSessionSnapshot;
    session: BrowserChatSessionRecord;
  }> = [];
  for (const sessionId of uniqueIds) {
    const session = hydrateSession(sessionId);
    if (session && !sessionBelongsToUser(session, userId)) continue;
    const result = await deleteBrowserChatSessionFromMemory(sessionId);
    if (result) {
      removed.push({ ...result, durableSnapshot: durableBrowserChatSnapshot(result.session) });
      deleted.push(result.deleted);
    }
  }
  if (removed.length) {
    try {
      for (const item of removed) {
        archiveAiOperationsChatSession({
          ...item.durableSnapshot,
          logs: [...(item.durableSnapshot.logs || [])],
        });
      }
    } catch (error) {
      for (const item of removed) sessions.set(item.deleted.id, item.session);
      throw error;
    }
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
  const runtimeSession = sessions.get(sessionId);
  const persistedSession = runtimeSession
    ? durableBrowserChatSnapshot(runtimeSession)
    : readSessionSnapshot(sessionId);
  const session = persistedSession ? recordFromSnapshot(persistedSession) : undefined;
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
    triggerPhrases: generated.triggerPhrases,
    content: generated.content,
    sourceSessionId: session.id,
    status: 'ready',
    userId: session.userId,
  });
  return { skill, sourceMessageIds: uniqueMessageIds };
}

const browserChatQueuedTurnLimit = 50;

function nextBrowserChatMessageTimestamp(session: BrowserChatSessionRecord) {
  const latestCreatedAt = session.messages.reduce((latest, message) => {
    const timestamp = Date.parse(message.createdAt);
    return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
  }, 0);
  return new Date(Math.max(Date.now(), latestCreatedAt + 1)).toISOString();
}

function startNextQueuedBrowserChatTurn(session: BrowserChatSessionRecord) {
  if (
    session.status === 'closed'
    || session.busy
    || activeTurns.has(session.id)
    || session.turnState === 'awaiting_human'
  ) return false;

  let queued: BrowserChatQueuedTurn | undefined;
  let userMessageIndex = -1;
  while (session.queuedTurns.length) {
    const candidate = session.queuedTurns.shift();
    if (!candidate) break;
    const candidateIndex = session.messages.findIndex((message) => (
      message.id === candidate.userMessageId
      && message.role === 'user'
      && message.status === 'queued'
    ));
    if (candidateIndex < 0) continue;
    queued = candidate;
    userMessageIndex = candidateIndex;
    break;
  }
  if (!queued || userMessageIndex < 0) return false;

  store.applyRuntimeEnv();
  cancelPendingToolConfirmation(session);
  cancelOrphanToolConfirmationsForSession(session.id);
  transitionBrowserChatSession(session, { type: 'confirmationCleared' });
  session.safetyMode = normalizeSafetyMode(queued.safetyMode);
  const modelSettings = browserChatModelSettings(queued.modelProvider, queued.model);
  session.modelProvider = modelSettings.provider;
  session.model = modelSettings.model;

  const queuedUserMessage = session.messages[userMessageIndex];
  const selectedSkills = store.getSkills(queuedUserMessage.skillIds || [], session.userId)
    .filter((skill) => skill.status === 'ready');
  const attachments = queuedUserMessage.attachments || [];
  const messageText = queuedUserMessage.content;
  const referencedAttachmentIds = inlineReferencedIds(messageText, 'ref');
  const modelMessageText = [
    contentWithInlineReferencesForPrompt(messageText, attachments),
    formatSkillReferencesForUser(selectedSkills),
    attachmentSummary(attachments, { excludeIds: referencedAttachmentIds }),
  ].filter(Boolean).join('\n\n');
  const timestamp = now();
  const userMessage: BrowserChatMessage = {
    ...queuedUserMessage,
    status: undefined,
    skillIds: selectedSkills.map((skill) => skill.id),
    updatedAt: timestamp,
  };
  session.messages[userMessageIndex] = userMessage;
  markMessageDirty(session, userMessage);

  const assistantMessage: BrowserChatMessage = {
    id: id('msg'),
    role: 'assistant',
    content: '',
    createdAt: userMessage.createdAt,
    updatedAt: timestamp,
    clientMessageId: userMessage.clientMessageId,
    status: 'running',
    stepIndexes: [],
    activity: {
      phase: 'chat:queued',
      label: '已从等待队列取出消息，准备执行对话与浏览器操作',
      updatedAt: timestamp,
    },
  };
  session.messages.splice(userMessageIndex + 1, 0, assistantMessage);
  markMessageDirty(session, assistantMessage);

  const fromStepIndex = Math.max(0, ...session.steps.map((step) => step.index)) + 1;
  const abortController = new AbortController();
  registerBrowserChatTurn(activeTurns, session.id, {
    session,
    assistantMessageId: assistantMessage.id,
    abortController,
  }, browserChatTurnTimeoutOptions());
  transitionBrowserChatSession(session, {
    type: 'turnStarted',
    assistantMessageId: assistantMessage.id,
    abortController,
    at: timestamp,
  });
  persistAndNotify(session.id);
  appendLog(session, 'chat:dequeued', '等待队列中的下一条消息已开始处理', { messageId: assistantMessage.id });
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
  return true;
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
  const firstMessageTitleText = text || (attachments.length ? '' : messageText);
  const skillReferences = formatSkillReferencesForUser(selectedSkills);
  const referencedAttachmentIds = inlineReferencedIds(messageText, 'ref');
  const inlineMessageText = contentWithInlineReferencesForPrompt(messageText, attachments);
  const attachmentReferences = attachmentSummary(attachments, { excludeIds: referencedAttachmentIds });
  const modelMessageText = [inlineMessageText, skillReferences, attachmentReferences].filter(Boolean).join('\n\n');
  const normalizedClientMessageId = clientMessageId?.trim().slice(0, 120) || undefined;
  if (normalizedClientMessageId && session.messages.some((message) => message.clientMessageId === normalizedClientMessageId)) {
    return clientSnapshot(session);
  }
  const requestedSafetyMode = normalizeSafetyMode(safetyMode ?? session.safetyMode);
  const requestedModelSettings = browserChatModelSettings(modelProvider ?? session.modelProvider, model ?? session.model);
  if (attachments.some(isBrowserChatImageAttachment) && !requestedModelSettings.supportsImageInput) {
    throw new ApiRequestError(
      `模型 ${requestedModelSettings.model} 未配置图片输入能力，请在“模型配置”中启用后再上传图片。`,
      { code: 'model_image_input_unsupported', status: 400 },
    );
  }
  if (
    session.busy
    || activeTurns.has(session.id)
    || session.queuedTurns.length > 0
    || session.turnState === 'awaiting_human'
  ) {
    if (session.queuedTurns.length >= browserChatQueuedTurnLimit) {
      throw new Error(`Browser chat message queue is full (${browserChatQueuedTurnLimit})`);
    }
    const queuedAt = nextBrowserChatMessageTimestamp(session);
    const firstUserMessage = !session.messages.some((message) => message.role === 'user');
    if (firstUserMessage) session.title = browserChatFirstMessageTitle(firstMessageTitleText, attachments);
    const userMessage: BrowserChatMessage = {
      id: id('msg'),
      role: 'user',
      content: messageText,
      createdAt: queuedAt,
      updatedAt: queuedAt,
      clientMessageId: normalizedClientMessageId,
      attachments,
      skillIds: selectedSkills.map((skill) => skill.id),
      status: 'queued',
    };
    session.messages.push(userMessage);
    session.queuedTurns.push({
      id: id('queued_turn'),
      userMessageId: userMessage.id,
      safetyMode: requestedSafetyMode,
      modelProvider: requestedModelSettings.provider,
      model: requestedModelSettings.model,
      queuedAt,
    });
    markMessageDirty(session, userMessage);
    session.updatedAt = queuedAt;
    appendLog(session, 'chat:queue:added', `消息已进入等待队列，前面还有 ${Math.max(0, session.queuedTurns.length - 1)} 条`, {
      messageId: null,
      details: { queuedTurnId: session.queuedTurns.at(-1)?.id, queueLength: session.queuedTurns.length },
    });
    return clientSnapshot(session);
  }
  finalizeIdleRunningAssistantMessages(session);
  store.applyRuntimeEnv();
  cancelPendingToolConfirmation(session);
  cancelOrphanToolConfirmationsForSession(session.id);
  transitionBrowserChatSession(session, { type: 'confirmationCleared' });
  session.safetyMode = requestedSafetyMode;
  const modelSettings = requestedModelSettings;
  session.modelProvider = modelSettings.provider;
  session.model = modelSettings.model;
  const firstUserMessage = !session.messages.some((message) => message.role === 'user');
  if (firstUserMessage) session.title = browserChatFirstMessageTitle(firstMessageTitleText, attachments);

  const timestamp = nextBrowserChatMessageTimestamp(session);
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
  }, browserChatTurnTimeoutOptions());
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
  return clientSnapshot(session);
}

export function deleteQueuedBrowserChatMessage(
  sessionId: string,
  messageId: string,
  userId?: string | number,
) {
  const session = hydrateSession(sessionId);
  if (!session || !sessionBelongsToUser(session, userId)) return undefined;

  const normalizedMessageId = messageId.trim();
  const queuedTurnIndex = session.queuedTurns.findIndex((turn) => turn.userMessageId === normalizedMessageId);
  const messageIndex = session.messages.findIndex((message) => (
    message.id === normalizedMessageId
    && message.role === 'user'
    && message.status === 'queued'
  ));
  if (queuedTurnIndex < 0 || messageIndex < 0) {
    throw new ApiRequestError('Only messages that are still queued can be deleted', {
      code: 'queued_message_not_deletable',
      status: 409,
    });
  }

  const [queuedTurn] = session.queuedTurns.splice(queuedTurnIndex, 1);
  session.messages.splice(messageIndex, 1);
  markMessageRemoved(session, normalizedMessageId);
  session.updatedAt = now();
  appendLog(session, 'chat:queue:deleted', '排队消息已删除', {
    messageId: null,
    details: {
      queuedTurnId: queuedTurn.id,
      userMessageId: normalizedMessageId,
      queueLength: session.queuedTurns.length,
    },
  });
  return clientSnapshot(session);
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
  }, browserChatTurnTimeoutOptions());
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
  return clientSnapshot(session);
}

function updateAssistantMessage(
  session: BrowserChatSessionRecord,
  assistantMessageId: string,
  updater: (message: BrowserChatMessage) => BrowserChatMessage,
) {
  const index = session.messages.findIndex((message) => message.id === assistantMessageId);
  if (index < 0) return;
  const updated = updater(session.messages[index]);
  const artifacts = mergeBrowserChatArtifactSummaries(
    updated.artifacts,
    browserChatArtifactsFromSteps(session.steps.filter((step) => step.messageId === assistantMessageId)),
  );
  session.messages[index] = {
    ...updated,
    artifacts,
    updatedAt: updated.updatedAt || now(),
  };
  markMessageDirty(session, session.messages[index]);
}

function appendBrowserChatOutputCycle(session: BrowserChatSessionRecord, cycle: BrowserChatAiOutputCycle) {
  const outputCycles = session.outputCycles || [];
  const lastSequence = outputCycles.reduce((highest, item) => (
    typeof item.sequence === 'number' && Number.isFinite(item.sequence)
      ? Math.max(highest, item.sequence)
      : highest
  ), 0);
  session.outputCycles = trimBrowserChatOutputCycles([...outputCycles, {
    ...cycle,
    sequence: cycle.sequence ?? lastSequence + 1,
    createdAt: cycle.createdAt || now(),
  }]);
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
  if (phase === 'ai:context-compression:start') return '正在压缩上下文';
  if (phase === 'ai:context-compression:complete' || phase === 'ai:context-segmented') return '上下文压缩完成，正在准备模型输入';
  if (phase === 'ai:runtime:request') return '正在请求 AI 模型';
  if (phase === 'ai:runtime:response') return 'AI 已返回，正在处理结果';
  if (phase === 'ai:runtime:object') return 'AI 已返回，正在解析动作';
  if (phase === 'ai:runtime:attempt-failed' || phase === 'ai:runtime:retry') return message;
  if (phase === 'ai:runtime:retry-exhausted') return 'AI 请求重试已耗尽';
  if (phase === 'ai:runtime:retry-skipped') return 'AI 请求失败，该错误不可重试';
  if (phase === 'ai:runtime:attempt-succeeded') return 'AI 已返回，正在处理结果';
  if (phase === 'ai:runtime:partial') return '工具已执行，正在继续判断';
  if (phase === 'ai:context-compressed') return '正在压缩上下文';
  if (phase === 'ai:visual-context') return '正在更新视觉上下文';
  if (phase === 'ai:document-visual-qa:queued') return '文档预览已生成，正在交给模型检查';
  if (phase === 'ai:document-visual-qa:unavailable') return '文档预览已验证，当前模型未启用图片检查';
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
  browser?: BrowserSession,
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
    ['network-write', /\b(?:post|put|patch|delete)\b|写入请求/],
    ['update', /\b(?:update|edit|modify|save|write)\b|更新|编辑|修改|保存|写入|设置/],
  ];
  const operation = operations.find(([, pattern]) => pattern.test(text))?.[0];
  if (!operation) return undefined;
  const currentUrl = browser?.currentUrl() || session.browser?.currentUrl() || session.targetUrl;
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
  options: { recordLogs?: boolean; serialize?: boolean } = {},
) {
  const confirmedScopes = new Set<string>();
  const confirmedInputs = new Set<string>();
  let confirmationQueue = Promise.resolve();
  const requestWithReuse = async (
    request: BrowserToolConfirmationRequest,
    browser?: BrowserSession,
    onDecision?: (interaction: BrowserChatSubagentConfirmationInteraction) => void,
    subagentId?: string,
  ): Promise<BrowserToolConfirmationDecision> => {
    const inputSignature = toolConfirmationInputSignature(request.input);
    const inputKey = `${request.toolName}:${inputSignature}`;
    const scope = browserChatToolConfirmationScope(session, request, browser);
    if (confirmedInputs.has(inputKey) || (scope && confirmedScopes.has(scope))) {
      if (options.recordLogs !== false) {
        appendLog(session, 'tool:confirmation:reused', `已复用本轮用户对 ${request.reason || request.prompt} 的确认。`, {
          stepIndex: request.stepIndex,
          messageId: assistantMessageId,
          details: { inputKey, scope, toolName: request.toolName },
        });
      }
      return 'confirmed';
    }
    const decision = await requestBrowserChatToolConfirmation(
      session,
      assistantMessageId,
      request,
      abortSignal,
      browser,
      { onDecision, recordLogs: options.recordLogs !== false, subagentId },
    );
    if (decision === 'confirmed') {
      confirmedInputs.add(inputKey);
      if (scope) confirmedScopes.add(scope);
    }
    return decision;
  };
  return async (
    request: BrowserToolConfirmationRequest,
    browser?: BrowserSession,
    onDecision?: (interaction: BrowserChatSubagentConfirmationInteraction) => void,
    subagentId?: string,
  ): Promise<BrowserToolConfirmationDecision> => {
    if (!options.serialize) return requestWithReuse(request, browser, onDecision, subagentId);
    const previous = confirmationQueue;
    let release!: () => void;
    confirmationQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await requestWithReuse(request, browser, onDecision, subagentId);
    } finally {
      release();
    }
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

async function captureBrowserChatToolConfirmationScreenshot(
  session: BrowserChatSessionRecord,
  request: BrowserToolConfirmationRequest,
  browser: BrowserSession | undefined = session.browser,
  recordErrors = true,
) {
  if (!browser) return undefined;
  try {
    const stepIndex = request.stepIndex || Math.max(1, ...session.steps.map((step) => step.index));
    const phase = `tool-${Date.now()}` as `tool-${number}`;
    const screenshotPath = await browser.takeScreenshot(session.id, stepIndex, phase, {
      capture: 'viewport',
      outputPixelRatio: 1,
    });
    const relativePath = path.relative(artifactsRoot(), screenshotPath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return undefined;
    return artifactApiUrlFromRelative(relativePath.split(path.sep).join('/'));
  } catch (error) {
    if (recordErrors) {
      appendLog(session, 'tool:confirmation:screenshot:error', '确认前页面截图获取失败，确认操作仍可继续。', {
        stepIndex: request.stepIndex,
        details: { error: error instanceof Error ? error.message : String(error), toolName: request.toolName },
      });
    }
    return undefined;
  }
}

async function requestBrowserChatToolConfirmation(
  session: BrowserChatSessionRecord,
  assistantMessageId: string,
  request: BrowserToolConfirmationRequest,
  abortSignal?: AbortSignal,
  browser?: BrowserSession,
  options: {
    onDecision?: (interaction: BrowserChatSubagentConfirmationInteraction) => void;
    recordLogs?: boolean;
    subagentId?: string;
  } = {},
): Promise<BrowserToolConfirmationDecision> {
  if (abortSignal?.aborted) return 'cancelled';
  const existing = session.pendingToolConfirmation;
  const existingResolver = existing ? toolConfirmations.get(existing.id) : undefined;
  const inputSignature = toolConfirmationInputSignature(request.input);
  if (
    existing
    && existingResolver?.sessionId === session.id
    && existing.messageId === assistantMessageId
    && existing.subagentId === (options.subagentId?.trim() || undefined)
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
  const screenshotUrl = await captureBrowserChatToolConfirmationScreenshot(
    session,
    request,
    browser,
    options.recordLogs !== false,
  );
  if (abortSignal?.aborted) return 'cancelled';
  const pending: BrowserChatToolConfirmation = {
    id: confirmationId,
    messageId: assistantMessageId,
    subagentId: options.subagentId?.trim() || undefined,
    stepIndex: request.stepIndex,
    toolName: request.toolName,
    inputSignature,
    reason: request.reason ? compactText(request.reason, 300) : undefined,
    prompt: compactText(request.prompt || `请确认是否执行工具 ${request.toolName}`, 500),
    screenshotUrl,
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
        if (options.recordLogs !== false) {
          const log = toolConfirmationLog(decision);
          appendLog(session, log.phase, log.message, {
            stepIndex: pending.stepIndex,
            messageId: assistantMessageId,
            details: {
              confirmationId,
              decision,
              toolName: pending.toolName,
              subagentId: pending.subagentId,
              inputSignature: pending.inputSignature,
              screenshotUrl: pending.screenshotUrl,
            },
          });
        }
      }
      options.onDecision?.({
        id: pending.id,
        toolName: pending.toolName,
        input: request.input,
        prompt: pending.prompt,
        reason: pending.reason,
        screenshotUrl: pending.screenshotUrl,
        requestedAt: pending.requestedAt,
        decision,
      });
      resolve(decision);
    };
    onAbort = () => finish('cancelled');
    transitionBrowserChatSession(session, {
      type: 'confirmationPending',
      confirmation: pending,
      at: requestedAt,
    });
    if (options.recordLogs !== false) {
      appendLog(session, 'tool:confirmation:pending', `工具 ${request.toolName} 等待用户确认。`, {
        stepIndex: request.stepIndex,
        messageId: assistantMessageId,
        details: { confirmation: pending, input: request.input },
      });
    } else {
      persistAndNotify(session.id);
    }
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
  return clientSnapshot(session);
}

export function interruptBrowserChatSession(
  sessionId: string,
  targetClientMessageId: string,
  userId?: string | number,
) {
  const normalizedTargetClientMessageId = targetClientMessageId.trim();
  if (!normalizedTargetClientMessageId) throw new Error('Browser chat turn id is required');
  // Prefer the live runtime record. Interrupt must not wait for persistence
  // rehydration while an AI request is actively running.
  const registeredCandidate = activeTurns.get(sessionId);
  const session = sessions.get(sessionId) || registeredCandidate?.session || hydrateSession(sessionId);
  if (!session) return undefined;
  if (!sessionBelongsToUser(session, userId)) return undefined;
  const registeredTurn = registeredCandidate && assistantMessageMatchesClientTurn(
    registeredCandidate.session,
    registeredCandidate.assistantMessageId,
    normalizedTargetClientMessageId,
  ) ? registeredCandidate : undefined;
  const timestamp = now();
  const reason = new Error('Browser chat operation interrupted by user.');
  const runtimeRecords = new Set<BrowserChatSessionRecord>([
    session,
    ...(registeredTurn?.session ? [registeredTurn.session] : []),
  ]);
  const assistantMessageIds = new Set<string>();
  for (const runtimeRecord of runtimeRecords) {
    for (const messageId of runningAssistantMessageIdsForClientTurn(
      runtimeRecord,
      normalizedTargetClientMessageId,
    )) assistantMessageIds.add(messageId);
    if (assistantMessageMatchesClientTurn(
      runtimeRecord,
      runtimeRecord.activeAssistantMessageId,
      normalizedTargetClientMessageId,
    )) assistantMessageIds.add(runtimeRecord.activeAssistantMessageId!);
  }
  if (registeredTurn) assistantMessageIds.add(registeredTurn.assistantMessageId);
  if (!assistantMessageIds.size) return clientSnapshot(session);
  const assistantMessageId = registeredTurn?.assistantMessageId
    || [...assistantMessageIds][0];
  if (assistantMessageMatchesClientTurn(
    session,
    session.activeAssistantMessageId,
    normalizedTargetClientMessageId,
  )) transitionBrowserChatSession(session, { type: 'turnStopping', at: timestamp });

  // Delete the execution registration before dispatching abort. This is the
  // irreversible stop boundary: persisted state, delayed request retries, and
  // child-Agent completions cannot recreate ownership for this execution.
  for (const messageId of assistantMessageIds) markAssistantMessageInterrupted(messageId);
  const registeredRevocation = registeredTurn
    ? revokeRegisteredBrowserChatTurnByAssistantMessageId(
        activeTurns,
        sessionId,
        registeredTurn.assistantMessageId,
        reason,
      )
    : undefined;
  let sessionAbortDispatched = false;
  for (const runtimeRecord of runtimeRecords) {
    const activeAssistantMessageId = runtimeRecord.activeAssistantMessageId;
    if (activeAssistantMessageId && assistantMessageIds.has(activeAssistantMessageId)) {
      cancelPendingToolConfirmation(runtimeRecord);
      const revoked = revokeBrowserChatTurn(runtimeRecord, timestamp, reason);
      sessionAbortDispatched ||= revoked.abortDispatched;
    } else if (
      runtimeRecord.pendingToolConfirmation?.messageId
      && assistantMessageIds.has(runtimeRecord.pendingToolConfirmation.messageId)
    ) {
      cancelPendingToolConfirmation(runtimeRecord);
    }
    for (const messageId of assistantMessageIds) {
      preserveInterruptedTurn(runtimeRecord, messageId, timestamp);
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
  return clientSnapshot(session);
}

async function runBrowserChatSubagents(input: {
  session: BrowserChatSessionRecord;
  assistantMessageId: string;
  abortController: AbortController;
  tasks: BrowserChatSubagentTask[];
  toolCallId?: string;
}): Promise<BrowserActionResult> {
  const requestedTasks = input.tasks;
  const normalizedTasks = requestedTasks.map((task) => ({
    title: task.title.replace(/\s+/g, ' ').trim(),
    instruction: task.instruction.replace(/\s+/g, ' ').trim(),
    url: task.url?.trim().toLowerCase() || '',
  }));
  const key = [
    input.session.id,
    input.assistantMessageId,
    input.toolCallId || 'missing-tool-call-id',
    JSON.stringify(normalizedTasks),
  ].join(':');
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
  update: Partial<Pick<BrowserChatStoredSubagent, 'status' | 'content' | 'summary' | 'summaryChars' | 'summaryOriginalChars' | 'summaryTruncated' | 'toolCount' | 'currentAction' | 'steps' | 'outputCycles' | 'messages' | 'error'>>,
) {
  const record = browserChatSubagentSessionRegistry(sessionId).get(uuid);
  if (!record) return;
  const boundedUpdate = {
    ...update,
    ...(update.steps !== undefined ? { steps: compactBrowserChatSubagentSteps(update.steps) } : {}),
    ...(update.outputCycles !== undefined ? { outputCycles: trimBrowserChatOutputCycles(update.outputCycles) } : {}),
  };
  Object.assign(record, boundedUpdate, { updatedAt: now() });
  const session = sessions.get(sessionId);
  if (session) {
    upsertBrowserChatSubagent(session, {
      id: record.uuid,
      messageId: record.assistantMessageId,
      batchId: record.batchId,
      index: record.index,
      title: record.title,
      instruction: record.task.instruction,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      status: record.status,
      content: record.content,
      summary: record.summary || undefined,
      resumable: blockedSubagents.has(record.uuid),
      toolCount: record.toolCount,
      currentAction: record.currentAction,
      steps: [...record.steps],
      outputCycles: [...record.outputCycles],
      messages: [...record.messages],
      error: record.error,
    });
  }
}

function recordBrowserChatSubagentConfirmation(
  sessionId: string,
  subagentId: string,
  interaction: BrowserChatSubagentConfirmationInteraction,
) {
  const record = browserChatSubagentSessionRegistry(sessionId).get(subagentId);
  if (!record) return;
  const message = browserChatSubagentConfirmationMessage(subagentId, interaction);
  const messages = limitBrowserChatSubagentMessages(
    subagentId,
    [...record.messages.filter((item) => item.id !== message.id), message],
  );
  updateBrowserChatStoredSubagent(sessionId, subagentId, { messages });
  persistAndNotify(sessionId, { defer: true });
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
    if (record.status === 'running' || record.status === 'queued') {
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

type BrowserChatSubagentBrowserAuthMode = 'shared-context' | 'storage-snapshot' | 'profile';

async function createBrowserChatSubagentBrowser(
  session: BrowserChatSessionRecord,
  subagentId: string,
  assertTurnActive: BrowserChatTurnGuard,
) {
  let parentBrowser = restoreBrowserSessionPrototype(session.browser);
  if (!parentBrowser?.isUsable()) {
    try {
      parentBrowser = await ensureStarted(session, assertTurnActive, { preferExistingPage: true });
    } catch (error) {
      appendLog(session, 'subagent:browser:parent-start-fallback', '子 Agent 无法启动父级浏览器上下文，已回退到独立浏览器配置。', {
        messageId: session.activeAssistantMessageId,
        details: { error: userFacingErrorMessage(error), subagentId },
      });
      parentBrowser = undefined;
    }
  }
  if (parentBrowser?.isUsable()) {
    try {
      const browser = await parentBrowser.forkChildSession({
        ...browserChatBrowserExecutionOptions(),
        background: true,
        browserCodeStateSessionId: session.id,
        inheritSessionStorage: true,
        isMarked: true,
        runId: `${session.id}_${subagentId}`,
      });
      return { authMode: 'shared-context' as const, browser };
    } catch (error) {
      appendLog(session, 'subagent:browser:fork-fallback', '子 Agent 无法派生父级浏览器页面，已回退到独立浏览器并复制当前登录状态。', {
        messageId: session.activeAssistantMessageId,
        details: { error: userFacingErrorMessage(error), subagentId },
      });
    }
  }

  const inheritedStorageState = parentBrowser?.isUsable()
    ? await parentBrowser.exportStorageState().catch(() => undefined)
    : undefined;
  const browserProfileKey = browserChatBrowserProfileKey(session);
  const browser = new BrowserSession({
    browserSurface: 'external',
    headless: true,
    browserProfileKey,
    sharedBrowserRuntimeKey: browserProfileKey,
    storageState: inheritedStorageState,
    ...browserChatBrowserExecutionOptions(),
    browserCodeStateSessionId: session.id,
    isMarked: true,
    preferExistingPage: false,
    runId: `${session.id}_${subagentId}`,
  });
  await browser.start();
  return {
    authMode: inheritedStorageState ? 'storage-snapshot' as const : 'profile' as const,
    browser,
  };
}

function browserChatSubagentAuthPrompt(authMode: BrowserChatSubagentBrowserAuthMode) {
  if (authMode === 'shared-context') {
    return '你的独立后台页面与父 Agent 实时共享同一个浏览器身份环境，包括 Cookie、localStorage 和 IndexedDB；不要重新登录，也不要退出登录，因为登录态变化会同时影响父 Agent 和其他子 Agent。';
  }
  if (authMode === 'storage-snapshot') {
    return '独立浏览器已复制父会话启动时的 Cookie、localStorage 和 IndexedDB 登录状态；请先直接访问目标地址验证登录态，不要重新登录。后续登录态变化不会自动同步回父 Agent。';
  }
  return '当前没有正在运行的父级浏览器上下文；独立浏览器会复用当前用户的持久化浏览器配置。请先直接访问目标地址验证登录态，不要猜测页面内容。';
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
  const requestedTasks = input.tasks;
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
      status: 'queued',
      content: '',
      summary: '',
      summaryChars: 0,
      summaryOriginalChars: 0,
      summaryTruncated: false,
      toolCount: 0,
      currentAction: '等待执行',
      steps: [],
      outputCycles: [],
      messages: [browserChatSubagentInputMessage(task.id, task.instruction)],
      createdAt,
      updatedAt: createdAt,
    });
    upsertBrowserChatSubagent(session, {
      id: task.id,
      messageId: assistantMessageId,
      batchId,
      index,
      title: task.title,
      instruction: task.instruction,
      createdAt,
      updatedAt: createdAt,
      status: 'queued',
      content: '',
      resumable: false,
      toolCount: 0,
      currentAction: '等待执行',
      steps: [],
      outputCycles: [],
      messages: [browserChatSubagentInputMessage(task.id, task.instruction)],
    });
  });
  persistAndNotify(session.id);
  const requestBatchToolConfirmation = createBrowserChatTurnToolConfirmation(
    session,
    assistantMessageId,
    abortController.signal,
    { recordLogs: false, serialize: true },
  );

  const summaryGuidanceChars = browserChatSubagentSuggestedSummaryChars();

  const settled = await settleBrowserChatSubagents(tasks, async (task) => {
    if (!ownsTurn()) throw abortController.signal.reason || new Error('对话已中断');
    updateBrowserChatStoredSubagent(session.id, task.id, {
      status: 'running',
      currentAction: '正在启动',
    });
    persistAndNotify(session.id);
    let child: BrowserSession | undefined;
    const childSteps = new Map<number, StepExecutionResult>();
    const childOutputCycles: BrowserChatAiOutputCycle[] = [];
    let streamedSubagentText = '';
    const liveSubagentMessages = () => {
      const confirmationMessages = (registry.get(task.id)?.messages || [])
        .filter((message) => message.id.includes(':message:confirmation:'));
      return browserChatSubagentMessagesFromProgress({
        subagentId: task.id,
        instruction: task.instruction,
        steps: [...childSteps.values()],
        streamedText: streamedSubagentText,
        preservedMessages: confirmationMessages,
      });
    };
    try {
      const childBrowser = await createBrowserChatSubagentBrowser(session, task.id, () => {
        if (!ownsTurn()) throw abortController.signal.reason || new Error('对话已中断');
      });
      const activeChild = childBrowser.browser;
      child = activeChild;
      if (!ownsTurn()) throw abortController.signal.reason || new Error('对话已中断');
      if (task.url) await activeChild.open(task.url);
      if (!ownsTurn()) throw abortController.signal.reason || new Error('对话已中断');
      const getRuntimeOperationalContext = await createBrowserChatRuntimeOperationalContext({
        session,
        browser: activeChild,
        text: task.instruction,
        modelText: task.instruction,
        usedMemoryIds: browserChatTurnUsedMemoryIds(session, assistantMessageId),
      });
      const initialRuntimeContext = await getRuntimeOperationalContext();
      const executeChildAttempt = (attemptNumber: number, retryReason = '') => executeInteractiveBrowserTurn({
        session: activeChild,
        runId: `${session.id}_${task.id}`,
        turnId: `${assistantMessageId}:subagent:${task.id}:attempt:${attemptNumber}`,
        targetUrl: task.url || session.targetUrl || activeChild.currentUrl() || 'about:blank',
        instruction: task.instruction,
        modelInstruction: [
          `你是并行子 Agent“${task.title}”。只完成当前这个独立分支，并返回可追溯事实、来源地址、页面证据、失败原因和未解决问题。`,
          retryReason
            ? `[自动重试 ${attemptNumber}/2] 上一次子任务在没有执行任何工具时失败：${retryReason}。重新读取当前页面状态，从头执行本任务，不要只复述上一次错误。`
            : '',
          '你拥有完整浏览器工具集。完成当前分支后立即返回；不要读取或等待其他子 Agent，也不要因为其他分支失败而停止。',
          browserChatSubagentAuthPrompt(childBrowser.authMode),
          '你运行在独立的子 Agent 页面中。遇到必须由用户处理的验证码、扫码、OTP 或设备确认时，不要继续尝试绕过；请明确报告阻塞证据并把该步骤交回主 Agent。',
          '浏览器检查与操作统一使用 browserCode，在隔离程序中直接调用真实 Playwright page/context，并返回可追溯的结构化证据。需要跨内核或跨轮次保留的非敏感 JSON 数据使用 agent.state。',
          '只有已经发现明确的懒加载、虚拟列表或无限滚动证据，且目标内容尚未加载时才滚动；不要把滚动当作默认页面读取方式。',
          '单个工具失败只属于过程诊断。如果已经通过其他页面证据完成任务，最终整体状态必须是 passed。不要单独创建失败记录、验证记录或透明披露章节；只有尚未解决且实质影响目标结果的失败，才在受影响的结论旁简短说明。',
          summaryGuidanceChars
            ? `完成工具执行后，直接在你自己的最终回复中写出信息完整、可独立使用的执行总结。配置建议将篇幅控制在约 ${summaryGuidanceChars} 个字符以内，但这不是截断上限；如果完整证据需要更长内容，必须完整返回。优先覆盖来源 URL、已验证事实、字段和表格、图片与 iframe 信息、失败步骤、限制、未读取区域和未解决项；不要为凑字数重复内容。不要再启动子 Agent，也不要要求主 Agent 另行读取结果。`
            : '完成工具执行后，直接在你自己的最终回复中写出信息完整、可独立使用的执行总结。优先覆盖来源 URL、已验证事实、字段和表格、图片与 iframe 信息、失败步骤、限制、未读取区域和未解决项；不要为凑字数重复内容。不要再启动子 Agent，也不要要求主 Agent 另行读取结果。',
          task.instruction,
        ].filter(Boolean).join('\n\n'),
        operationalContext: initialRuntimeContext.operationalContext,
        conversation: [],
        completedSteps: [],
        safetyMode: session.safetyMode,
        useToolLoopAgent: true,
        credentialBindings: initialRuntimeContext.credentialBindings,
        getRuntimeOperationalContext,
        readSkill: getRuntimeOperationalContext.readSkill,
        abortSignal: abortController.signal,
        shouldContinue: ownsTurn,
        requestToolConfirmation: session.safetyMode === 'strict'
          ? (request) => requestBatchToolConfirmation(
            request,
            activeChild,
            (interaction) => recordBrowserChatSubagentConfirmation(session.id, task.id, interaction),
            task.id,
          )
          : undefined,
        onTextStream: ({ text }) => {
          if (!ownsTurn()) return;
          streamedSubagentText = text;
          updateBrowserChatStoredSubagent(session.id, task.id, {
            content: text,
            messages: liveSubagentMessages(),
          });
          persistAndNotify(session.id, { defer: true });
        },
        onDebug: (event) => {
          if (!ownsTurn()) return;
          const outputCycle = browserChatAiOutputCycleFromDebugEvent({
            details: event.details,
            id: id('subagent_cycle'),
            messageId: task.id,
            phase: event.phase,
            stepIndex: event.stepIndex,
            sequence: childOutputCycles.length + 1,
            createdAt: now(),
            subagentId: task.id,
            batchId,
          });
          if (!outputCycle) return;
          childOutputCycles.push(outputCycle);
          if (childOutputCycles.length > browserChatOutputCycleLimit()) {
            childOutputCycles.splice(0, childOutputCycles.length - browserChatOutputCycleLimit());
          }
          updateBrowserChatStoredSubagent(session.id, task.id, {
            outputCycles: [...childOutputCycles],
          });
          persistAndNotify(session.id, { defer: true });
        },
        onProgress: (step) => {
          if (!ownsTurn()) return;
          childSteps.set(step.index, step);
          const steps = [...childSteps.values()];
          updateBrowserChatStoredSubagent(session.id, task.id, {
            status: step.status === 'blocked' ? 'blocked' : 'running',
            currentAction: step.action || step.actual || '正在执行',
            toolCount: steps.reduce((count, childStep) => count + (childStep.tools || []).length, 0),
            steps,
            messages: liveSubagentMessages(),
          });
          persistAndNotify(session.id, { defer: true });
        },
      });
      const result = await runBrowserChatSubagentAttemptWithRetry({
        run: executeChildAttempt,
        shouldRetryResult: (attemptResult) => (
          attemptResult.status === 'failed'
          && attemptResult.newSteps.reduce((count, step) => count + (step.tools || []).length, 0) === 0
        ),
        retryReasonFromError: userFacingErrorMessage,
        retryReasonFromResult: (attemptResult) => userFacingErrorMessage(
          attemptResult.reply || attemptResult.newSteps.at(-1)?.actual || '子 Agent 未执行任何工具即结束',
        ),
        onRetry: () => {
          if (!ownsTurn()) throw abortController.signal.reason || new Error('对话已中断');
          streamedSubagentText = '';
          childSteps.clear();
          updateBrowserChatStoredSubagent(session.id, task.id, {
          status: 'running',
          content: '',
          currentAction: '首次执行失败，正在自动重试 2/2',
          error: undefined,
          steps: [],
          messages: [browserChatSubagentInputMessage(task.id, task.instruction)],
          });
          persistAndNotify(session.id);
        },
      });
      if (!ownsTurn()) throw abortController.signal.reason || new Error('对话已中断');
      const summaryResult = preserveBrowserChatSubagentSummary(
        textFromUnknown(result.reply || result.newSteps.at(-1)?.actual || '子 Agent 已完成，但没有返回额外文本。'),
      );
      const summary = summaryResult.summary;
      const status = resolvedBrowserChatSubagentStatus({
        status: result.status,
        summary,
        steps: result.newSteps,
      });
      const resultMessages = browserChatSubagentMessagesFromModelMessages(task.id, result.turnMessages);
      const modelMessages = resultMessages.some((message) => message.role === 'user')
        ? resultMessages
        : [browserChatSubagentInputMessage(task.id, task.instruction), ...resultMessages];
      const confirmationMessages = (registry.get(task.id)?.messages || [])
        .filter((message) => message.id.includes(':message:confirmation:'));
      const messages = limitBrowserChatSubagentMessages(task.id, [...modelMessages, ...confirmationMessages]);
      updateBrowserChatStoredSubagent(session.id, task.id, {
        status,
        content: summary,
        ...summaryResult,
        currentAction: undefined,
        toolCount: result.newSteps.reduce((count, step) => count + (step.tools || []).length, 0),
        steps: result.steps,
        outputCycles: [...childOutputCycles],
        messages,
      });
      persistAndNotify(session.id);
      return { id: task.id, title: task.title, task, status, summary, content: summary };
    } catch (error) {
      if (!ownsTurn()) throw error;
      const message = userFacingErrorMessage(error);
      const steps = [...childSteps.values()].sort((left, right) => left.index - right.index);
      const partialSummaryResult = preserveBrowserChatSubagentSummary(
        steps.map((step) => step.actual).filter(Boolean).join('\n\n'),
      );
      const partialContent = partialSummaryResult.summary;
      const storedMessages = registry.get(task.id)?.messages || [];
      updateBrowserChatStoredSubagent(session.id, task.id, {
        status: 'failed',
        content: partialContent,
        ...partialSummaryResult,
        currentAction: undefined,
        toolCount: steps.reduce((count, step) => count + (step.tools || []).length, 0),
        steps,
        outputCycles: [...childOutputCycles],
        messages: partialContent
          ? [...storedMessages, { id: `${task.id}:message:error`, role: 'assistant' as const, content: partialContent }]
          : storedMessages,
        error: message,
      });
      persistAndNotify(session.id);
      return {
        id: task.id,
        title: task.title,
        task,
        status: 'failed' as const,
        error: message,
        partial: Boolean(partialContent || steps.length),
        summary: partialContent,
        content: partialContent,
      };
    } finally {
      await child?.close().catch(() => undefined);
    }
  });

  if (!ownsTurn()) throw abortController.signal.reason || new Error('对话已中断');
  const results = settled.map((settledResult, index) => {
    const task = settledResult.task;
    if (settledResult.result) return settledResult.result;
    const error = userFacingErrorMessage(settledResult.error);
    void index;
    updateBrowserChatStoredSubagent(session.id, task.id, { status: 'failed', currentAction: undefined, error });
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
  const getRuntimeOperationalContext = await withModelSettings(
    browserChatModelSettings(session.modelProvider, session.model),
    () => createBrowserChatRuntimeOperationalContext({
      session,
      browser: binding.browser,
      text: binding.task.instruction,
      modelText: binding.task.instruction,
      usedMemoryIds: browserChatTurnUsedMemoryIds(session, assistantMessageId),
    }),
  );
  const initialRuntimeContext = await getRuntimeOperationalContext();
  const requestSubagentToolConfirmation = createBrowserChatTurnToolConfirmation(
    session,
    assistantMessageId,
    abortController.signal,
    { recordLogs: false },
  );
  const childOutputCycles = [...binding.outputCycles];
  let streamedSubagentText = '';
  const liveSubagentMessages = (steps: readonly StepExecutionResult[]) => browserChatSubagentMessagesFromProgress({
    subagentId: binding.id,
    instruction: binding.task.instruction,
    steps,
    streamedText: streamedSubagentText,
    preservedMessages: browserChatSubagentSessionRegistry(session.id).get(binding.id)?.messages || [],
  });
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
        '单个工具失败只属于过程诊断。如果已经通过其他页面证据完成任务，最终整体状态必须是 passed。不要单独创建失败记录、验证记录或透明披露章节；只有尚未解决且实质影响目标结果的失败，才在受影响的结论旁简短说明。',
        binding.task.instruction,
      ].filter(Boolean).join('\n\n'),
      operationalContext: initialRuntimeContext.operationalContext,
      conversation: [],
      completedSteps: binding.steps,
      safetyMode: session.safetyMode,
      useToolLoopAgent: true,
      credentialBindings: initialRuntimeContext.credentialBindings,
      getRuntimeOperationalContext,
      readSkill: getRuntimeOperationalContext.readSkill,
      abortSignal: abortController.signal,
      shouldContinue: ownsTurn,
      requestToolConfirmation: session.safetyMode === 'strict'
        ? (request) => requestSubagentToolConfirmation(
          request,
          binding.browser,
          (interaction) => recordBrowserChatSubagentConfirmation(session.id, binding.id, interaction),
          binding.id,
          )
        : undefined,
      onTextStream: ({ text }) => {
        if (!ownsTurn()) return;
        streamedSubagentText = text;
        updateBrowserChatStoredSubagent(session.id, binding.id, {
          content: text,
          messages: liveSubagentMessages(binding.steps),
        });
        persistAndNotify(session.id, { defer: true });
      },
      onDebug: (event) => {
        if (!ownsTurn()) return;
        const stored = browserChatSubagentSessionRegistry(session.id).get(binding.id);
        const outputCycle = browserChatAiOutputCycleFromDebugEvent({
          details: event.details,
          id: id('subagent_cycle'),
          messageId: binding.id,
          phase: event.phase,
          stepIndex: event.stepIndex,
          sequence: childOutputCycles.length + 1,
          createdAt: now(),
          subagentId: binding.id,
          batchId: stored?.batchId,
        });
        if (!outputCycle) return;
        childOutputCycles.push(outputCycle);
        if (childOutputCycles.length > browserChatOutputCycleLimit()) {
          childOutputCycles.splice(0, childOutputCycles.length - browserChatOutputCycleLimit());
        }
        binding.outputCycles = [...childOutputCycles];
        updateBrowserChatStoredSubagent(session.id, binding.id, {
          outputCycles: [...childOutputCycles],
        });
        persistAndNotify(session.id, { defer: true });
      },
      onProgress: (step) => {
        if (!ownsTurn()) return;
        const nextSteps = [...binding.steps.filter((item) => item.index !== step.index), step].sort((left, right) => left.index - right.index);
        binding.steps = nextSteps;
        updateBrowserChatStoredSubagent(session.id, binding.id, {
          status: step.status === 'blocked' ? 'blocked' : 'running',
          currentAction: step.action || step.actual || '正在继续',
          toolCount: nextSteps.reduce((count, childStep) => count + (childStep.tools || []).length, 0),
          steps: nextSteps,
          messages: liveSubagentMessages(nextSteps),
        });
        persistAndNotify(session.id, { defer: true });
      },
    }));
    if (!ownsTurn()) return;
    const summaryResult = preserveBrowserChatSubagentSummary(
      textFromUnknown(result.reply || result.newSteps.at(-1)?.actual || '子 Agent 续跑完成。'),
    );
    const summary = summaryResult.summary;
    const status = resolvedBrowserChatSubagentStatus({
      status: result.status,
      summary,
      steps: result.newSteps,
    });
    binding.steps = result.steps;
    const stored = browserChatSubagentSessionRegistry(session.id).get(binding.id);
    const resumedMessages = browserChatSubagentMessagesFromModelMessages(
      binding.id,
      result.turnMessages,
      stored?.messages.length || 0,
    );
    updateBrowserChatStoredSubagent(session.id, binding.id, {
      status,
      content: summary,
      ...summaryResult,
      currentAction: undefined,
      toolCount: result.steps.reduce((count, step) => count + (step.tools || []).length, 0),
      steps: result.steps,
      outputCycles: [...childOutputCycles],
      messages: limitBrowserChatSubagentMessages(
        binding.id,
        [...(stored?.messages || []), ...resumedMessages],
        stored?.messages.length || 0,
      ),
      error: undefined,
    });
    if (status === 'blocked') {
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
    updateBrowserChatStoredSubagent(session.id, binding.id, {
      status: 'failed',
      currentAction: undefined,
      error: message,
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
  } finally {
    transitionBrowserChatSession(session, {
      type: 'turnRuntimeReleased',
      assistantMessageId,
      abortController,
    });
    startNextQueuedBrowserChatTurn(session);
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
    session.contextUsage = undefined;
    const assertTurnActive = () => {
      if (isActiveBrowserChatTurn(session, assistantMessageId, abortController)) return;
      throw abortController.signal.reason || new Error('Browser chat operation interrupted by user.');
    };
    try {
      assertTurnActive();
      appendLog(session, 'chat:run:start', '开始处理本轮对话操作');
      // Reserve one stable BrowserSession for this turn without launching it.
      // The first main-browser tool starts this exact instance through
      // ensureBrowserStarted. Subagent browser work starts it explicitly when
      // acquiring a shared child page; ordinary chat, file, and skill work does not.
      const browser = await browserForTurnDecision(session, assertTurnActive, { preferExistingPage: true });
      assertTurnActive();
      const historicalMessages = readAllBrowserChatMessages<BrowserChatMessage>(session.id);
      const historicalSteps = readAllBrowserChatSteps<StepExecutionResult>(session.id);
      const usedMemoryIds = browserChatTurnUsedMemoryIds(session, assistantMessageId);
      const getRuntimeOperationalContext = await createBrowserChatRuntimeOperationalContext({
        session,
        browser,
        text,
        modelText,
        explicitlySelectedSkills: skills,
        usedMemoryIds,
        historicalMessages,
        historicalSteps,
      });
      const initialRuntimeContext = await getRuntimeOperationalContext();
      appendLog(session, 'ai:prepare', '正在请求 AI 判断是否需要浏览器工具');
      const referenceImagePaths = attachments
        .filter(isBrowserChatImageAttachment)
        .map((attachment) => uploadedBrowserChatAttachmentPath(attachment, session.userId))
        .filter((item): item is string => Boolean(item));
      const requestTurnToolConfirmation = session.safetyMode === 'strict'
        ? createBrowserChatTurnToolConfirmation(session, assistantMessageId, abortController.signal)
        : undefined;
      const turnTranscriptBase = [...session.modelContext.transcript];
      const result = await executeInteractiveBrowserTurn({
        session: browser,
        runId: session.id,
        turnId: assistantMessageId,
        targetUrl: session.targetUrl || 'about:blank',
        instruction: text,
        modelInstruction: modelText,
        operationalContext: initialRuntimeContext.operationalContext,
        conversation: session.modelContext.activeMessages,
        continuationSummary: session.modelContext.continuationSummary || session.modelContext.lastCompression?.continuationSummary,
        completedSteps: session.steps,
        safetyMode: session.safetyMode,
        memoryTools: createPersonalMemoryTools({
          userId: session.userId,
          getCurrentUrl: () => browserChatMemoryUrl(browser, session),
          sourceSessionId: session.id,
          sourceMessageIds: [userMessageId, assistantMessageId],
          usedMemoryIds,
          userMessages: session.messages
            .filter((message) => message.role === 'user')
            .slice(-64)
            .map((message) => compactText(message.content, 2_000)),
        }),
        referenceImagePaths,
        credentialBindings: initialRuntimeContext.credentialBindings,
        getRuntimeOperationalContext,
        readSkill: getRuntimeOperationalContext.readSkill,
        abortSignal: abortController.signal,
        shouldContinue: () => isActiveBrowserChatTurn(session, assistantMessageId, abortController),
        requestToolConfirmation: requestTurnToolConfirmation,
        ensureBrowserStarted: async () => {
          assertTurnActive();
          const startedBrowser = await ensureStarted(session, assertTurnActive);
          assertTurnActive();
          if (startedBrowser !== browser) throw new Error('The active browser session was replaced after this turn started.');
        },
        runSubagents: (tasks, _abortSignal, toolCallId) => runBrowserChatSubagents({ session, assistantMessageId, abortController, tasks, toolCallId }),
        readSubagent: readBrowserChatSubagent(session.id),
        readFile: (input) => readFileForSession(session, input, historicalMessages),
        readFileVisuals: (input) => readFileVisualsForSession(session, input),
        attachmentBindings: browserCodeAttachmentBindingsForSession(session, historicalMessages),
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
        onModelMessages: ({ activeMessages, turnMessages }) => {
          if (!isActiveBrowserChatTurn(session, assistantMessageId, abortController)) return;
          session.modelContext = normalizeBrowserChatModelContext({
            ...session.modelContext,
            version: 1,
            transcript: compactBrowserChatModelTranscript([
              ...turnTranscriptBase,
              ...serializableBrowserChatModelMessages(turnMessages),
            ]),
            activeMessages: serializableBrowserChatModelMessages(activeMessages),
          });
          persistAndNotify(session.id, { defer: true, mergePersisted: false });
        },
        onContextCompression: async ({ activeMessages, contextCompression }) => {
          assertTurnActive();
          session.modelContext = normalizeBrowserChatModelContext({
            ...session.modelContext,
            version: 1,
            activeMessages: serializableBrowserChatModelMessages(activeMessages),
            lastCompression: contextCompression,
          });
          if (!(await persistBrowserChatCheckpoint(session.id))) {
            throw new Error('Failed to persist the browser-chat context compression checkpoint.');
          }
          assertTurnActive();
        },
        onContinuationSummary: async (continuationSummary) => {
          assertTurnActive();
          session.modelContext = normalizeBrowserChatModelContext({
            ...session.modelContext,
            continuationSummary,
          });
          if (!(await persistBrowserChatCheckpoint(session.id))) {
            throw new Error('Failed to persist the browser-chat continuation checkpoint.');
          }
          assertTurnActive();
        },
        onProgress: (step) => {
          if (!isActiveBrowserChatTurn(session, assistantMessageId, abortController)) return;
          const ownedStep = { ...step, messageId: assistantMessageId };
          const nextSteps = [
            ...session.steps.filter((item) => item.index !== step.index),
            ownedStep,
          ].sort((left, right) => left.index - right.index);
          replaceSessionSteps(session, nextSteps);
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
          // Tool progress is cumulative: the latest step contains every trace
          // seen so far. Coalesce bursty start/completion updates into the
          // existing short persistence window; terminal/checkpoint paths still
          // flush synchronously, so no final state is left pending.
          persistAndNotify(session.id, { defer: true, mergePersisted: false });
        },
        onDebug: (event) => {
          if (!isActiveBrowserChatTurn(session, assistantMessageId, abortController)) return;
          if (event.phase === 'ai:runtime:request'
            || event.phase === 'ai:context-compression:start'
            || event.phase === 'ai:context-compression:complete') {
            session.contextUsage = browserChatContextUsageFromDebugDetails(event.details, {
              provider: session.modelProvider,
              model: session.model,
            })
              || session.contextUsage;
          }
          const outputCycle = browserChatAiOutputCycleFromDebugEvent({
            details: event.details,
            id: id('cycle'),
            messageId: assistantMessageId,
            phase: event.phase,
            stepIndex: event.stepIndex,
          });
          if (outputCycle) appendBrowserChatOutputCycle(session, outputCycle);
          const persistImmediately = event.phase === 'ai:runtime:attempt-failed'
            || event.phase === 'ai:runtime:retry'
            || event.phase === 'ai:runtime:retry-exhausted'
            || event.phase === 'ai:runtime:retry-skipped'
            || event.phase.startsWith('ai:context-compression:')
            || event.phase === 'ai:context-segmented'
            || event.phase.startsWith('ai:document-visual-qa:');
          appendLog(session, event.phase, event.message, {
            stepIndex: event.stepIndex,
            elapsedMs: elapsedFromDetails(event.details),
            details: event.details,
            deferPersist: !persistImmediately,
          });
        },
      });
      if (!isActiveBrowserChatTurn(session, assistantMessageId, abortController)) return;
      const turnMessages = serializableBrowserChatModelMessages(result.turnMessages);
      session.modelContext = normalizeBrowserChatModelContext({
        version: 1,
        transcript: compactBrowserChatModelTranscript([
          ...turnTranscriptBase,
          ...turnMessages,
        ]),
        activeMessages: serializableBrowserChatModelMessages(result.modelMessages),
        ...(result.continuationSummary ? { continuationSummary: result.continuationSummary } : {}),
        ...(result.contextCompression ? { lastCompression: result.contextCompression } : (
          session.modelContext.lastCompression ? { lastCompression: session.modelContext.lastCompression } : {}
        )),
      });
      appendLog(session, 'chat:run:saving', '正在写入本轮对话最终结果', { deferPersist: true });
      replaceSessionSteps(session, result.steps.map((step) => (
        step.index >= fromStepIndex ? { ...step, messageId: assistantMessageId } : step
      )));
      refreshBrowserChatTerminalContextUsage(session);
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
      compactBrowserChatRuntimeWindow(session);
      if (result.status !== 'blocked') scheduleBrowserChatUserIdleClose(session.userId);
      void enforceBrowserChatArtifactQuota(session.id).catch((error) => warnPersistFailure(error));
    } catch (error) {
      const abortMessage = abortController.signal.reason instanceof Error
        ? abortController.signal.reason.message
        : String(abortController.signal.reason || '');
      const timedOut = /Browser chat turn exceeded the \d+ minute hard limit/i.test(abortMessage);
      const registeredTurn = activeTurns.get(session.id);
      const stillActive = isActiveBrowserChatTurn(session, assistantMessageId, abortController)
        || (timedOut
          && registeredTurn?.session === session
          && registeredTurn.assistantMessageId === assistantMessageId
          && registeredTurn.abortController === abortController);
      const interrupted = !timedOut
        && (abortController.signal.aborted || interruptedAssistantMessageIds.has(assistantMessageId));
      if (!stillActive) return;
      const message = userFacingErrorMessage(error);
      const details = errorLogDetails(error);
      const terminalReply = timedOut
        ? `This turn exceeded the ${Math.round(browserChatTurnHardTimeoutMs() / 60_000)} minute hard limit and was stopped.`
        : interrupted ? browserChatInterruptedReply : `执行异常：${message}`;
      if (isDeadBrowserSessionError(error)) {
        await session.browser?.close({ keepOpen: true }).catch(() => undefined);
        session.browser = undefined;
        session.started = false;
      }
      appendLog(
        session,
        interrupted ? 'chat:run:interrupted' : timedOut ? 'chat:run:timeout' : 'chat:run:error',
        interrupted ? '用户主动中断了本轮对话。' : timedOut ? terminalReply : `本轮对话异常：${message}`,
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
        content: terminalReply,
        updatedAt: session.updatedAt,
        status: interrupted ? 'interrupted' : 'failed',
        activity: undefined,
      }));
      if (!interrupted) {
        session.modelContext = normalizeBrowserChatModelContext({
          ...session.modelContext,
          transcript: appendTerminalBrowserChatTurn(session.modelContext.transcript, modelText, terminalReply),
          activeMessages: appendTerminalBrowserChatTurn(session.modelContext.activeMessages, modelText, terminalReply),
        });
      }
      refreshBrowserChatTerminalContextUsage(session);
      clearRegisteredBrowserChatTurn(activeTurns, session.id, assistantMessageId, abortController);
      await persistAndNotifyTerminal(session.id);
      compactBrowserChatRuntimeWindow(session);
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
      startNextQueuedBrowserChatTurn(session);
    }
  });
}
