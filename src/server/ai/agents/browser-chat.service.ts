import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { generateText } from 'ai';
import { BrowserSession, type BrowserActionResult, type BrowserScreencastFrame, type BrowserSessionMode, type BrowserTabSnapshot } from '@/server/browser/browser-session';
import { electronEmbeddedBrowserEnabled } from '@/server/browser/browser-session-runtime';
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
import { runOrReuseBrowserChatSubagentBatch, settleBrowserChatSubagents } from '@/server/ai/agents/browser-chat-subagents';
import { formatSkillReferencesForUser, formatSkillsForPrompt } from '@/server/ai/agents/skill-context';
import { executeTargetWorkflow } from '@/server/ai/agents/target-workflow-executor.service';
import {
  mergeTargetResearchBundles,
  researchTargetRequirement,
  targetResearchDelegationSeeds,
  type TargetResearchSeed,
} from '@/server/ai/agents/target-requirement-researcher.agent';
import { generateTargetWorkflowPlan, targetWorkflowPlanningReply } from '@/server/ai/agents/target-workflow-planner.agent';
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
import {
  targetPlanIsReady,
  targetWorkflowRunSchema,
  validateTargetPlanStructure,
  type TargetActor,
  type TargetLeafNode,
  type TargetPlan,
  type TargetWorkflowRun,
} from '@/server/ai/schemas/target-workflow.schema';
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
  getLoginAccountById,
  listLoginAccounts,
  normalizeLoginAccountDomain,
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

export type TargetWorkflowRequirementResponse = {
  requirementId: string;
  value: string;
};

export type TargetWorkflowActorCredentialReference = {
  actorId: string;
  credentialId: string;
};

export type ContinueTargetWorkflowInput = {
  responses?: TargetWorkflowRequirementResponse[];
  actorCredentialIds?: TargetWorkflowActorCredentialReference[];
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
  targetRun?: TargetWorkflowRun;
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
  steps: StepExecutionResult[];
  events: unknown[];
  error?: string;
  createdAt: string;
  updatedAt: string;
};

type BrowserChatRuntimeState = {
  sessions: Map<string, BrowserChatSessionRecord>;
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

type TargetActorBrowserBinding = {
  browser: BrowserSession;
  browserSessionId: string;
  identityFingerprint: string;
};

type TargetWorkflowRuntimeState = {
  // BrowserSession remains in the union for hot-reload compatibility with the
  // pre-binding runtime shape. Legacy values are discarded on their next use.
  actorBrowsers: Map<string, TargetActorBrowserBinding | BrowserSession>;
  actorLoginControllers: Map<string, AbortController>;
  credentials: Map<string, {
    actorId: string;
    attemptId: string;
    expiresAt: number;
    sessionId: string;
    value: string;
  }>;
};

const browserChatRuntimeState = ((globalThis as typeof globalThis & {
  __browserChatRuntimeState?: BrowserChatRuntimeState;
}).__browserChatRuntimeState ??= {
  sessions: new Map<string, BrowserChatSessionRecord>(),
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
browserChatRuntimeState.blockedSubagents ??= new Map();
browserChatRuntimeState.subagentResults ??= new Map();
browserChatRuntimeState.interruptedAssistantMessageIds ??= new Set();
browserChatRuntimeState.toolConfirmations ??= new Map();
browserChatRuntimeState.pendingPersistTimers ??= new Map();

const sessions = browserChatRuntimeState.sessions;
const blockedSubagents = browserChatRuntimeState.blockedSubagents;
const subagentResults = browserChatRuntimeState.subagentResults;
const interruptedAssistantMessageIds = browserChatRuntimeState.interruptedAssistantMessageIds;
const toolConfirmations = browserChatRuntimeState.toolConfirmations;
const pendingPersistTimers = browserChatRuntimeState.pendingPersistTimers;
const targetWorkflowRuntimeState = ((globalThis as typeof globalThis & {
  __targetWorkflowRuntimeState?: TargetWorkflowRuntimeState;
}).__targetWorkflowRuntimeState ??= {
  actorBrowsers: new Map(),
  actorLoginControllers: new Map<string, AbortController>(),
  credentials: new Map(),
});
targetWorkflowRuntimeState.actorBrowsers ??= new Map();
targetWorkflowRuntimeState.actorLoginControllers ??= new Map();
targetWorkflowRuntimeState.credentials ??= new Map();
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
  return `user_${userId || 'default'}_${session.id}`;
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

function normalizeTargetRun(value: unknown) {
  const parsed = targetWorkflowRunSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const targetPlanningActiveStatuses: TargetWorkflowRun['status'][] = [
  'discovering_sources',
  'researching_sources',
  'awaiting_research_access',
  'synthesizing_requirements',
];
const targetResearchStepBase = 2_000_000;
const targetResearchStepLimit = targetResearchStepBase + 100_000;

function recoverOrphanedTargetRun(value: unknown) {
  const run = normalizeTargetRun(value);
  if (!run) return undefined;
  const timestamp = now();
  const executionInterrupted = run.status === 'running'
    || run.status === 'summarizing'
    || (run.status === 'ready' && Boolean(run.confirmedAt));
  const planningInterrupted = targetPlanningActiveStatuses.includes(run.status);
  const plan = run.plan ? {
    ...run.plan,
    actors: run.plan.actors.map((actor) => actor.auth.status === 'verifying' ? {
      ...actor,
      auth: {
        ...actor.auth,
        status: 'failed' as const,
        credentialsAvailable: false,
        message: '上一次登录验证因服务运行态丢失而中断，请重新登录或再次检查。',
      },
    } : actor),
  } : undefined;
  const hadInterruptedAuthentication = Boolean(run.plan?.actors.some((actor) => actor.auth.status === 'verifying'));
  if (!executionInterrupted && !planningInterrupted && !hadInterruptedAuthentication) return run;
  const results = { ...run.results };
  if (executionInterrupted && plan) {
    for (const node of plan.nodes) {
      if (node.type !== 'target') continue;
      const previous = results[node.id];
      if (previous && !['pending', 'running'].includes(previous.status)) continue;
      results[node.id] = {
        targetId: node.id,
        actorId: node.actorId,
        status: 'cancelled',
        startedAt: previous?.startedAt,
        endedAt: timestamp,
        summary: '执行进程已中断，未继续后台操作。',
        failureReason: '服务重启或运行态丢失。',
        criteria: node.successCriteria.map((criterion) => ({
          criterionId: criterion.id,
          status: 'inconclusive',
          observation: '执行已中断，证据不完整。',
          evidence: [],
        })),
        evidence: previous?.evidence || [],
        outputs: previous?.outputs || {},
        stepIndexes: previous?.stepIndexes,
      };
    }
  }
  const unresolved = plan?.requirements.some((item) => item.required && item.status === 'missing');
  const pendingAuth = plan?.actors.some((actor) => actor.auth.required && actor.auth.status !== 'ready');
  return {
    ...run,
    plan,
    results,
    status: executionInterrupted
      ? 'cancelled' as const
      : planningInterrupted
        ? 'failed' as const
        : unresolved
          ? 'collecting_requirements' as const
          : pendingAuth
            ? 'preparing_authentication' as const
            : 'awaiting_confirmation' as const,
    error: executionInterrupted
      ? '目标执行因服务重启或运行态丢失而中断。'
      : planningInterrupted
        ? '目标分析因服务重启或运行态丢失而中断，请重新发送需求。'
        : run.error,
    endedAt: executionInterrupted ? timestamp : run.endedAt,
    updatedAt: timestamp,
  };
}

function cancelActiveTargetWorkflowRun(run: TargetWorkflowRun | undefined, reason: string, timestamp = now()) {
  if (!run) return run;
  if (targetPlanningActiveStatuses.includes(run.status)) {
    return {
      ...run,
      status: run.plan ? targetPlanPreparationStatus(run.plan) : 'failed',
      error: reason,
      updatedAt: timestamp,
    };
  }
  if (!run.plan || !['ready', 'running', 'summarizing'].includes(run.status)) return run;
  const results = { ...run.results };
  for (const node of run.plan.nodes) {
    if (node.type !== 'target') continue;
    const previous = results[node.id];
    if (previous && !['pending', 'running'].includes(previous.status)) continue;
    results[node.id] = {
      targetId: node.id,
      actorId: node.actorId,
      status: 'cancelled',
      startedAt: previous?.startedAt,
      endedAt: timestamp,
      summary: '目标执行已中断，未继续后台操作。',
      failureReason: reason,
      criteria: node.successCriteria.map((criterion) => (
        previous?.criteria.find((item) => item.criterionId === criterion.id) || {
          criterionId: criterion.id,
          status: 'inconclusive' as const,
          observation: '执行已中断，证据不完整。',
          evidence: [],
        }
      )),
      evidence: previous?.evidence || [],
      outputs: previous?.outputs || {},
      stepIndexes: previous?.stepIndexes,
    };
  }
  return {
    ...run,
    status: 'cancelled' as const,
    error: reason,
    endedAt: timestamp,
    updatedAt: timestamp,
    results,
  };
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

function targetResearchUrls(text: string) {
  const matches = text.match(/https?:\/\/[^\s<>"'\]\[(){}，。；、]+/gi) || [];
  return Array.from(new Set(matches.map((value) => value.replace(/[),.;!?]+$/g, '')))).slice(0, 40);
}

function targetResearchSourceKind(title: string, url?: string): TargetResearchSeed['kind'] {
  const value = `${title}\n${url || ''}`.toLowerCase();
  if (value.includes('axure') || value.includes('axshare.com') || /\/start\.html(?:$|[?#])/i.test(value)) return 'axure';
  if (/\.(?:png|jpe?g|gif|webp|bmp|svg)(?:$|[?#])/i.test(value)) return 'image';
  return url ? 'url' : 'other';
}

function targetResearchSeeds(session: BrowserChatSessionRecord, latestModelText = '') {
  const seeds: TargetResearchSeed[] = [];
  const add = (seed: TargetResearchSeed) => {
    const key = `${seed.kind}\u0000${seed.url || seed.title}`.toLowerCase();
    if (seeds.some((item) => `${item.kind}\u0000${item.url || item.title}`.toLowerCase() === key)) return;
    seeds.push(seed);
  };
  for (const url of targetResearchUrls(latestModelText)) {
    add({ kind: targetResearchSourceKind(url, url), title: url, url });
  }
  if (session.targetUrl) {
    add({ kind: targetResearchSourceKind(session.targetUrl, session.targetUrl), title: '目标地址', url: session.targetUrl });
  }
  for (const message of session.messages) {
    for (const url of targetResearchUrls(textFromUnknown(message.content))) {
      add({ kind: targetResearchSourceKind(url, url), title: url, url });
    }
    for (const attachment of message.attachments || []) {
      const url = attachment.kind === 'tab' ? attachment.sourceUrl || attachment.url : attachment.url || undefined;
      add({
        kind: attachment.kind === 'tab'
          ? targetResearchSourceKind(attachment.name, url) === 'axure' ? 'axure' : 'tab'
          : attachment.kind || targetResearchSourceKind(attachment.name, url),
        title: attachment.name,
        url,
      });
    }
  }
  return seeds.slice(0, 80);
}

function targetResearchCredentialContext(
  session: BrowserChatSessionRecord,
  seeds: TargetResearchSeed[],
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

function browserChatCredentialPrompt(credentials: ReturnType<typeof targetResearchCredentialContext>['credentials']) {
  if (!credentials.length) return '';
  return [
    '[后台已匹配的安全账号引用]',
    ...credentials.map((item) => `- ${item.origin} / ${item.username}：用户名使用 keyboard.credentialRef="${item.usernameRef}"，密码使用 keyboard.credentialRef="${item.passwordRef}"。`),
    '账号明文密码不会提供给模型。只能在当前页面 origin 与上述 origin 完全一致时使用 credentialRef；不得把凭据写入 text、日志或最终回复。验证码、OTP、扫码或二次认证必须调用 waitForHumanVerification。',
  ].join('\n');
}

function targetResearchImagePaths(session: BrowserChatSessionRecord) {
  return Array.from(new Set(session.messages
    .flatMap((message) => message.attachments || [])
    .map(attachmentAbsolutePath)
    .filter((item): item is string => Boolean(item))));
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
    targetRun: normalizeTargetRun(session.targetRun),
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
    targetRun: normalizeTargetRun(session.targetRun),
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

function recordFromSnapshot(
  session: BrowserChatSessionSnapshot,
  options: { preserveRunningState?: boolean; recoverOrphanedTargetRun?: boolean } = {},
): BrowserChatSessionRecord {
  const modelSettings = browserChatModelSettings(session.modelProvider, session.model);
  const persistedTargetRun = normalizeTargetRun(session.targetRun);
  const orphanedTargetActivity = options.recoverOrphanedTargetRun && Boolean(
    persistedTargetRun && (
      [...targetPlanningActiveStatuses, 'running', 'summarizing'].includes(persistedTargetRun.status)
      || (persistedTargetRun.status === 'ready' && persistedTargetRun.confirmedAt)
    ),
  );
  const preserveRecentRunningState = !orphanedTargetActivity
    && (session.busy || session.status === 'running' || options.preserveRunningState)
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
    tabs: session.tabs || [],
    targetUrl: exportableTargetUrl(session.targetUrl),
    safetyMode: normalizeSafetyMode(session.safetyMode),
    targetRun: options.recoverOrphanedTargetRun
      ? recoverOrphanedTargetRun(persistedTargetRun)
      : persistedTargetRun,
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

function readSessionLogRecords(sessionId: string) {
  return readBrowserChatLogs<BrowserChatLogRecord>(sessionId);
}

function readSessionSnapshot(sessionId: string) {
  const item = readBrowserChatSessionRecord<BrowserChatSessionSnapshot>(sessionId);
  if (!isBrowserChatSessionSnapshot(item)) return undefined;
  return { ...item, logs: trimBrowserChatLogs(readSessionLogRecords(sessionId)) };
}

function writeSessionSnapshot(item: BrowserChatSessionSnapshot) {
  const mergedLogs = mergePersistedLogs(readSessionLogRecords(item.id), item.logs);
  const storedLogs = mergedLogs.length > browserChatLogStorageLimit() ? trimBrowserChatLogs(mergedLogs) : mergedLogs;
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

function mergeTargetWorkflowRun(existing?: TargetWorkflowRun, incoming?: TargetWorkflowRun) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  if (existing.id !== incoming.id) {
    return timestampValue(incoming.updatedAt) >= timestampValue(existing.updatedAt) ? incoming : existing;
  }
  const existingPlanVersion = existing.plan?.version || 0;
  const incomingPlanVersion = incoming.plan?.version || 0;
  const planChanged = existing.plan?.id !== incoming.plan?.id || existingPlanVersion !== incomingPlanVersion;
  if (planChanged) {
    if (incomingPlanVersion !== existingPlanVersion) return incomingPlanVersion > existingPlanVersion ? incoming : existing;
    return timestampValue(incoming.updatedAt) >= timestampValue(existing.updatedAt) ? incoming : existing;
  }
  const incomingNewer = timestampValue(incoming.updatedAt) >= timestampValue(existing.updatedAt);
  const base = incomingNewer ? { ...existing, ...incoming } : { ...incoming, ...existing };
  const results = { ...existing.results };
  for (const [targetId, result] of Object.entries(incoming.results)) {
    const previous = results[targetId];
    const previousTime = Math.max(timestampValue(previous?.endedAt), timestampValue(previous?.startedAt));
    const incomingTime = Math.max(timestampValue(result.endedAt), timestampValue(result.startedAt));
    const previousFinal = previous && !['pending', 'running'].includes(previous.status);
    const incomingFinal = !['pending', 'running'].includes(result.status);
    if (!previous || incomingTime > previousTime || (incomingTime === previousTime && incomingFinal && !previousFinal)) {
      results[targetId] = result;
    }
  }
  return { ...base, results };
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
    targetRun: mergeTargetWorkflowRun(existing.targetRun, incoming.targetRun),
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
    targetRun: mergeTargetWorkflowRun(fromDisk.targetRun, existing.targetRun),
    pendingToolConfirmation: existing.pendingToolConfirmation || fromDisk.pendingToolConfirmation,
  };
}

function applyPersistedSnapshotToRuntime(persistedSnapshot: BrowserChatSessionSnapshot) {
  const existing = sessions.get(persistedSnapshot.id);
  if (!existing) {
    sessions.set(persistedSnapshot.id, recordFromSnapshot(persistedSnapshot, { recoverOrphanedTargetRun: true }));
    return;
  }
  const preserveRuntimeTurn = shouldPreserveRuntimeTurn(existing, persistedSnapshot);
  const targetRuntimePrefix = `${persistedSnapshot.id}:`;
  const hasActorLoginRuntime = Array.from(targetWorkflowRuntimeState.actorLoginControllers.keys())
    .some((key) => key.startsWith(targetRuntimePrefix));
  const fromDisk = mergeRuntimeSessionState(
    recordFromSnapshot(persistedSnapshot, {
      preserveRunningState: preserveRuntimeTurn,
      recoverOrphanedTargetRun: !preserveRuntimeTurn && !hasActorLoginRuntime,
    }),
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
    const writtenSnapshot = options.mergePersisted === false
      ? incoming
      : mergePersistedSessionSnapshot(readSessionSnapshot(sessionId), incoming);
    writeSessionSnapshot(writtenSnapshot);
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

function persistAndNotify(sessionId: string, options: { defer?: boolean; mergePersisted?: boolean } = {}) {
  if (options.defer) {
    schedulePersistAndNotify(sessionId);
    notifySessionUpdate(sessionId);
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

function createBrowserChatBrowser(session: BrowserChatSessionRecord) {
  return new BrowserSession(session.mode, {
    browserSurface: 'electron-embedded',
    browserProfileKey: browserChatBrowserProfileKey(session),
    isMarked: true,
    preferExistingPage: false,
    runId: session.id,
  });
}

async function browserForTurnDecision(session: BrowserChatSessionRecord) {
  if (session.browser && session.started && !session.browser.isUsable()) {
    appendLog(session, 'browser:stale', '历史对话的浏览器已关闭或页面已失效，正在重新接管本会话。');
    await session.browser.close({ keepOpen: true }).catch(() => undefined);
    session.browser = undefined;
    session.started = false;
    session.updatedAt = now();
    persistAndNotify(session.id);
  }
  if (!session.browser) session.browser = createBrowserChatBrowser(session);
  return session.browser;
}

async function ensureStartedNow(session: BrowserChatSessionRecord) {
  const browser = await browserForTurnDecision(session);
  if (session.started && browser.isUsable()) {
    appendLog(session, 'browser:reuse', '复用当前会话已有浏览器标签');
    return browser;
  }
  store.applyRuntimeEnv();
  const startedAt = Date.now();
  appendLog(session, 'browser:start', '正在启动或连接浏览器');
  const hasPriorConversation = session.steps.length > 0
    || session.messages.some((message) => message.role === 'assistant' && message.id !== session.activeAssistantMessageId);
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
  return snapshot(session);
}

export function getBrowserChatSession(sessionId: string, userId?: string | number) {
  const session = hydrateSession(sessionId);
  if (session && !sessionBelongsToUser(session, userId)) return undefined;
  return session ? snapshot(session) : undefined;
}

function targetActorRuntimeKey(sessionId: string, actorId: string) {
  return `${sessionId}:${actorId}`;
}

function isTargetActorBrowserBinding(
  value: TargetActorBrowserBinding | BrowserSession,
): value is TargetActorBrowserBinding {
  const candidate = value as Partial<TargetActorBrowserBinding>;
  return typeof candidate.browserSessionId === 'string'
    && typeof candidate.identityFingerprint === 'string'
    && Boolean(candidate.browser)
    && typeof candidate.browser?.close === 'function';
}

function targetActorIdentityFingerprint(actor: TargetActor) {
  return createHash('sha256')
    .update(JSON.stringify([
      actor.id,
      actor.name,
      actor.role,
      actor.auth.required,
      actor.auth.loginUrl || '',
      actor.auth.credentialDomain || '',
      actor.auth.username || '',
    ]), 'utf8')
    .digest('hex')
    .slice(0, 32);
}

function targetActorSessionId(runId: string, actor: TargetActor) {
  return `actor_${runId}_${targetActorIdentityFingerprint(actor)}`.slice(0, 180);
}

function targetActorOf(session: BrowserChatSessionRecord, actorId: string) {
  const actor = session.targetRun?.plan?.actors.find((item) => item.id === actorId);
  if (!actor) throw new Error(`目标测试参与者不存在：${actorId}`);
  return actor;
}

function updateTargetActor(session: BrowserChatSessionRecord, actorId: string, updater: (actor: TargetActor) => TargetActor) {
  if (!session.targetRun?.plan) throw new Error('目标测试计划不存在');
  if (!session.targetRun.plan.actors.some((actor) => actor.id === actorId)) {
    throw new Error(`目标测试参与者不存在：${actorId}`);
  }
  session.targetRun.plan = {
    ...session.targetRun.plan,
    actors: session.targetRun.plan.actors.map((actor) => actor.id === actorId ? updater(actor) : actor),
  };
  session.targetRun.updatedAt = now();
}

function targetActorIdentityMatches(session: BrowserChatSessionRecord, expected: TargetActor) {
  const current = session.targetRun?.plan?.actors.find((actor) => actor.id === expected.id);
  return Boolean(current
    && current.name === expected.name
    && current.role === expected.role
    && current.auth.required === expected.auth.required
    && (current.auth.loginUrl || '') === (expected.auth.loginUrl || '')
    && (current.auth.credentialDomain || '') === (expected.auth.credentialDomain || '')
    && (current.auth.username || '') === (expected.auth.username || ''));
}

function mergeLatestTargetActorAuth(plan: TargetPlan, latestPlan?: TargetPlan): TargetPlan {
  if (!latestPlan) return plan;
  return {
    ...plan,
    actors: plan.actors.map((actor) => {
      const latest = latestPlan.actors.find((item) => item.id === actor.id);
      const sameIdentity = latest
        && latest.name === actor.name
        && latest.role === actor.role
        && latest.auth.required === actor.auth.required
        && (latest.auth.loginUrl || '') === (actor.auth.loginUrl || '')
        && (latest.auth.credentialDomain || '') === (actor.auth.credentialDomain || '')
        && (latest.auth.username || '') === (actor.auth.username || '');
      return sameIdentity ? {
        ...actor,
        auth: {
          ...actor.auth,
          browserSessionId: latest.auth.browserSessionId,
          credentialId: actor.auth.credentialId || latest.auth.credentialId,
          credentialsAvailable: Boolean(actor.auth.credentialsAvailable || latest.auth.credentialsAvailable),
          message: ['ready', 'verifying', 'failed'].includes(latest.auth.status)
            ? latest.auth.message
            : actor.auth.message || latest.auth.message,
          mode: latest.auth.mode,
          status: latest.auth.status,
        },
      } : actor;
    }),
  };
}

function targetPlanPreparationStatus(plan: TargetPlan): TargetWorkflowRun['status'] {
  const unresolved = plan.requirements.some((item) => item.required && item.status === 'missing');
  if (unresolved) return 'collecting_requirements';
  const pendingAuth = plan.actors.some((actor) => actor.auth.required && actor.auth.status !== 'ready');
  return pendingAuth ? 'preparing_authentication' : 'awaiting_confirmation';
}

function pendingTargetResults(plan: TargetPlan): TargetWorkflowRun['results'] {
  return Object.fromEntries(plan.nodes
    .filter((node): node is TargetLeafNode => node.type === 'target')
    .map((target) => [target.id, {
      targetId: target.id,
      actorId: target.actorId,
      status: 'pending' as const,
      criteria: [],
      evidence: [],
      outputs: {},
    }]));
}

function applyTargetRequirementResponses(
  plan: TargetPlan,
  responses: TargetWorkflowRequirementResponse[],
) {
  const byId = new Map(responses.map((item) => [item.requirementId, item.value]));
  return {
    ...plan,
    requirements: plan.requirements.map((requirement) => {
      const response = byId.get(requirement.id);
      return response === undefined ? requirement : {
        ...requirement,
        status: 'resolved' as const,
        resolution: response,
      };
    }),
  };
}

function targetRequirementResponseMessage(
  plan: TargetPlan,
  responses: TargetWorkflowRequirementResponse[],
) {
  const requirements = new Map(plan.requirements.map((requirement) => [requirement.id, requirement]));
  return [
    '我补充以下目标测试执行资料：',
    ...responses.map((item) => {
      const requirement = requirements.get(item.requirementId);
      return `- ${requirement?.title || item.requirementId}：${item.value}`;
    }),
  ].join('\n');
}

function refreshTargetPreparationStatus(session: BrowserChatSessionRecord) {
  const run = session.targetRun;
  const plan = run?.plan;
  if (!run || !plan || ['running', 'summarizing', 'completed', 'cancelled'].includes(run.status)) return;
  run.status = targetPlanPreparationStatus(plan);
  run.updatedAt = now();
}

async function ensureTargetActorBrowser(session: BrowserChatSessionRecord, actor: TargetActor) {
  const run = session.targetRun;
  if (!run?.plan) throw new Error('目标测试计划不存在');
  const identityFingerprint = targetActorIdentityFingerprint(actor);
  const browserSessionId = actor.auth.browserSessionId || targetActorSessionId(run.id, actor);
  const key = targetActorRuntimeKey(session.id, actor.id);
  const existing = targetWorkflowRuntimeState.actorBrowsers.get(key);
  const existingBinding = existing && isTargetActorBrowserBinding(existing) ? existing : undefined;
  const existingBrowser = existingBinding?.browser || existing;
  const sameBinding = existingBinding?.browserSessionId === browserSessionId
    && existingBinding.identityFingerprint === identityFingerprint;
  if (sameBinding && existingBinding.browser.isUsable()) return existingBinding.browser;
  if (existing) {
    targetWorkflowRuntimeState.actorBrowsers.delete(key);
    await existingBrowser?.close({ keepOpen: sameBinding }).catch(() => undefined);
  }
  const browser = new BrowserSession('dom', {
    browserSurface: 'electron-embedded',
    browserProfileKey: `target_${run.id}_${identityFingerprint}`,
    isMarked: true,
    preferExistingPage: false,
    runId: browserSessionId,
  });
  await browser.start();
  if (run.plan.targetUrl && !browser.hasNonBlankActivePage()) await browser.open(run.plan.targetUrl);
  targetWorkflowRuntimeState.actorBrowsers.set(key, {
    browser,
    browserSessionId,
    identityFingerprint,
  });
  return browser;
}

function mergeTargetSteps(session: BrowserChatSessionRecord, steps: StepExecutionResult[]) {
  session.steps = mergePersistedSteps(session.steps, steps);
  if (session.activeAssistantMessageId
    && steps.length
    && session.targetRun
    && ['discovering_sources', 'researching_sources', 'synthesizing_requirements', 'running', 'summarizing'].includes(session.targetRun.status)) {
    const stepIndexes = steps.map((step) => step.index);
    updateAssistantMessage(session, session.activeAssistantMessageId, (message) => ({
      ...message,
      stepIndexes: Array.from(new Set([...(message.stepIndexes || []), ...stepIndexes])).sort((left, right) => left - right),
    }));
  }
  session.updatedAt = now();
  persistAndNotify(session.id, { mergePersisted: false });
}

function targetCredentialRef(sessionId: string, actorId: string, field: 'username' | 'password') {
  return `credential:${sessionId}:${actorId}:${field}`;
}

function resolveTargetCredential(reference: string, attemptId?: string) {
  const item = targetWorkflowRuntimeState.credentials.get(reference);
  if (!item) return undefined;
  if (attemptId && item.attemptId !== attemptId) return undefined;
  if (item.expiresAt <= Date.now()) {
    targetWorkflowRuntimeState.credentials.delete(reference);
    return undefined;
  }
  return item.value;
}

function clearTargetActorCredentials(sessionId: string, actorId: string, attemptId?: string) {
  for (const [reference, item] of targetWorkflowRuntimeState.credentials) {
    if (item.sessionId === sessionId
      && item.actorId === actorId
      && (!attemptId || item.attemptId === attemptId)) {
      targetWorkflowRuntimeState.credentials.delete(reference);
    }
  }
}

function targetActorCredentialLoginUrl(session: BrowserChatSessionRecord, actor: TargetActor) {
  const value = actor.auth.loginUrl || session.targetRun?.plan?.targetUrl || '';
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) throw new Error('unsupported protocol');
    return url.toString();
  } catch {
    throw new Error('凭据登录需要计划中提供明确的 http(s) 登录地址；请补充登录地址或改用手动登录');
  }
}

export function prepareTargetActorLogin(
  sessionId: string,
  actorId: string,
  mode: 'manual' | 'credentials' | 'existing_session',
  userId?: string | number,
) {
  const session = hydrateSession(sessionId);
  if (!session || !sessionBelongsToUser(session, userId)) throw new Error('Browser chat session not found');
  const actor = targetActorOf(session, actorId);
  if (!actor.auth.required) throw new Error('该参与者不需要登录');
  const browserSessionId = actor.auth.browserSessionId || targetActorSessionId(session.targetRun!.id, actor);
  updateTargetActor(session, actorId, (current) => ({
    ...current,
    auth: {
      ...current.auth,
      mode,
      status: 'awaiting_user',
      browserSessionId,
      credentialsAvailable: false,
      message: mode === 'manual'
        ? '请在该账号的独立浏览器中完成登录，然后点击“完成登录”。'
        : mode === 'credentials'
          ? '独立登录环境已准备好，提交凭据后将开始安全登录。'
          : undefined,
    },
  }));
  refreshTargetPreparationStatus(session);
  session.updatedAt = now();
  persistAndNotify(session.id);
  return snapshot(session);
}

async function verifyTargetActorLogin(
  session: BrowserChatSessionRecord,
  actorId: string,
  abortController: AbortController,
) {
  const actor = targetActorOf(session, actorId);
  const runtimeKey = targetActorRuntimeKey(session.id, actorId);
  const isCurrentRuntime = () => (
    sessions.get(session.id) === session
    && session.status !== 'closed'
    && targetWorkflowRuntimeState.actorLoginControllers.get(runtimeKey) === abortController
    && targetActorIdentityMatches(session, actor)
  );
  updateTargetActor(session, actorId, (current) => ({
    ...current,
    auth: { ...current.auth, status: 'verifying', message: 'AI 正在检查当前账号是否已经登录。' },
  }));
  persistAndNotify(session.id);
  try {
    const browser = await ensureTargetActorBrowser(session, actor);
    const actorIndex = session.targetRun!.plan!.actors.findIndex((item) => item.id === actorId);
    const authStepBase = 10_000_000 + Math.max(0, actorIndex) * 10_000;
    const initialStepIndex = Math.max(authStepBase, ...session.steps
      .map((step) => step.index)
      .filter((stepIndex) => stepIndex >= authStepBase && stepIndex < authStepBase + 10_000));
    const result = await executeInteractiveBrowserTurn({
      session: browser,
      runId: `${session.targetRun!.id}_auth_${actor.id}`,
      initialStepIndex,
      targetUrl: actor.auth.loginUrl || session.targetRun!.plan!.targetUrl || browser.currentUrl() || 'about:blank',
      instruction: `请只检查当前浏览器是否已经成功登录为“${actor.name}（${actor.role}）”。必须读取当前页面证据，不要修改业务数据。如果能够确认已登录，明确报告 passed；仍在登录页、身份不符或证据不足时报告 blocked。`,
      mode: 'dom',
      safetyMode: 'full',
      completedSteps: [],
      abortSignal: abortController.signal,
      shouldContinue: isCurrentRuntime,
      onProgress: (step) => {
        if (isCurrentRuntime()) mergeTargetSteps(session, [step]);
      },
    });
    if (!isCurrentRuntime()) return;
    mergeTargetSteps(session, result.newSteps);
    const ready = result.status === 'passed';
    updateTargetActor(session, actorId, (current) => ({
      ...current,
      auth: {
        ...current.auth,
        status: ready ? 'ready' : 'awaiting_user',
        credentialsAvailable: false,
        message: ready ? '登录状态已由 AI 检查通过。' : result.reply || '尚未确认登录成功，请继续完成登录。',
      },
    }));
  } catch (error) {
    if (isCurrentRuntime()) {
      updateTargetActor(session, actorId, (current) => ({
        ...current,
        auth: {
          ...current.auth,
          status: 'failed',
          credentialsAvailable: false,
          message: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  }
  if (isCurrentRuntime()) {
    refreshTargetPreparationStatus(session);
    session.updatedAt = now();
    persistAndNotify(session.id);
  }
}

export async function completeTargetActorLogin(sessionId: string, actorId: string, userId?: string | number) {
  const session = hydrateSession(sessionId);
  if (!session || !sessionBelongsToUser(session, userId)) throw new Error('Browser chat session not found');
  const runtimeKey = targetActorRuntimeKey(session.id, actorId);
  targetWorkflowRuntimeState.actorLoginControllers.get(runtimeKey)?.abort(new Error('新的登录检查已替换上一次请求'));
  const abortController = new AbortController();
  targetWorkflowRuntimeState.actorLoginControllers.set(runtimeKey, abortController);
  try {
    await verifyTargetActorLogin(session, actorId, abortController);
  } finally {
    if (targetWorkflowRuntimeState.actorLoginControllers.get(runtimeKey) === abortController) {
      targetWorkflowRuntimeState.actorLoginControllers.delete(runtimeKey);
    }
  }
  return snapshot(session);
}

async function runTargetCredentialLogin(
  session: BrowserChatSessionRecord,
  actorId: string,
  abortController: AbortController,
  attemptId: string,
) {
  const actor = targetActorOf(session, actorId);
  const runtimeKey = targetActorRuntimeKey(session.id, actorId);
  const isCurrentRuntime = () => (
    sessions.get(session.id) === session
    && session.status !== 'closed'
    && targetWorkflowRuntimeState.actorLoginControllers.get(runtimeKey) === abortController
    && targetActorIdentityMatches(session, actor)
  );
  const usernameRef = targetCredentialRef(session.id, actorId, 'username');
  const passwordRef = targetCredentialRef(session.id, actorId, 'password');
  const allowedCredentialRefs = new Set([usernameRef, passwordRef]);
  try {
    const loginUrl = targetActorCredentialLoginUrl(session, actor);
    const browser = await ensureTargetActorBrowser(session, actor);
    const loginOrigin = new URL(loginUrl).origin;
    let currentOrigin = '';
    try {
      currentOrigin = new URL(browser.currentUrl()).origin;
    } catch {
      // The browser can still be on about:blank before the first login attempt.
    }
    if (currentOrigin !== loginOrigin) await browser.open(loginUrl);
    const actorIndex = session.targetRun!.plan!.actors.findIndex((item) => item.id === actorId);
    const authStepBase = 20_000_000 + Math.max(0, actorIndex) * 10_000;
    const initialStepIndex = Math.max(authStepBase, ...session.steps
      .map((step) => step.index)
      .filter((stepIndex) => stepIndex >= authStepBase && stepIndex < authStepBase + 10_000));
    const result = await executeInteractiveBrowserTurn({
      session: browser,
      runId: `${session.targetRun!.id}_credential_auth_${actor.id}`,
      initialStepIndex,
      targetUrl: loginUrl,
      instruction: [
        `请登录为“${actor.name}（${actor.role}）”。`,
        `用户名只能通过 keyboard.credentialRef="${usernameRef}" 输入。`,
        `密码只能通过 keyboard.credentialRef="${passwordRef}" 输入。`,
        '绝对不要要求、复述或猜测凭据明文。遇到验证码、OTP、扫码或二次认证时调用 waitForHumanVerification。登录成功后检查页面并报告 passed。',
      ].join('\n'),
      mode: 'dom',
      safetyMode: 'full',
      completedSteps: [],
      resolveCredential: (reference) => allowedCredentialRefs.has(reference) ? resolveTargetCredential(reference, attemptId) : undefined,
      credentialAllowedOrigins: [loginOrigin],
      allowedToolTypes: [
        'page',
        'mouse',
        'keyboard',
        'selectOption',
        'waitForHumanVerification',
        'tab',
        'takeSnapshot',
        'searchSnapshot',
        'reportState',
      ],
      abortSignal: abortController.signal,
      shouldContinue: isCurrentRuntime,
      onProgress: (step) => {
        if (isCurrentRuntime()) mergeTargetSteps(session, [step]);
      },
    });
    if (!isCurrentRuntime()) return;
    mergeTargetSteps(session, result.newSteps);
    const ready = result.status === 'passed';
    updateTargetActor(session, actorId, (current) => ({
      ...current,
      auth: {
        ...current.auth,
        status: ready ? 'ready' : 'awaiting_user',
        credentialsAvailable: false,
        message: ready ? '账号凭据登录完成，AI 已检查登录状态。' : result.reply || '需要你在独立浏览器中继续完成人工验证。',
      },
    }));
  } catch (error) {
    if (isCurrentRuntime()) {
      updateTargetActor(session, actorId, (current) => ({
        ...current,
        auth: {
          ...current.auth,
          status: 'failed',
          credentialsAvailable: false,
          message: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  } finally {
    clearTargetActorCredentials(session.id, actorId, attemptId);
    if (targetWorkflowRuntimeState.actorLoginControllers.get(runtimeKey) === abortController) {
      targetWorkflowRuntimeState.actorLoginControllers.delete(runtimeKey);
    }
    if (sessions.get(session.id) === session && session.status !== 'closed') {
      refreshTargetPreparationStatus(session);
      session.updatedAt = now();
      persistAndNotify(session.id);
    }
  }
}

function startTargetActorCredentialLogin(
  session: BrowserChatSessionRecord,
  actorId: string,
  credentials: { username: string; password: string },
  parentAbortSignal?: AbortSignal,
) {
  if (!credentials.username.trim() || !credentials.password) throw new Error('账号和密码不能为空');
  const actor = targetActorOf(session, actorId);
  if (!actor.auth.required) throw new Error('该参与者不需要登录');
  const browserSessionId = actor.auth.browserSessionId || targetActorSessionId(session.targetRun!.id, actor);
  updateTargetActor(session, actorId, (current) => ({
    ...current,
    auth: {
      ...current.auth,
      mode: 'credentials',
      status: 'awaiting_user',
      browserSessionId,
      credentialsAvailable: false,
      message: '独立登录环境已准备好，正在通过安全引用使用后台账号。',
    },
  }));
  const runtimeKey = targetActorRuntimeKey(session.id, actorId);
  targetWorkflowRuntimeState.actorLoginControllers.get(runtimeKey)?.abort(new Error('新的登录请求已替换上一次请求'));
  const abortController = new AbortController();
  targetWorkflowRuntimeState.actorLoginControllers.set(runtimeKey, abortController);
  const forwardParentAbort = () => abortController.abort(parentAbortSignal?.reason);
  if (parentAbortSignal?.aborted) forwardParentAbort();
  else parentAbortSignal?.addEventListener('abort', forwardParentAbort, { once: true });
  const expiresAt = Date.now() + 15 * 60 * 1000;
  const attemptId = id('credential_attempt');
  targetWorkflowRuntimeState.credentials.set(targetCredentialRef(session.id, actorId, 'username'), {
    actorId,
    attemptId,
    expiresAt,
    sessionId: session.id,
    value: credentials.username,
  });
  targetWorkflowRuntimeState.credentials.set(targetCredentialRef(session.id, actorId, 'password'), {
    actorId,
    attemptId,
    expiresAt,
    sessionId: session.id,
    value: credentials.password,
  });
  updateTargetActor(session, actorId, (current) => ({
    ...current,
    auth: { ...current.auth, credentialsAvailable: true, status: 'verifying', message: '密码已从本机加密凭据库读取，AI 正在通过短期安全引用登录。' },
  }));
  persistAndNotify(session.id);
  return withModelSettings(
    browserChatModelSettings(session.modelProvider, session.model),
    () => runTargetCredentialLogin(session, actorId, abortController, attemptId),
  ).finally(() => parentAbortSignal?.removeEventListener('abort', forwardParentAbort));
}

export function provideTargetActorCredentials(
  sessionId: string,
  actorId: string,
  credentials: { username: string; password: string },
  userId?: string | number,
) {
  const session = hydrateSession(sessionId);
  if (!session || !sessionBelongsToUser(session, userId)) throw new Error('Browser chat session not found');
  void startTargetActorCredentialLogin(session, actorId, credentials);
  return snapshot(session);
}

async function runConfirmedTargetWorkflow(session: BrowserChatSessionRecord, assistantMessageId: string, abortController: AbortController) {
  const run = session.targetRun;
  if (!run?.plan) return;
  const ownsTurn = () => isActiveBrowserChatTurn(session, assistantMessageId, abortController);
  const anonymousBrowsers = new Map<string, BrowserSession>();
  const transientActorBrowsers = new Map<string, BrowserSession>();
  try {
    await executeTargetWorkflow(run, {
      safetyMode: normalizeSafetyMode(session.safetyMode),
      abortSignal: abortController.signal,
      shouldContinue: () => isActiveBrowserChatTurn(session, assistantMessageId, abortController),
      requestToolConfirmation: session.safetyMode === 'strict'
        ? (request) => requestBrowserChatToolConfirmation(session, assistantMessageId, request, abortController.signal)
        : undefined,
      getBrowser: async ({ actor, laneId }) => {
        if (!ownsTurn()) throw abortController.signal.reason || new Error('目标测试执行已失效。');
        if (actor?.auth.required) return ensureTargetActorBrowser(session, actor);
        const key = actor ? targetActorRuntimeKey(session.id, actor.id) : `anonymous:${session.id}:${laneId}`;
        const existing = actor
          ? transientActorBrowsers.get(key)
          : anonymousBrowsers.get(key);
        if (existing?.isUsable()) return existing;
        const browser = new BrowserSession('dom', {
          isolated: true,
          isMarked: true,
          runId: `${run.id}_${actor?.id || laneId}`,
        });
        await browser.start();
        if (run.plan?.targetUrl) await browser.open(run.plan.targetUrl);
        if (actor) {
          transientActorBrowsers.set(key, browser);
        }
        else anonymousBrowsers.set(key, browser);
        return browser;
      },
      onSteps: (steps) => {
        if (ownsTurn()) mergeTargetSteps(session, steps);
      },
      onRunChange: (nextRun) => {
        if (!ownsTurn()) return;
        session.targetRun = mergeTargetWorkflowRun(session.targetRun, nextRun);
        session.updatedAt = now();
        persistAndNotify(session.id, { mergePersisted: false });
      },
      onDebug: (event) => {
        if (!ownsTurn()) return;
        appendLog(session, event.phase, event.message, {
          stepIndex: event.stepIndex,
          details: event.details,
          deferPersist: true,
        });
      },
    });
    if (!ownsTurn()) return;
    const results = Object.values(session.targetRun?.results || {});
    const failed = results.some((result) => result.status === 'failed');
    const blocked = results.some((result) => result.status === 'blocked' || result.status === 'inconclusive');
    updateAssistantMessage(session, assistantMessageId, (message) => ({
      ...message,
      content: session.targetRun?.summary || '目标测试已经完成。',
      status: failed ? 'failed' : blocked ? 'blocked' : 'passed',
      activity: undefined,
      updatedAt: now(),
    }));
  } catch (error) {
    if (!ownsTurn()) return;
    updateAssistantMessage(session, assistantMessageId, (message) => ({
      ...message,
      content: session.targetRun?.status === 'cancelled' ? '目标测试已中断。' : `目标测试执行异常：${error instanceof Error ? error.message : String(error)}`,
      status: session.targetRun?.status === 'cancelled' ? 'interrupted' : 'failed',
      activity: undefined,
      updatedAt: now(),
    }));
  } finally {
    for (const browser of anonymousBrowsers.values()) await browser.close().catch(() => undefined);
    for (const browser of transientActorBrowsers.values()) await browser.close().catch(() => undefined);
    if (session.activeAssistantMessageId !== assistantMessageId || session.activeAbortController !== abortController) return;
    session.activeAssistantMessageId = undefined;
    session.activeAbortController = undefined;
    session.busy = false;
    session.status = 'idle';
    session.updatedAt = now();
    persistAndNotify(session.id);
  }
}

function replaceTargetRunPlan(
  session: BrowserChatSessionRecord,
  assistantMessageId: string,
  plan: TargetPlan,
) {
  const previousRun = session.targetRun;
  const timestamp = now();
  session.targetRun = {
    id: previousRun?.id || id('target'),
    ownerMessageId: assistantMessageId,
    status: targetPlanPreparationStatus(plan),
    research: previousRun?.research,
    plan,
    results: pendingTargetResults(plan),
    createdAt: previousRun?.createdAt || timestamp,
    updatedAt: timestamp,
  };
  session.updatedAt = timestamp;
}

async function runTargetWorkflowContinuation(
  session: BrowserChatSessionRecord,
  assistantMessageId: string,
  abortController: AbortController,
  actorCredentialIds: TargetWorkflowActorCredentialReference[],
) {
  const ownsTurn = () => isActiveBrowserChatTurn(session, assistantMessageId, abortController);
  try {
    appendLog(session, 'target:continue:plan:start', 'AI 正在重新核对执行资料；此阶段不会操作业务页面', {
      messageId: assistantMessageId,
    });
    await researchSessionTargetRequirement({
      session,
      assistantMessageId,
      abortController,
    });
    if (!ownsTurn()) return;
    appendLog(session, 'target:continue:plan:start', 'AI 正在根据最新调研证据重新核对执行资料', {
      messageId: assistantMessageId,
    });
    let plan = await generateSessionTargetPlan({
      session,
      assistantMessageId,
      abortController,
      phase: 'continue_before_auth',
    });
    if (!ownsTurn()) return;
    replaceTargetRunPlan(session, assistantMessageId, plan);
    persistAndNotify(session.id);

    if (actorCredentialIds.length) {
      appendLog(session, 'target:continue:auth:start', `正在安全准备 ${actorCredentialIds.length} 个独立账号会话`, {
        messageId: assistantMessageId,
      });
      const loginTasks = actorCredentialIds.map(async (reference) => {
        if (!ownsTurn()) return;
        const actor = session.targetRun?.plan?.actors.find((item) => item.id === reference.actorId);
        if (!actor?.auth.required) {
          appendLog(session, 'target:continue:auth:skipped', `参与者 ${reference.actorId} 在新版资料分析中不存在或不需要登录，未使用其凭据`, {
            messageId: assistantMessageId,
          });
          return;
        }
        const account = getLoginAccountById(reference.credentialId, session.userId);
        if (!account || account.status !== 'active') throw new Error(`参与者 ${actor.name} 对应的后台账号不存在或已停用`);
        const plannedDomainValue = actor.auth.credentialDomain || actor.auth.loginUrl || plan.targetUrl;
        const plannedDomain = plannedDomainValue ? normalizeLoginAccountDomain(plannedDomainValue) : account.domain;
        if (plannedDomain !== account.domain) throw new Error(`参与者 ${actor.name} 的计划域名与后台账号域名不一致`);
        const credential = resolveLoginAccountCredentialById(reference.credentialId, session.userId);
        if (!credential) throw new Error(`参与者 ${actor.name} 的后台账号无法解密或已停用`);
        updateTargetActor(session, actor.id, (current) => ({
          ...current,
          auth: {
            ...current.auth,
            credentialDomain: account.domain,
            credentialId: account.id,
            credentialsAvailable: true,
            loginUrl: account.loginUrl,
            username: account.username,
          },
        }));
        appendLog(session, 'target:continue:auth:actor', `正在登录独立账号会话：${actor.name}（${actor.role}）`, {
          messageId: assistantMessageId,
        });
        await startTargetActorCredentialLogin(
          session,
          actor.id,
          { username: account.username, password: credential.password },
          abortController.signal,
        );
      });
      // Actor browsers, credential references and step-index ranges are all
      // isolated, so independent account preparation can run concurrently.
      // allSettled ensures one failed login never prevents the remaining actors
      // from being checked; the final planning pass turns failures back into
      // actor-bound missing account requirements.
      await Promise.allSettled(loginTasks);
      if (!ownsTurn()) return;
      appendLog(session, 'target:continue:plan:recheck', '账号登录处理结束，AI 正在无条件重新核对全部资料并生成最终计划', {
        messageId: assistantMessageId,
      });
      plan = await generateSessionTargetPlan({
        session,
        assistantMessageId,
        abortController,
        phase: 'continue_after_auth',
      });
      if (!ownsTurn()) return;
      replaceTargetRunPlan(session, assistantMessageId, plan);
      persistAndNotify(session.id);
    }

    if (!targetPlanIsReady(plan)) {
      const timestamp = now();
      updateAssistantMessage(session, assistantMessageId, (message) => ({
        ...message,
        content: targetWorkflowPlanningReply(plan),
        status: 'passed',
        activity: undefined,
        updatedAt: timestamp,
      }));
      session.activeAssistantMessageId = undefined;
      session.activeAbortController = undefined;
      session.busy = false;
      session.status = 'idle';
      session.error = undefined;
      session.updatedAt = timestamp;
      appendLog(session, 'target:continue:collecting', '资料复核完成，仍有内容需要补充；未启动目标执行', {
        messageId: assistantMessageId,
      });
      persistAndNotify(session.id);
      return;
    }

    const structuralErrors = validateTargetPlanStructure(plan);
    if (structuralErrors.length) throw new Error(`目标测试计划结构无效：${structuralErrors.join('；')}`);
    const timestamp = now();
    session.targetRun = {
      ...session.targetRun!,
      ownerMessageId: assistantMessageId,
      status: 'ready',
      confirmedAt: timestamp,
      startedAt: undefined,
      endedAt: undefined,
      summary: undefined,
      error: undefined,
      results: pendingTargetResults(plan),
      updatedAt: timestamp,
    };
    updateAssistantMessage(session, assistantMessageId, (message) => ({
      ...message,
      content: '所需资料与账号会话已经复核齐全，正在按最终串并联流程树执行目标测试。',
      status: 'running',
      activity: { phase: 'target:execute', label: '正在执行目标测试', updatedAt: timestamp },
      updatedAt: timestamp,
    }));
    session.updatedAt = timestamp;
    appendLog(session, 'target:continue:execute', `目标计划第 ${plan.version} 版已确认，开始执行`, {
      messageId: assistantMessageId,
    });
    persistAndNotify(session.id);
    await runConfirmedTargetWorkflow(session, assistantMessageId, abortController);
  } catch (error) {
    if (!ownsTurn()) return;
    const timestamp = now();
    const message = userFacingErrorMessage(error);
    if (session.targetRun) {
      session.targetRun.status = 'failed';
      session.targetRun.error = message;
      session.targetRun.updatedAt = timestamp;
    }
    updateAssistantMessage(session, assistantMessageId, (item) => ({
      ...item,
      content: `目标资料复核失败：${message}`,
      status: 'failed',
      activity: undefined,
      updatedAt: timestamp,
    }));
    session.activeAssistantMessageId = undefined;
    session.activeAbortController = undefined;
    session.busy = false;
    session.status = 'error';
    session.error = message;
    session.updatedAt = timestamp;
    appendLog(session, 'target:continue:error', `目标资料复核失败：${message}`, {
      details: errorLogDetails(error),
      messageId: assistantMessageId,
    });
    persistAndNotify(session.id);
  }
}

export function continueTargetWorkflow(
  sessionId: string,
  input: ContinueTargetWorkflowInput = {},
  userId?: string | number,
) {
  const session = hydrateSession(sessionId);
  if (!session || !sessionBelongsToUser(session, userId)) throw new Error('Browser chat session not found');
  if (session.busy || [...targetPlanningActiveStatuses, 'ready', 'running', 'summarizing'].includes(session.targetRun?.status || '')) {
    throw new Error('目标资料正在复核或目标测试已经在执行');
  }
  const currentPlan = session.targetRun?.plan;
  if (!currentPlan) throw new Error('目标测试计划不存在');

  const responseById = new Map<string, TargetWorkflowRequirementResponse>();
  for (const raw of input.responses || []) {
    const requirementId = raw.requirementId.trim();
    const value = raw.value.trim();
    if (!requirementId || !value) throw new Error('补充资料不能为空');
    const requirement = currentPlan.requirements.find((item) => item.id === requirementId);
    if (!requirement) throw new Error(`待补充资料不存在或已经更新：${requirementId}`);
    if (requirement.category === 'account') throw new Error(`账号资料必须通过“${requirement.title}”关联后台保存的登录账号`);
    responseById.set(requirementId, { requirementId, value: value.slice(0, 2_000) });
  }
  const responses = Array.from(responseById.values());

  const credentialsByActor = new Map<string, TargetWorkflowActorCredentialReference>();
  for (const raw of input.actorCredentialIds || []) {
    const actorId = raw.actorId.trim();
    const actor = currentPlan.actors.find((item) => item.id === actorId);
    if (!actor?.auth.required) throw new Error(`需要登录的参与者不存在或已经更新：${actorId}`);
    const credentialId = raw.credentialId.trim();
    const account = getLoginAccountById(credentialId, session.userId);
    if (!account || account.status !== 'active') throw new Error(`参与者 ${actor.name} 对应的后台账号不存在或已停用`);
    const plannedDomainValue = actor.auth.credentialDomain || actor.auth.loginUrl || currentPlan.targetUrl;
    if (plannedDomainValue && normalizeLoginAccountDomain(plannedDomainValue) !== account.domain) {
      throw new Error(`参与者 ${actor.name} 只能选择 ${normalizeLoginAccountDomain(plannedDomainValue)} 域名下的账号`);
    }
    credentialsByActor.set(actorId, { actorId, credentialId });
  }
  const actorCredentialIds = Array.from(credentialsByActor.values());
  if (!responses.length && !actorCredentialIds.length && session.targetRun?.status === 'collecting_requirements') {
    throw new Error('请先补充当前缺失的资料或关联后台登录账号');
  }

  const timestamp = now();
  let plan = currentPlan;
  if (responses.length) {
    const userMessage: BrowserChatMessage = {
      id: id('msg'),
      role: 'user',
      content: targetRequirementResponseMessage(plan, responses),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    session.messages.push(userMessage);
    plan = applyTargetRequirementResponses(plan, responses);
  }
  const assistantMessage: BrowserChatMessage = {
    id: id('msg'),
    role: 'assistant',
    content: '正在重新核对执行资料与账号状态。',
    createdAt: timestamp,
    updatedAt: timestamp,
    status: 'running',
    stepIndexes: [],
    activity: { phase: 'target:continue', label: '正在复核目标资料', updatedAt: timestamp },
  };
  session.messages.push(assistantMessage);
  session.targetRun = {
    ...session.targetRun!,
    ownerMessageId: assistantMessage.id,
    status: 'discovering_sources',
    plan,
    results: {},
    summary: undefined,
    error: undefined,
    confirmedAt: undefined,
    startedAt: undefined,
    endedAt: undefined,
    updatedAt: timestamp,
  };
  const abortController = new AbortController();
  session.activeAssistantMessageId = assistantMessage.id;
  session.activeAbortController = abortController;
  session.busy = true;
  session.status = 'running';
  session.error = undefined;
  session.updatedAt = timestamp;
  appendLog(session, 'target:continue:queued', `已收到目标继续请求：普通资料 ${responses.length} 项，后台账号 ${actorCredentialIds.length} 个`, {
    messageId: assistantMessage.id,
  });
  persistAndNotify(session.id);
  void withModelSettings(
    browserChatModelSettings(session.modelProvider, session.model),
    () => runTargetWorkflowContinuation(session, assistantMessage.id, abortController, actorCredentialIds),
  );
  return snapshot(session);
}

export function startTargetWorkflowExecution(sessionId: string, userId?: string | number) {
  const session = hydrateSession(sessionId);
  if (!session || !sessionBelongsToUser(session, userId)) throw new Error('Browser chat session not found');
  const run = session.targetRun;
  if (!run?.plan) throw new Error('目标测试计划不存在');
  if (session.busy || ['running', 'summarizing'].includes(run.status)) throw new Error('目标测试已经在执行');
  if (run.status !== 'awaiting_confirmation') throw new Error('当前目标计划不在可确认执行状态，请先在对话中完成或更新计划');
  const structuralErrors = validateTargetPlanStructure(run.plan);
  if (structuralErrors.length) throw new Error(`目标测试计划结构无效：${structuralErrors.join('；')}`);
  if (!targetPlanIsReady(run.plan)) throw new Error('仍有必填信息或账号登录尚未准备完成');
  const timestamp = now();
  const assistantMessage: BrowserChatMessage = {
    id: id('msg'),
    role: 'assistant',
    content: '计划已经确认，正在按串并联流程树执行目标测试。',
    createdAt: timestamp,
    updatedAt: timestamp,
    status: 'running',
    stepIndexes: [],
  };
  session.messages.push(assistantMessage);
  session.targetRun = {
    ...run,
    ownerMessageId: assistantMessage.id,
    status: 'ready',
    confirmedAt: timestamp,
    summary: undefined,
    error: undefined,
    endedAt: undefined,
    results: Object.fromEntries(run.plan.nodes
      .filter((node): node is TargetLeafNode => node.type === 'target')
      .map((target) => [target.id, {
        targetId: target.id,
        actorId: target.actorId,
        status: 'pending' as const,
        criteria: [],
        evidence: [],
        outputs: {},
      }])),
    updatedAt: timestamp,
  };
  const abortController = new AbortController();
  session.activeAssistantMessageId = assistantMessage.id;
  session.activeAbortController = abortController;
  session.busy = true;
  session.status = 'running';
  session.updatedAt = timestamp;
  persistAndNotify(session.id);
  void withModelSettings(browserChatModelSettings(session.modelProvider, session.model), () => runConfirmedTargetWorkflow(session, assistantMessage.id, abortController));
  return snapshot(session);
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

async function closeBlockedBrowserChatSubagents(sessionId: string, assistantMessageId?: string) {
  const matches = [...blockedSubagents.entries()].filter(([, binding]) => (
    binding.sessionId === sessionId
    && (!assistantMessageId || binding.assistantMessageId === assistantMessageId)
  ));
  for (const [id] of matches) blockedSubagents.delete(id);
  await Promise.all(matches.map(([, binding]) => binding.browser.close().catch(() => undefined)));
}

async function closeTargetWorkflowBrowsers(sessionId: string, targetRun?: TargetWorkflowRun) {
  const prefix = `${sessionId}:`;
  const closedBrowserSessionIds = new Set<string>();
  for (const [key, controller] of targetWorkflowRuntimeState.actorLoginControllers) {
    if (!key.startsWith(prefix)) continue;
    targetWorkflowRuntimeState.actorLoginControllers.delete(key);
    if (!controller.signal.aborted) controller.abort(new Error('目标账号登录已随会话关闭而中断'));
  }
  for (const [key, actorBrowser] of targetWorkflowRuntimeState.actorBrowsers) {
    if (!key.startsWith(prefix)) continue;
    targetWorkflowRuntimeState.actorBrowsers.delete(key);
    const binding = isTargetActorBrowserBinding(actorBrowser) ? actorBrowser : undefined;
    const browser = binding?.browser || actorBrowser;
    try {
      await browser.close();
      if (binding) closedBrowserSessionIds.add(binding.browserSessionId);
    } catch {
      // Reconnect below when Electron still owns the actor tab.
    }
  }
  if (electronEmbeddedBrowserEnabled()) {
    const orphanedActorSessions = Array.from(new Set((targetRun?.plan?.actors || [])
      .map((actor) => actor.auth.browserSessionId)
      .filter((browserSessionId): browserSessionId is string => (
        typeof browserSessionId === 'string'
        && Boolean(browserSessionId)
        && !closedBrowserSessionIds.has(browserSessionId)
      ))));
    await Promise.all(orphanedActorSessions.map(async (browserSessionId) => {
      const browser = new BrowserSession('dom', {
        browserSurface: 'electron-embedded',
        isMarked: true,
        preferExistingPage: true,
        runId: browserSessionId,
      });
      try {
        await browser.start();
        await browser.close();
      } catch {
        await browser.close().catch(() => undefined);
      }
    }));
  }
  for (const [reference, credential] of targetWorkflowRuntimeState.credentials) {
    if (credential.sessionId === sessionId) targetWorkflowRuntimeState.credentials.delete(reference);
  }
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
  await closeBlockedBrowserChatSubagents(sessionId);
  await closeTargetWorkflowBrowsers(sessionId, session.targetRun);
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
    throw new Error('Browser chat session was removed from memory, but the database could not be updated.');
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
  await closeBlockedBrowserChatSubagents(sessionId);
  await closeTargetWorkflowBrowsers(sessionId, session.targetRun);
  session.browser = undefined;
  session.started = false;
  session.activeAbortController = undefined;
  session.activeAssistantMessageId = undefined;
  session.pendingToolConfirmation = undefined;
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
  const abortController = session.activeAbortController;
  markAssistantMessageInterrupted(assistantMessageId);
  if (abortController && !abortController.signal.aborted) {
    abortController.abort(new Error('Browser chat operation interrupted by user.'));
  }
  void closeBlockedBrowserChatSubagents(session.id, assistantMessageId);
  session.targetRun = cancelActiveTargetWorkflowRun(session.targetRun, '用户主动中断了目标测试。', timestamp);
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

function targetPlanningMessages(
  session: BrowserChatSessionRecord,
  assistantMessageId: string,
  latest?: { userMessageId: string; modelText: string },
) {
  return session.messages
    .filter((message) => message.id !== assistantMessageId && message.content.trim())
    .map((message) => ({
      role: message.role,
      content: latest && message.id === latest.userMessageId
        ? latest.modelText
        : messageContentForPrompt(message),
    }));
}

async function researchSessionTargetRequirement(input: {
  session: BrowserChatSessionRecord;
  assistantMessageId: string;
  abortController: AbortController;
  latestModelText?: string;
}) {
  const { session, assistantMessageId, abortController } = input;
  const ownsTurn = () => isActiveBrowserChatTurn(session, assistantMessageId, abortController);
  if (!session.targetRun) throw new Error('目标调研运行不存在');
  session.targetRun.status = 'discovering_sources';
  session.targetRun.updatedAt = now();
  updateAssistantMessage(session, assistantMessageId, (message) => ({
    ...message,
    status: 'running',
    activity: { phase: 'target:research:discover', label: '正在发现需求地址、Axure 与关联资料', updatedAt: now() },
  }));
  appendLog(session, 'target:research:discover', '正在从对话、标签页和附件中发现需求资料入口', {
    messageId: assistantMessageId,
  });
  persistAndNotify(session.id);

  const browser = await ensureStarted(session);
  if (!ownsTurn()) throw abortController.signal.reason || new Error('目标调研已中断');
  const seeds = targetResearchSeeds(session, input.latestModelText);
  session.targetRun.status = 'researching_sources';
  session.targetRun.updatedAt = now();
  updateAssistantMessage(session, assistantMessageId, (message) => ({
    ...message,
    activity: { phase: 'target:research', label: '正在读取需求页面、Axure、图片和关联文档', updatedAt: now() },
  }));
  appendLog(session, 'target:research:start', `需求调研 Agent 已启动，发现 ${seeds.length} 个资料入口；使用完整浏览器工具集`, {
    details: { seeds },
    messageId: assistantMessageId,
  });
  persistAndNotify(session.id);

  const latestResearchStepIndex = Math.max(
    targetResearchStepBase,
    ...session.steps
      .filter((step) => step.index > targetResearchStepBase && step.index < targetResearchStepLimit)
      .map((step) => step.index),
  );
  if (latestResearchStepIndex >= targetResearchStepLimit - 1) throw new Error('当前目标会话的需求调研步骤已达到上限，请新建目标会话后继续');

  const result = await researchTargetRequirement({
    session: browser,
    runId: session.targetRun.id,
    initialStepIndex: latestResearchStepIndex,
    targetUrl: seeds.find((seed) => seed.url)?.url || session.targetUrl || browser.currentUrl() || 'about:blank',
    instruction: input.latestModelText || targetPlanningMessages(session, assistantMessageId).filter((message) => message.role === 'user').at(-1)?.content || '请调研当前需求资料。',
    conversation: targetPlanningMessages(session, assistantMessageId),
    seeds,
    previous: session.targetRun.research,
    mode: session.mode,
    safetyMode: session.safetyMode,
    referenceImagePaths: targetResearchImagePaths(session),
    ...targetResearchCredentialContext(session, seeds, input.latestModelText || ''),
    delegateDiscoveredSources: true,
    abortSignal: abortController.signal,
    shouldContinue: ownsTurn,
    requestToolConfirmation: session.safetyMode === 'strict'
      ? (request) => requestBrowserChatToolConfirmation(session, assistantMessageId, request, abortController.signal)
      : undefined,
    onProgress: (step) => {
      if (!ownsTurn()) return;
      mergeTargetSteps(session, [step]);
      updateAssistantMessage(session, assistantMessageId, (message) => ({
        ...message,
        status: 'running',
        activity: { phase: 'target:research', label: step.action || '正在深入读取需求资料', updatedAt: now() },
      }));
    },
    onDebug: (event) => {
      if (!ownsTurn()) return;
      appendLog(session, event.phase, event.message, {
        stepIndex: event.stepIndex,
        elapsedMs: elapsedFromDetails(event.details),
        details: event.details,
        messageId: assistantMessageId,
        deferPersist: true,
      });
    },
  });
  if (!ownsTurn()) throw abortController.signal.reason || new Error('目标调研已中断');
  mergeTargetSteps(session, result.execution.newSteps);
  session.consoleErrors = mergeStringLists(session.consoleErrors, result.execution.consoleErrors);
  session.networkErrors = mergeStringLists(session.networkErrors, result.execution.networkErrors);
  let research = result.bundle;
  for (let wave = 0; wave < 3; wave += 1) {
    const delegatedSeeds = targetResearchDelegationSeeds(research, targetResearchSubagentConcurrency());
    if (!delegatedSeeds.length) break;
    const children = await runDelegatedTargetResearch({
        session,
        assistantMessageId,
        abortController,
        instruction: input.latestModelText || '请调研当前需求资料。',
        conversation: targetPlanningMessages(session, assistantMessageId),
        seeds: delegatedSeeds,
        initialStepIndex: latestResearchStepIndex + (wave * 30_000),
        wave: wave + 1,
      });
    research = mergeTargetResearchBundles(research, children);
  }
  if (!ownsTurn()) throw abortController.signal.reason || new Error('目标调研已中断');
  session.targetRun.research = research;
  session.targetRun.status = research.status === 'blocked' ? 'awaiting_research_access' : 'synthesizing_requirements';
  session.targetRun.updatedAt = now();
  appendLog(
    session,
    research.status === 'blocked' ? 'target:research:blocked' : 'target:research:done',
    research.status === 'blocked'
      ? `需求调研存在访问阻塞，已记录 ${research.unresolved.length} 个未解决问题`
      : `需求调研完成：读取 ${research.sources.filter((source) => source.status === 'inspected').length} 个来源，提取 ${research.facts.length} 条事实`,
    { details: { research }, messageId: assistantMessageId },
  );
  updateAssistantMessage(session, assistantMessageId, (message) => ({
    ...message,
    activity: { phase: 'target:synthesize', label: '正在基于调研证据综合需求并生成计划', updatedAt: now() },
  }));
  persistAndNotify(session.id);
  return research;
}

function targetResearchSubagentConcurrency() {
  const configured = Number(process.env.AI_TARGET_RESEARCH_MAX_SUBAGENTS || 3);
  return Math.min(Math.max(Number.isFinite(configured) ? Math.floor(configured) : 3, 1), 6);
}

async function runDelegatedTargetResearch(input: {
  session: BrowserChatSessionRecord;
  assistantMessageId: string;
  abortController: AbortController;
  instruction: string;
  conversation: InteractiveBrowserTurnMessage[];
  seeds: TargetResearchSeed[];
  initialStepIndex: number;
  wave: number;
}) {
  const { session, assistantMessageId, abortController } = input;
  const ownsTurn = () => isActiveBrowserChatTurn(session, assistantMessageId, abortController);
  appendLog(session, 'target:research:delegate', `第 ${input.wave} 批正在并行委派 ${input.seeds.length} 个只读需求调研子 Agent；单个分支失败不会中止其他分支`, {
    details: { seeds: input.seeds, wave: input.wave },
    messageId: assistantMessageId,
  });
  updateAssistantMessage(session, assistantMessageId, (message) => ({
    ...message,
    activity: { phase: 'target:research:delegate', label: `第 ${input.wave} 批正在并行读取 ${input.seeds.length} 个关联资料`, updatedAt: now() },
  }));
  persistAndNotify(session.id);

  const settled = await Promise.allSettled(input.seeds.map(async (seed, index) => {
    if (!ownsTurn()) throw abortController.signal.reason || new Error('目标调研已中断');
    const child = new BrowserSession(session.mode, {
      browserSurface: 'electron-embedded',
      browserProfileKey: `${browserChatBrowserProfileKey(session)}_research_${input.wave}_${index + 1}`,
      isMarked: true,
      preferExistingPage: false,
      runId: `${session.targetRun?.id || session.id}_research_wave_${input.wave}_child_${index + 1}`,
    });
    const childStepBase = input.initialStepIndex + ((index + 1) * 10_000);
    try {
      await child.start();
      if (seed.url) await child.open(seed.url);
      const result = await researchTargetRequirement({
        session: child,
        runId: `${session.targetRun?.id || session.id}_wave_${input.wave}_child_${index + 1}`,
        initialStepIndex: childStepBase,
        targetUrl: seed.url || child.currentUrl() || 'about:blank',
        instruction: `这是并行调研分支 ${index + 1}。只深入读取这个来源并提取可追溯证据：${input.instruction}`,
        conversation: input.conversation,
        seeds: [seed],
        mode: session.mode,
        safetyMode: 'strict',
        referenceImagePaths: targetResearchImagePaths(session),
        ...targetResearchCredentialContext(session, [seed], input.instruction),
        delegateDiscoveredSources: false,
        abortSignal: abortController.signal,
        shouldContinue: ownsTurn,
        requestToolConfirmation: (request) => requestBrowserChatToolConfirmation(session, assistantMessageId, request, abortController.signal),
        onProgress: (step) => {
          if (!ownsTurn()) return;
          mergeTargetSteps(session, [step]);
          updateAssistantMessage(session, assistantMessageId, (message) => ({
            ...message,
            status: 'running',
            activity: { phase: 'target:research:child', label: `子 Agent ${index + 1}：${step.action || seed.title}`, updatedAt: now() },
          }));
        },
        onDebug: (event) => {
          if (!ownsTurn()) return;
          appendLog(session, `target:research:child:${index + 1}:${event.phase}`, event.message, {
            stepIndex: event.stepIndex,
            elapsedMs: elapsedFromDetails(event.details),
            details: event.details,
            messageId: assistantMessageId,
            deferPersist: true,
          });
        },
      });
      if (!ownsTurn()) throw abortController.signal.reason || new Error('目标调研已中断');
      mergeTargetSteps(session, result.execution.newSteps);
      session.consoleErrors = mergeStringLists(session.consoleErrors, result.execution.consoleErrors);
      session.networkErrors = mergeStringLists(session.networkErrors, result.execution.networkErrors);
      appendLog(session, 'target:research:child:done', `调研子 Agent ${index + 1} 已完成：${seed.title}`, {
        details: { seed, status: result.bundle.status },
        messageId: assistantMessageId,
      });
      return { bundle: result.bundle };
    } finally {
      await child.close().catch(() => undefined);
    }
  }));

  if (!ownsTurn()) throw abortController.signal.reason || new Error('目标调研已中断');
  return settled.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    const error = userFacingErrorMessage(result.reason);
    appendLog(session, 'target:research:child:failed', `调研子 Agent ${index + 1} 失败，其他分支继续：${error}`, {
      details: errorLogDetails(result.reason),
      messageId: assistantMessageId,
    });
    return { error };
  });
}

async function generateSessionTargetPlan(input: {
  session: BrowserChatSessionRecord;
  assistantMessageId: string;
  abortController: AbortController;
  phase: 'message' | 'continue_before_auth' | 'continue_after_auth';
  latest?: { userMessageId: string; modelText: string };
}) {
  const { session, assistantMessageId, abortController, phase } = input;
  const availableAccounts = listLoginAccounts({ userId: session.userId })
    .filter((account) => account.status === 'active')
    .slice(0, 80)
    .map((account) => ({
      id: account.id,
      domain: account.domain,
      username: account.username,
      label: account.label,
      loginUrl: account.loginUrl,
    }));
  const generatedPlan = await generateTargetWorkflowPlan({
    availableAccounts,
    messages: targetPlanningMessages(session, assistantMessageId, input.latest),
    currentPlan: session.targetRun?.plan,
    research: session.targetRun?.research,
    targetUrl: session.targetUrl,
    onValidation: ({ attempt, errors }) => {
      if (!isActiveBrowserChatTurn(session, assistantMessageId, abortController)) return;
      const repaired = attempt === 'repair';
      appendLog(
        session,
        errors.length ? (repaired ? 'target:plan:validation:error' : 'target:plan:validation:retry') : 'target:plan:validation:passed',
        errors.length
          ? `${repaired ? '修复后的' : '初次'}目标流程仍有 ${errors.length} 项结构或语言问题${repaired ? '' : '，正在自动修复'}`
          : `${repaired ? '修复后的' : '初次'}目标流程结构与语言校验通过`,
        {
          details: errors.length ? { attempt, errors, phase } : { attempt, phase },
          messageId: assistantMessageId,
        },
      );
    },
  });
  return mergeLatestTargetActorAuth(generatedPlan, session.targetRun?.plan);
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
  update: Partial<Pick<BrowserChatStoredSubagent, 'status' | 'summary' | 'steps' | 'events' | 'error'>>,
) {
  const record = browserChatSubagentSessionRegistry(sessionId).get(uuid);
  if (!record) return;
  Object.assign(record, update, { updatedAt: now() });
}

function readBrowserChatSubagent(sessionId: string): BrowserChatSubagentReader {
  return async (uuid) => {
    const record = subagentResults.get(sessionId)?.get(uuid);
    if (record) {
    if (record.status === 'running') {
      return {
        ok: false,
        actual: JSON.stringify({
          uuid: record.uuid,
          title: record.title,
          status: record.status,
          error: '该子 Agent 仍在执行中。请等待 spawnSubagents 完成后，使用同一 UUID 再次读取。',
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
        error: record.error,
      }),
    };
    }
    return { ok: false, actual: `未找到 UUID 为 ${uuid} 的子 Agent；它可能不属于当前对话，或所属对话已被删除。` };
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
      isolated: true,
      storageState: inheritedStorageState,
      isMarked: true,
      preferExistingPage: false,
      runId: `${session.id}_${task.id}`,
    });
    const childSteps = new Map<number, StepExecutionResult>();
    let latestChildText = '';
    try {
      await child.start();
      if (task.url) await child.open(task.url);
      const credentialContext = targetResearchCredentialContext(
        session,
        task.url ? [{ kind: 'url', title: task.title, url: task.url }] : [],
        task.instruction,
      );
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
          'takeSnapshot 的 full 与 text 都读取已加载页面的完整 DOM；text 是 full 中全部文本的去重阅读视图，不是当前视窗。nextCursor 只是冻结结果的字符分页，不得为分页而滚动。',
          '完成工具执行后，直接在你自己的最终回复中写出约 20000 个中文字符的完整执行总结，包含过程、事实、证据、URL、失败、限制和未解决项；不得省略或截断。不要再启动子 Agent，也不要要求主 Agent 另行读取结果。',
          task.instruction,
          browserChatCredentialPrompt(credentialContext.credentials),
        ].join('\n\n'),
        conversation: [],
        completedSteps: [],
        mode: session.mode,
        safetyMode: session.safetyMode,
        resolveCredential: credentialContext.resolveCredential,
        credentialAllowedOrigins: credentialContext.credentialAllowedOrigins,
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
            const responseText = textFromUnknown(aiOutput?.response ?? aiOutput?.text).trim();
            if (responseText) latestChildText = responseText;
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
      const summary = textFromUnknown(result.reply || result.newSteps.at(-1)?.actual || '子 Agent 已完成，但没有返回额外文本。').trim();
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
          summary,
          resumable: false,
          steps: result.newSteps,
          stepCount: result.newSteps.length,
        }),
        messageId: assistantMessageId,
      });
      updateBrowserChatStoredSubagent(session.id, task.id, {
        status: result.status,
        summary,
        steps: result.newSteps,
      });
      persistAndNotify(session.id);
      return { id: task.id, title: task.title, task, status: result.status, summary, content: summary, evidence };
    } catch (error) {
      if (!ownsTurn()) throw error;
      const message = userFacingErrorMessage(error);
      const steps = [...childSteps.values()].sort((left, right) => left.index - right.index);
      const partialContent = latestChildText || steps.map((step) => step.actual).filter(Boolean).join('\n\n');
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
          summary: partialContent,
          partial: Boolean(partialContent || evidence.length),
          steps,
        }),
        messageId: assistantMessageId,
      });
      updateBrowserChatStoredSubagent(session.id, task.id, {
        status: 'failed',
        summary: partialContent,
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
      next: '逐个调用 readSubagent({ uuid }) 读取需要进入主 Agent 上下文的子 Agent 总结。',
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
  const credentialContext = targetResearchCredentialContext(
    session,
    binding.task.url ? [{ kind: 'url', title: binding.title, url: binding.task.url }] : [],
    binding.task.instruction,
  );
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
        browserChatCredentialPrompt(credentialContext.credentials),
      ].filter(Boolean).join('\n\n'),
      conversation: [],
      completedSteps: binding.steps,
      mode: session.mode,
      safetyMode: session.safetyMode,
      resolveCredential: credentialContext.resolveCredential,
      credentialAllowedOrigins: credentialContext.credentialAllowedOrigins,
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
    const summary = textFromUnknown(result.reply || result.newSteps.at(-1)?.actual || '子 Agent 续跑完成。').trim();
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
    try {
      if (!isActiveBrowserChatTurn(session, assistantMessageId, abortController)) return;
      appendLog(session, 'chat:run:start', '开始处理本轮对话操作');
      const browser = await browserForTurnDecision(session);
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
      appendLog(session, 'ai:prepare', '正在请求 AI 判断是否需要浏览器工具');
      const referenceImagePaths = attachments.map(attachmentAbsolutePath).filter((item): item is string => Boolean(item));
      const credentialContext = targetResearchCredentialContext(session, targetResearchSeeds(session, modelText), modelText);
      const result = await executeInteractiveBrowserTurn({
        session: browser,
        runId: session.id,
        targetUrl: session.targetUrl || 'about:blank',
        instruction: text,
        modelInstruction: [modelText, browserChatCredentialPrompt(credentialContext.credentials)].filter(Boolean).join('\n\n'),
        conversation: conversationForPrompt(session.messages, session.conversationContext, userMessageId),
        completedSteps: session.steps,
        mode: session.mode,
        safetyMode: session.safetyMode,
        referenceImagePaths,
        skillContext,
        resolveCredential: credentialContext.resolveCredential,
        credentialAllowedOrigins: credentialContext.credentialAllowedOrigins,
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
        ensureBrowserStarted: async () => {
          const startedBrowser = await ensureStarted(session);
          if (startedBrowser !== browser) throw new Error('Browser session changed while the AI was deciding; retry this browser tool on the active session.');
        },
        isBrowserStarted: () => session.started && session.browser === browser && browser.isUsable(),
        runSubagents: (tasks, _abortSignal, toolCallId) => runBrowserChatSubagents({ session, assistantMessageId, abortController, tasks, toolCallId }),
        readSubagent: readBrowserChatSubagent(session.id),
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
