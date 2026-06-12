import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { BrowserSession, type BrowserSessionMode } from '@/server/browser/browser-session';
import { executeInteractiveBrowserTurn, type InteractiveBrowserTurnMessage } from '@/server/ai/agents/test-executor.agent';
import type { RecordedFlowStep, StepExecutionResult, TestCaseContent, TestRunRecord } from '@/server/ai/schemas/test-case.schema';
import { store } from '@/server/db/sqlite-store';
import { readBrowserChatSessionSnapshots, writeBrowserChatSessionSnapshots } from '@/server/db/sqlite-store-engine';
import { createSnapshotChannel, type SnapshotEvent, type SnapshotListener } from '@/server/realtime/snapshot-channel';
import { artifactPath as resolveArtifactPath } from '@/server/storage/paths';
import { artifactApiUrlFromRelative } from '@/lib/artifacts';

export type BrowserChatAttachment = {
  id: string;
  name: string;
  type: string;
  size?: number;
  path: string;
  url: string;
};

export type BrowserChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  updatedAt?: string;
  clientMessageId?: string;
  attachments?: BrowserChatAttachment[];
  stepIndexes?: number[];
  status?: 'running' | 'passed' | 'failed' | 'blocked' | 'interrupted';
};

export type BrowserChatLogRecord = {
  id: string;
  time: string;
  phase: string;
  message: string;
  messageId?: string;
  stepIndex?: number;
  elapsedMs?: number;
};

export type BrowserChatSessionSnapshot = {
  id: string;
  title: string;
  targetUrl: string;
  mode: BrowserSessionMode | 'default';
  status: 'idle' | 'running' | 'closed' | 'error';
  busy: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  error?: string;
  messages: BrowserChatMessage[];
  steps: StepExecutionResult[];
  consoleErrors: string[];
  networkErrors: string[];
  logs: BrowserChatLogRecord[];
};

export type BrowserChatSessionEvent = SnapshotEvent<BrowserChatSessionSnapshot>;

type BrowserChatSessionRecord = BrowserChatSessionSnapshot & {
  activeAssistantMessageId?: string;
  activeAbortController?: AbortController;
  browser?: BrowserSession;
  started: boolean;
};

const sessions = new Map<string, BrowserChatSessionRecord>();
const sessionSnapshots = createSnapshotChannel<BrowserChatSessionSnapshot>('browserChatSession');
let sessionsHydrated = false;
let hydratePromise: Promise<void> | undefined;
let lastPersistWarningAt = 0;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
let persistPromise: Promise<unknown> = Promise.resolve();
const persistDebounceMs = 250;

function now() {
  return new Date().toISOString();
}

function id(prefix: string) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function notifySessionUpdate(sessionId: string) {
  const session = sessions.get(sessionId);
  if (session) sessionSnapshots.publish(sessionId, snapshot(session));
  else sessionSnapshots.publishDeleted(sessionId);
}

export function currentBrowserChatSessionEvent(
  sessionId: string,
  session: BrowserChatSessionSnapshot,
): BrowserChatSessionEvent {
  return sessionSnapshots.current(sessionId, session);
}

export function subscribeBrowserChatSessionEvents(
  sessionId: string,
  listener: SnapshotListener<BrowserChatSessionSnapshot>,
) {
  if (!sessionsHydrated) return undefined;
  if (!sessions.has(sessionId)) return undefined;
  return sessionSnapshots.subscribe(sessionId, listener);
}

function elapsedMs(startedAt: number) {
  return Date.now() - startedAt;
}

function elapsedFromDetails(details: unknown) {
  if (!details || typeof details !== 'object') return undefined;
  const value = (details as { elapsedMs?: unknown }).elapsedMs;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeBrowserUrl(url: string) {
  const trimmed = url.trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /^(about|data|file|blob):/i.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(trimmed)) return `http://${trimmed}`;
  return `https://${trimmed}`;
}

function isBlankBrowserUrl(url: string) {
  return !url || url === 'about:blank' || /^(about:newtab|chrome:\/\/new-tab-page|edge:\/\/newtab)/i.test(url);
}

function compactText(value = '', max = 180) {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
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
    const pathValue = normalizeAttachmentPath(record.path);
    if (!pathValue) continue;
    const type = typeof record.type === 'string' && record.type.startsWith('image/') ? record.type : 'image/*';
    const idValue = typeof record.id === 'string' && record.id.trim() ? record.id.trim().slice(0, 160) : path.basename(pathValue);
    const nameValue = typeof record.name === 'string' && record.name.trim() ? record.name.trim().slice(0, 180) : path.basename(pathValue);
    const sizeValue = typeof record.size === 'number' && Number.isFinite(record.size) ? Math.max(0, Math.floor(record.size)) : undefined;
    attachments.push({
      id: idValue,
      name: nameValue,
      type,
      size: sizeValue,
      path: pathValue,
      url: typeof record.url === 'string' && record.url.startsWith('/api/artifacts/') ? record.url : artifactApiUrlFromRelative(pathValue),
    });
  }
  return attachments;
}

function attachmentAbsolutePath(attachment: BrowserChatAttachment) {
  const relativePath = normalizeAttachmentPath(attachment.path);
  if (!relativePath) return undefined;
  return resolveArtifactPath(...relativePath.split('/'));
}

function attachmentSummary(attachments?: BrowserChatAttachment[]) {
  if (!attachments?.length) return '';
  return [
    '用户上传图片：',
    ...attachments.map((attachment, index) => `${index + 1}. ${attachment.name} (${attachment.path})`),
  ].join('\n');
}

function messageContentForPrompt(message: BrowserChatMessage) {
  return [message.content, attachmentSummary(message.attachments)].filter(Boolean).join('\n\n');
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

function normalizeSessionSnapshot(session: BrowserChatSessionSnapshot): BrowserChatSessionSnapshot {
  return {
    ...session,
    consoleErrors: Array.isArray(session.consoleErrors) ? session.consoleErrors : [],
    logs: Array.isArray(session.logs) ? session.logs : [],
    messages: Array.isArray(session.messages) ? session.messages : [],
    networkErrors: Array.isArray(session.networkErrors) ? session.networkErrors : [],
    steps: Array.isArray(session.steps) ? session.steps : [],
  };
}

function ensureSessionCollections(session: BrowserChatSessionRecord) {
  session.consoleErrors = Array.isArray(session.consoleErrors) ? session.consoleErrors : [];
  session.logs = Array.isArray(session.logs) ? session.logs : [];
  session.messages = Array.isArray(session.messages) ? session.messages : [];
  session.networkErrors = Array.isArray(session.networkErrors) ? session.networkErrors : [];
  session.steps = Array.isArray(session.steps) ? session.steps : [];
}

function stepsForExport(session: BrowserChatSessionRecord, selectedStepIndexes?: Set<number>) {
  return (session.steps || [])
    .filter((step) => selectedStepIndexes?.size ? selectedStepIndexes.has(step.index) : step.index > 0)
    .map((step) => ({ ...step, status: step.status === 'running' ? ('passed' as const) : step.status }))
    .sort((a, b) => a.index - b.index);
}

function recordedFlowFromSteps(steps: StepExecutionResult[]): RecordedFlowStep[] {
  return steps.flatMap((step) => (step.tools || []).map((tool, toolIndex) => ({
    index: 0,
    name: tool.name,
    input: tool.input,
    reason: tool.reason,
    sourceStepIndex: step.index,
    sourceStepAction: step.action,
    sourceStepExpected: step.expected,
    sourceToolIndex: toolIndex + 1,
  }))).map((flow, index) => ({ ...flow, index: index + 1 }));
}

function testStepsFromBrowserSteps(steps: StepExecutionResult[]): TestCaseContent['steps'] {
  return steps.map((step, index) => {
    const firstTool = step.tools?.[0];
    return {
      index: index + 1,
      operation: testOperationFromToolName(firstTool?.name),
      action: compactText(step.action || firstTool?.name || `执行步骤 ${step.index}`, 240),
      input: firstTool?.input ? safeJson(firstTool.input) : undefined,
      expected: compactText(step.expected || step.actual || '该步骤应按对话中的已执行结果完成。', 320),
      riskLevel: step.status === 'failed' ? 'warning' : 'safe',
    };
  });
}

function exportedRunDebug(session: BrowserChatSessionRecord) {
  const events = (session.logs || []).slice(-200).map((log) => ({
    time: log.time,
    phase: log.phase,
    message: log.message,
    stepIndex: log.stepIndex,
    details: log.elapsedMs ? { elapsedMs: log.elapsedMs } : undefined,
  }));
  return events.length ? { enabled: true, phase: 'browser-chat:export', events } : undefined;
}

async function persistBrowserChatExport(
  session: BrowserChatSessionRecord,
  content: TestCaseContent,
  selectedSteps: StepExecutionResult[],
  startedAt?: string,
  groupId?: string,
) {
  const testCase = await store.createTestCase(content, [], groupId);
  const run = await store.createRun(testCase.id);
  const finishedAt = now();
  const status = statusFromSteps(selectedSteps);
  const completedRun = await store.updateRun(run.id, {
    status,
    startedAt: startedAt || session.createdAt,
    endedAt: finishedAt,
    result: {
      steps: selectedSteps,
      consoleErrors: session.consoleErrors,
      networkErrors: session.networkErrors,
      taskFrame: selectedSteps.at(-1)?.taskFrame,
      ledgerItems: selectedSteps.flatMap((step) => step.ledgerItems || []),
    },
    debug: exportedRunDebug(session),
  }) || run;
  await store.updateTestCaseStatus(testCase.id, status === 'passed' ? 'passed' : status);
  return { testCase: await store.getTestCase(testCase.id) || testCase, run: completedRun };
}

function messageExportContent(input: {
  session: BrowserChatSessionRecord;
  message: BrowserChatMessage;
  previousUser?: BrowserChatMessage;
  selectedSteps: StepExecutionResult[];
  exportScope: 'message' | 'suite-message';
  suiteId?: string;
  suiteIndex?: number;
}) {
  const { exportScope, message, previousUser, selectedSteps, session, suiteId, suiteIndex } = input;
  const recordedFlow = recordedFlowFromSteps(selectedSteps);
  const titleSeed = previousUser?.content || message.content || '浏览器对话导出用例';
  const prefix = exportScope === 'suite-message' && suiteIndex ? `套件步骤 ${suiteIndex}` : '对话导出';
  const testData: Record<string, string> = {
    browserChatMessageId: message.id,
    browserChatSessionId: session.id,
    exportScope,
  };
  if (suiteId) testData.browserChatSuiteId = suiteId;
  if (suiteIndex) testData.browserChatSuiteIndex = String(suiteIndex);

  return {
    title: `${prefix} - ${compactText(titleSeed, 36)}`,
    description: [
      previousUser ? `用户消息：${previousUser.content}` : '',
      `AI 输出：${message.content}`,
    ].filter(Boolean).join('\n\n'),
    targetUrl: session.targetUrl || 'about:blank',
    priority: 'medium',
    browserMode: session.mode,
    isMarked: true,
    userRequirement: previousUser?.content || message.content,
    systemPrompt: exportScope === 'suite-message'
      ? '该用例由 browser-chat 探索套件生成，对应一次 assistant 操作回合，包含原始步骤和工具调用记录。'
      : '该用例由浏览器对话导出，已包含对话中 AI 实际执行过的步骤记录。',
    preconditions: ['已根据浏览器对话完成过一次执行，导出时同步创建一条已完成运行记录。'],
    testData,
    steps: testStepsFromBrowserSteps(selectedSteps),
    expectedResults: [message.content || '复现对话中 AI 已完成的浏览器操作。'],
    risks: (session.networkErrors || []).length || (session.consoleErrors || []).length
      ? ['原对话执行过程中存在控制台或网络错误记录，复跑时需要关注稳定性。']
      : [],
    recordedFlow: recordedFlow.length ? recordedFlow : undefined,
    taskFrame: selectedSteps.at(-1)?.taskFrame,
  } satisfies TestCaseContent;
}

function compactStepForClient(step: StepExecutionResult): StepExecutionResult {
  const { aiRequest: _aiRequest, visualContext: _visualContext, workingMemory: _workingMemory, ...clientStep } = step;
  return clientStep;
}

function previewMessages(session: BrowserChatSessionRecord) {
  const messages = session.messages || [];
  const firstUserMessage = messages.find((message) => message.role === 'user');
  const latestMessage = messages.at(-1);
  const selected = [firstUserMessage, latestMessage].filter((message): message is BrowserChatMessage => Boolean(message));
  return Array.from(new Map(selected.map((message) => [message.id, {
    ...message,
    content: compactText(message.content, 180),
  }])).values());
}

function snapshot(session: BrowserChatSessionRecord, options: { fullSteps?: boolean } = {}): BrowserChatSessionSnapshot {
  const normalized = normalizeSessionSnapshot(session);
  return {
    id: normalized.id,
    title: normalized.title,
    targetUrl: normalized.targetUrl,
    mode: normalized.mode,
    status: normalized.status,
    busy: normalized.busy,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    closedAt: normalized.closedAt,
    error: normalized.error,
    messages: [...normalized.messages],
    steps: options.fullSteps ? [...normalized.steps] : normalized.steps.map(compactStepForClient),
    consoleErrors: [...normalized.consoleErrors],
    networkErrors: [...normalized.networkErrors],
    logs: [...normalized.logs],
  };
}

function summarySnapshot(session: BrowserChatSessionRecord): BrowserChatSessionSnapshot {
  const normalized = normalizeSessionSnapshot(session);
  return {
    id: normalized.id,
    title: normalized.title,
    targetUrl: normalized.targetUrl,
    mode: normalized.mode,
    status: normalized.status,
    busy: normalized.busy,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    closedAt: normalized.closedAt,
    error: normalized.error,
    messages: previewMessages(session),
    steps: [],
    consoleErrors: [],
    networkErrors: [],
    logs: normalized.busy ? [...normalized.logs.slice(-8)] : [],
  };
}

function recordFromSnapshot(session: BrowserChatSessionSnapshot): BrowserChatSessionRecord {
  const normalized = normalizeSessionSnapshot(session);
  const status = normalized.status === 'running' ? 'idle' : normalized.status;
  return {
    ...normalized,
    status,
    busy: false,
    started: false,
    browser: undefined,
  };
}

function appendLog(
  session: BrowserChatSessionRecord,
  phase: string,
  message: string,
  input: { stepIndex?: number; elapsedMs?: number } = {},
) {
  const timestamp = now();
  const runningContent = runningContentFromLog(phase, message);
  session.logs = [
    ...(session.logs || []),
    {
      id: id('log'),
      time: timestamp,
      phase,
      message,
      messageId: session.activeAssistantMessageId,
      stepIndex: input.stepIndex,
      elapsedMs: input.elapsedMs,
    },
  ].slice(-300);
  if (session.activeAssistantMessageId) {
    updateAssistantMessage(session, session.activeAssistantMessageId, (item) => ({
      ...item,
      content: item.status === 'running' && runningContent ? runningContent : item.content,
      stepIndexes: input.stepIndex
        ? Array.from(new Set([...(item.stepIndexes || []), input.stepIndex])).sort((a, b) => a - b)
        : item.stepIndexes,
      updatedAt: timestamp,
    }));
  }
  session.updatedAt = timestamp;
  persistAndNotify(session.id, phase);
}

function persistSessions() {
  try {
    const payload = jsonSafeClone([...sessions.values()].map((session) => snapshot(session, { fullSteps: true })));
    persistPromise = persistPromise
      .catch(() => undefined)
      .then(() => writeBrowserChatSessionSnapshots(payload))
      .catch((error) => {
        warnPersistFailure(error);
        return false;
      });
    return persistPromise;
  } catch (error) {
    warnPersistFailure(error);
    return Promise.resolve(false);
  }
}

function persistAndNotify(sessionId: string, reason = 'session-updated') {
  void reason;
  notifySessionUpdate(sessionId);
  schedulePersistSessions();
}

function schedulePersistSessions() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    void persistSessions();
  }, persistDebounceMs);
  persistTimer.unref?.();
}

async function hydrateSessions() {
  if (sessionsHydrated) return;
  if (!hydratePromise) {
    hydratePromise = readBrowserChatSessionSnapshots<BrowserChatSessionSnapshot>()
      .then((data) => {
        if (!Array.isArray(data)) return;
        sessions.clear();
        for (const item of data) {
          if (!item?.id) continue;
          sessions.set(item.id, recordFromSnapshot(item));
        }
      })
      .catch((error) => {
        warnPersistFailure(error);
      })
      .finally(() => {
        sessionsHydrated = true;
      });
  }
  await hydratePromise;
}

function conversationForPrompt(messages: BrowserChatMessage[]): InteractiveBrowserTurnMessage[] {
  return messages
    .filter((message) => (message.role === 'user' || message.role === 'assistant') && message.status !== 'running')
    .map((message) => ({ role: message.role, content: messageContentForPrompt(message) }));
}

function isDeadBrowserSessionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /Browser session has not started|Active browser page has been closed|Target page, context or browser has been closed|browser has been closed|page has been closed/i.test(message);
}

async function ensureStarted(session: BrowserChatSessionRecord) {
  if (session.started && session.browser) {
    if (session.browser.isUsable()) {
      appendLog(session, 'browser:reuse', '复用当前会话已有浏览器标签');
      return session.browser;
    }
    appendLog(session, 'browser:stale', '历史对话的浏览器已关闭或页面已失效，正在重新接管本会话。');
    await session.browser.close().catch(() => undefined);
    session.browser = undefined;
    session.started = false;
    session.updatedAt = now();
    persistAndNotify(session.id, 'browser:stale');
  }
  await store.applyRuntimeEnv();
  const startedAt = Date.now();
  appendLog(session, 'browser:start', '正在启动或连接浏览器');
  const hasPriorConversation = (session.steps || []).length > 0
    || (session.messages || []).some((message) => message.role === 'assistant' && message.id !== session.activeAssistantMessageId);
  const browser = new BrowserSession(session.mode === 'default' ? undefined : session.mode, {
    isMarked: true,
    preferExistingPage: !hasPriorConversation,
    runId: session.id,
    tabGroupTitle: session.title,
  });
  session.browser = browser;
  session.status = 'running';
  session.updatedAt = now();
  persistAndNotify(session.id);
  try {
    await browser.start();
  } catch (error) {
    await browser.close().catch(() => undefined);
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
  const url = normalizeBrowserUrl(session.targetUrl);
  const currentUrl = browser.currentUrl();
  const shouldOpenTarget = Boolean(url && !isBlankBrowserUrl(url) && (!browser.hasNonBlankActivePage() || !hasPriorConversation));
  if (browser.hasNonBlankActivePage() && hasPriorConversation) {
    session.targetUrl = currentUrl || session.targetUrl;
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

export async function createBrowserChatSession(input: {
  targetUrl?: string;
  mode?: BrowserSessionMode | 'default';
  title?: string;
} = {}) {
  await hydrateSessions();
  await store.applyRuntimeEnv();
  const timestamp = now();
  const session: BrowserChatSessionRecord = {
    id: id('chat'),
    title: input.title?.trim() || '浏览器对话操作',
    targetUrl: normalizeBrowserUrl(input.targetUrl || ''),
    mode: input.mode || 'visual-markers',
    status: 'idle',
    busy: false,
    started: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: [],
    steps: [],
    consoleErrors: [],
    networkErrors: [],
    logs: [],
  };
  sessions.set(session.id, session);
  persistAndNotify(session.id);
  return snapshot(session);
}

export async function getBrowserChatSession(sessionId: string) {
  await hydrateSessions();
  const session = sessions.get(sessionId);
  return session ? snapshot(session) : undefined;
}

export async function listBrowserChatSessions() {
  await hydrateSessions();
  return [...sessions.values()].map(summarySnapshot).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function closeBrowserChatSession(sessionId: string) {
  await hydrateSessions();
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  if (session.activeAbortController && !session.activeAbortController.signal.aborted) {
    session.activeAbortController.abort(new Error('Browser chat session closed by user.'));
  }
  await session.browser?.close().catch(() => undefined);
  session.browser = undefined;
  session.started = false;
  session.activeAbortController = undefined;
  session.activeAssistantMessageId = undefined;
  session.busy = false;
  session.status = 'closed';
  session.closedAt = now();
  session.updatedAt = session.closedAt;
  persistAndNotify(session.id);
  return snapshot(session);
}

export async function deleteBrowserChatSession(sessionId: string) {
  await hydrateSessions();
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  if (session.activeAbortController && !session.activeAbortController.signal.aborted) {
    session.activeAbortController.abort(new Error('Browser chat session deleted by user.'));
  }
  await session.browser?.close().catch(() => undefined);
  session.browser = undefined;
  session.started = false;
  session.activeAbortController = undefined;
  session.activeAssistantMessageId = undefined;
  sessions.delete(sessionId);
  persistAndNotify(sessionId);
  return { id: sessionId };
}

export async function deleteBrowserChatSessions(sessionIds: string[]) {
  await hydrateSessions();
  const uniqueIds = Array.from(new Set(sessionIds.map((item) => item.trim()).filter(Boolean)));
  const deleted: Array<{ id: string }> = [];
  for (const sessionId of uniqueIds) {
    const result = await deleteBrowserChatSession(sessionId);
    if (result) deleted.push(result);
  }
  return { deleted, requested: uniqueIds.length };
}

export async function exportBrowserChatMessageToTestCase(sessionId: string, messageId: string) {
  await hydrateSessions();
  const session = sessions.get(sessionId);
  if (!session) throw new Error('Browser chat session not found');
  ensureSessionCollections(session);
  const messages = session.messages || [];
  const messageIndex = messages.findIndex((message) => message.id === messageId && message.role === 'assistant');
  if (messageIndex < 0) throw new Error('Browser chat assistant message not found');
  const message = messages[messageIndex];
  const previousUser = [...messages.slice(0, messageIndex)].reverse().find((item) => item.role === 'user');
  const selectedStepIndexes = new Set(message.stepIndexes || []);
  const selectedSteps = stepsForExport(session, selectedStepIndexes);
  if (!selectedSteps.length) throw new Error('No executed browser steps found for this message');

  const content = messageExportContent({
    exportScope: 'message',
    message,
    previousUser,
    selectedSteps,
    session,
  });
  return persistBrowserChatExport(session, content, selectedSteps, message.createdAt || session.createdAt);
}

export async function exportBrowserChatSessionToTestCase(sessionId: string) {
  await hydrateSessions();
  const session = sessions.get(sessionId);
  if (!session) throw new Error('Browser chat session not found');
  ensureSessionCollections(session);
  const selectedSteps = stepsForExport(session);
  if (!selectedSteps.length) throw new Error('No executed browser steps found for this session');

  const messages = session.messages || [];
  const userMessages = messages.filter((message) => message.role === 'user');
  const assistantMessages = messages.filter((message) => message.role === 'assistant' && message.status !== 'running');
  const recordedFlow = recordedFlowFromSteps(selectedSteps);
  const titleSeed = userMessages[0]?.content || session.title || '浏览器探索记录';
  const userRequirement = userMessages.map((message, index) => `${index + 1}. ${message.content}`).join('\n');
  const assistantSummary = assistantMessages
    .slice(-4)
    .map((message, index) => `${index + 1}. ${compactText(message.content, 480)}`)
    .join('\n');
  const logSummary = (session.logs || [])
    .slice(-8)
    .map((log) => `${log.phase}：${compactText(log.message, 140)}`)
    .join('\n');
  const risks = [
    (session.networkErrors || []).length || (session.consoleErrors || []).length
      ? '原对话执行过程中存在控制台或网络错误记录，复跑时需要关注稳定性。'
      : '',
    session.status === 'error' ? '原对话处于异常状态，导出的用例需要人工复核。' : '',
  ].filter(Boolean);

  const content: TestCaseContent = {
    title: `探索记录导出 - ${compactText(titleSeed, 36)}`,
    description: [
      `来源会话：${session.title}`,
      userRequirement ? `用户消息：\n${userRequirement}` : '',
      assistantSummary ? `AI 输出摘要：\n${assistantSummary}` : '',
      logSummary ? `执行日志摘要：\n${logSummary}` : '',
    ].filter(Boolean).join('\n\n'),
    targetUrl: session.targetUrl || 'about:blank',
    priority: 'medium',
    browserMode: session.mode,
    isMarked: true,
    userRequirement: userRequirement || session.title,
    systemPrompt: '该用例由完整 browser-chat 探索记录导出，包含会话中的步骤、工具调用和日志摘要。',
    preconditions: ['已通过 browser-chat 完成一次探索，导出时同步创建一条已完成运行记录。'],
    testData: {
      browserChatSessionId: session.id,
      exportScope: 'session',
    },
    steps: testStepsFromBrowserSteps(selectedSteps),
    expectedResults: assistantMessages.length
      ? assistantMessages.slice(-3).map((message) => compactText(message.content, 360))
      : ['复现 browser-chat 探索过程中已完成的浏览器操作。'],
    risks,
    recordedFlow: recordedFlow.length ? recordedFlow : undefined,
    taskFrame: selectedSteps.at(-1)?.taskFrame,
  };

  return persistBrowserChatExport(session, content, selectedSteps, session.createdAt);
}

export async function exportBrowserChatSessionToTestSuite(sessionId: string) {
  await hydrateSessions();
  const session = sessions.get(sessionId);
  if (!session) throw new Error('Browser chat session not found');
  ensureSessionCollections(session);
  const messages = session.messages || [];
  const assistantMessages = messages.filter((message) => message.role === 'assistant' && message.status !== 'running');
  const scopedMessages = assistantMessages.map((message, messageIndex) => {
    const previousUser = [...messages.slice(0, messages.indexOf(message))]
      .reverse()
      .find((item) => item.role === 'user');
    const hasScopedSteps = Boolean(message.stepIndexes?.length);
    const selectedSteps = hasScopedSteps || assistantMessages.length === 1
      ? stepsForExport(session, new Set(message.stepIndexes || []))
      : [];
    return { message, messageIndex, previousUser, selectedSteps };
  }).filter((item) => item.selectedSteps.length > 0);

  if (!scopedMessages.length) {
    const selectedSteps = stepsForExport(session);
    if (!selectedSteps.length) throw new Error('No executed browser steps found for this session');
    const exported = await exportBrowserChatSessionToTestCase(sessionId);
    return {
      group: undefined,
      testCases: [exported.testCase],
      runs: [exported.run],
      fallback: true,
    };
  }

  const group = await store.createGroup(`探索套件 - ${compactText(session.title || session.id, 32)}`);
  const exported = [];
  for (let index = 0; index < scopedMessages.length; index += 1) {
    const item = scopedMessages[index];
    const content = messageExportContent({
      exportScope: 'suite-message',
      message: item.message,
      previousUser: item.previousUser,
      selectedSteps: item.selectedSteps,
      session,
      suiteId: group.id,
      suiteIndex: index + 1,
    });
    exported.push(await persistBrowserChatExport(
      session,
      content,
      item.selectedSteps,
      item.message.createdAt || session.createdAt,
      group.id,
    ));
  }

  return {
    group,
    testCases: exported.map((item) => item.testCase),
    runs: exported.map((item) => item.run),
    fallback: false,
  };
}

export async function sendBrowserChatMessage(
  sessionId: string,
  content: string,
  mode?: BrowserSessionMode | 'default',
  clientMessageId?: string,
  attachmentsInput?: unknown,
) {
  await hydrateSessions();
  const session = sessions.get(sessionId);
  if (!session) throw new Error('Browser chat session not found');
  ensureSessionCollections(session);
  if (session.status === 'closed') throw new Error('Browser chat session is closed');
  const text = content.trim();
  const attachments = normalizeAttachments(attachmentsInput);
  if (!text && !attachments.length) throw new Error('Message is empty');
  const messageText = text || '请结合我上传的图片继续处理当前任务。';
  const normalizedClientMessageId = clientMessageId?.trim().slice(0, 120) || undefined;
  if (normalizedClientMessageId && session.messages.some((message) => message.clientMessageId === normalizedClientMessageId)) {
    return snapshot(session);
  }
  if (session.busy) throw new Error('Browser chat session is already running');
  if (mode && !session.started && !(session.steps || []).length && !(session.messages || []).length) session.mode = mode;
  const firstUserMessage = !(session.messages || []).some((message) => message.role === 'user');
  if (firstUserMessage) session.title = compactText(messageText, 42);

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
  };
  const assistantMessage: BrowserChatMessage = {
    id: id('msg'),
    role: 'assistant',
    content: '正在处理...',
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

  void runBrowserChatMessage(session, messageText, assistantMessage.id, fromStepIndex, abortController, attachments);
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

function jsonSafeClone<T>(value: T): T {
  const serialized = stringifyJsonSafe(value);
  return serialized ? JSON.parse(serialized) as T : value;
}

function warnPersistFailure(error: unknown) {
  const timestamp = Date.now();
  if (timestamp - lastPersistWarningAt < 1000) return;
  lastPersistWarningAt = timestamp;
  console.warn('[browser-chat] Failed to persist sessions; keeping realtime state in memory.', error);
}

function looksLikeDomSnapshot(value?: string) {
  const text = (value || '').trim();
  if (!text || !/\bnode_id=\d+\b/.test(text)) return false;
  return /<\s*(?:a|button|input|select|textarea|option|summary|details|label|form|iframe)\b/i.test(text);
}

function runningAssistantContent(step: StepExecutionResult) {
  const latestTool = step.tools?.at(-1);
  if (latestTool) {
    if (latestTool.ok === false) return `工具调用失败：${latestTool.name}`;
    if (latestTool.ok === true) return `工具调用完成：${latestTool.name}`;
    return `正在调用工具：${latestTool.name}`;
  }
  const actual = step.actual?.trim();
  return (actual && !looksLikeDomSnapshot(actual) ? actual : undefined) || step.action?.trim() || '正在处理...';
}

function runningContentFromLog(phase: string, message: string) {
  if (phase === 'browser:screenshot:before') return '正在截取当前页面...';
  if (phase === 'browser:screenshot:after') return '正在保存操作后的页面状态...';
  if (phase === 'ai:runtime-input:start') return '正在准备当前页面上下文...';
  if (phase === 'perf:runtime-input') return '正在准备当前页面上下文...';
  if (phase === 'ai:runtime:request') return '正在请求 AI 判断下一步操作...';
  if (phase === 'ai:context-compressed') return '正在整理视觉上下文...';
  if (phase === 'ai:visual-context') return '正在更新视觉上下文...';
  if (phase === 'chat:step:start') return '正在准备下一步浏览器操作...';
  if (phase === 'ai:prepare') return '正在收集页面状态并请求 AI 决策...';
  if (phase === 'ai:tool') {
    const name = message.split(/\s|->/).filter(Boolean)[0];
    if (/started/i.test(message)) return `正在调用工具：${name}`;
    if (/failed/i.test(message)) return `工具调用失败：${name}`;
    if (/ok/i.test(message)) return `工具调用完成：${name}`;
    return `正在处理工具调用：${name}`;
  }
  return undefined;
}

function isActiveBrowserChatTurn(session: BrowserChatSessionRecord, assistantMessageId: string, abortController: AbortController) {
  return session.activeAssistantMessageId === assistantMessageId
    && session.activeAbortController === abortController
    && !abortController.signal.aborted;
}

function isAbortLikeError(error: unknown) {
  if (!error || typeof error !== 'object') return /abort|interrupted/i.test(String(error || ''));
  const name = 'name' in error ? String((error as { name?: unknown }).name || '') : '';
  const message = error instanceof Error ? error.message : String(error);
  return name === 'AbortError' || /abort|interrupted|cancel/i.test(message);
}

function cleanInfrastructureMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error || ''))
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n?Call log:\n[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function browserChatFailureSummary(error: unknown) {
  const message = cleanInfrastructureMessage(error);
  if (/page\.screenshot/i.test(message) && /Timeout \d+ms exceeded/i.test(message)) {
    return {
      title: '页面截图超时',
      detail: '浏览器没有在限定时间内完成截图，通常是页面渲染、字体加载或标签页状态卡住导致的。',
      suggestion: '可以稍等页面稳定后重试；如果这个页面很重，优先使用 DOM 模式继续操作。',
    };
  }
  if (/Timeout \d+ms exceeded/i.test(message)) {
    return {
      title: '浏览器操作超时',
      detail: '本轮操作等待页面响应太久，已经停止以避免一直卡住。',
      suggestion: '可以重试这一轮，或先确认页面是否还在加载、是否弹出了验证/权限窗口。',
    };
  }
  if (/Target page, context or browser has been closed|browser has been closed|page has been closed/i.test(message)) {
    return {
      title: '浏览器页面已关闭',
      detail: '执行过程中目标标签页或浏览器连接断开。',
      suggestion: '重新开始或打开目标页面后再继续对话。',
    };
  }
  return {
    title: '浏览器执行中断',
    detail: message || '本轮执行遇到浏览器侧异常，已经停止。',
    suggestion: '可以重试，或查看日志了解更完整的执行节点。',
  };
}

function browserChatFailureMarkdown(error: unknown) {
  const summary = browserChatFailureSummary(error);
  return [
    `**${summary.title}**`,
    '',
    summary.detail,
    '',
    `建议：${summary.suggestion}`,
  ].join('\n');
}

function sanitizeBrowserChatReply(reply: string, status: BrowserChatMessage['status']) {
  if (status !== 'failed' && status !== 'blocked') return reply;
  if (!/Call log:|\x1b\[[0-9;]*m|page\.screenshot|Timeout \d+ms exceeded/i.test(reply)) return reply;
  return browserChatFailureMarkdown(reply);
}

export async function interruptBrowserChatSession(sessionId: string) {
  await hydrateSessions();
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  const timestamp = now();
  const assistantMessageId = session.activeAssistantMessageId;
  const abortController = session.activeAbortController;
  if (abortController && !abortController.signal.aborted) {
    abortController.abort(new Error('Browser chat operation interrupted by user.'));
  }
  if (assistantMessageId) {
    updateAssistantMessage(session, assistantMessageId, (message) => ({
      ...message,
      content: '已中断本轮对话操作。浏览器保持当前状态，可以继续发送下一条消息。',
      updatedAt: timestamp,
      status: 'interrupted',
    }));
  }
  session.activeAbortController = undefined;
  session.activeAssistantMessageId = undefined;
  session.busy = false;
  if (session.status !== 'closed') session.status = 'idle';
  session.error = undefined;
  session.updatedAt = timestamp;
  session.logs = [
    ...(session.logs || []),
    {
      id: id('log'),
      time: timestamp,
      phase: 'chat:interrupted',
      message: '用户中断了本轮对话操作，浏览器保持当前状态。',
      messageId: assistantMessageId,
    },
  ].slice(-300);
  persistAndNotify(session.id);
  return snapshot(session);
}

async function runBrowserChatMessage(
  session: BrowserChatSessionRecord,
  text: string,
  assistantMessageId: string,
  fromStepIndex: number,
  abortController: AbortController,
  attachments: BrowserChatAttachment[],
) {
  ensureSessionCollections(session);
  try {
    if (!isActiveBrowserChatTurn(session, assistantMessageId, abortController)) return;
    appendLog(session, 'chat:run:start', '开始处理本轮对话操作');
    const browser = await ensureStarted(session);
    if (!isActiveBrowserChatTurn(session, assistantMessageId, abortController)) return;
    appendLog(session, 'ai:prepare', '浏览器已准备好，正在收集页面状态并请求 AI 决策');
    const referenceImagePaths = attachments.map(attachmentAbsolutePath).filter((item): item is string => Boolean(item));
    const result = await executeInteractiveBrowserTurn({
      session: browser,
      runId: session.id,
      targetUrl: session.targetUrl || 'about:blank',
      instruction: text,
      conversation: conversationForPrompt(session.messages),
      completedSteps: session.steps,
      mode: session.mode,
      referenceImagePaths,
      abortSignal: abortController.signal,
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
            content: runningAssistantContent(step),
            status: 'running',
            updatedAt: timestamp,
            stepIndexes: Array.from(new Set([...(message.stepIndexes || []), step.index])).sort((a, b) => a - b),
          }));
        }
        session.updatedAt = now();
        persistAndNotify(session.id);
      },
      onDebug: (event) => {
        if (!isActiveBrowserChatTurn(session, assistantMessageId, abortController)) return;
        appendLog(session, event.phase, event.message, {
          stepIndex: event.stepIndex,
          elapsedMs: elapsedFromDetails(event.details),
        });
      },
    });
    if (!isActiveBrowserChatTurn(session, assistantMessageId, abortController)) return;
    appendLog(session, 'chat:run:done', '本轮对话操作已完成');
    session.steps = result.steps;
    session.consoleErrors = result.consoleErrors;
    session.networkErrors = result.networkErrors;
    const finishedAt = now();
    updateAssistantMessage(session, assistantMessageId, (message) => ({
      ...message,
      content: sanitizeBrowserChatReply(result.reply, result.status),
      updatedAt: finishedAt,
      stepIndexes: result.newSteps.map((step) => step.index),
      status: result.status,
    }));
    session.status = 'idle';
    session.busy = false;
    session.activeAssistantMessageId = undefined;
    session.activeAbortController = undefined;
    session.updatedAt = finishedAt;
    persistAndNotify(session.id, `chat:run:${result.status}`);
  } catch (error) {
    const interrupted = abortController.signal.aborted || isAbortLikeError(error);
    if (!isActiveBrowserChatTurn(session, assistantMessageId, abortController) && interrupted) return;
    const message = cleanInfrastructureMessage(error);
    const friendlyMessage = browserChatFailureMarkdown(error);
    if (isDeadBrowserSessionError(error)) {
      await session.browser?.close().catch(() => undefined);
      session.browser = undefined;
      session.started = false;
    }
    appendLog(session, interrupted ? 'chat:run:interrupted' : 'chat:run:error', interrupted ? '本轮对话操作已中断。' : `本轮对话操作中断：${message || '未知错误'}`);
    session.error = interrupted ? undefined : message;
    session.status = interrupted ? 'idle' : 'error';
    session.busy = false;
    session.updatedAt = now();
    updateAssistantMessage(session, assistantMessageId, (item) => ({
      ...item,
      content: interrupted ? '已中断本轮对话操作。浏览器保持当前状态，可以继续发送下一条消息。' : friendlyMessage,
      updatedAt: session.updatedAt,
      status: interrupted ? 'interrupted' : 'failed',
    }));
    session.activeAssistantMessageId = undefined;
    session.activeAbortController = undefined;
    persistAndNotify(session.id, interrupted ? 'chat:run:interrupted' : 'chat:run:failed');
  } finally {
    if (session.activeAbortController === abortController) session.activeAbortController = undefined;
  }
}
