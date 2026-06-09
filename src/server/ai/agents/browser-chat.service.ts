import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BrowserSession, type BrowserSessionMode } from '@/server/browser/browser-session';
import { executeInteractiveBrowserTurn, type InteractiveBrowserTurnMessage } from '@/server/ai/agents/test-executor.agent';
import type { RecordedFlowStep, StepExecutionResult, TestCaseContent, TestRunRecord } from '@/server/ai/schemas/test-case.schema';
import { store } from '@/server/db/mock-store';
import { createSnapshotChannel, type SnapshotEvent, type SnapshotListener } from '@/server/realtime/snapshot-channel';
import { writeTextFileAtomic } from '@/server/storage/atomic-json';
import { appDataRoot, artifactPath as resolveArtifactPath } from '@/server/storage/paths';

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
const sessionsPath = path.join(appDataRoot(), '.data', 'browser-chat-sessions.json');
let sessionsHydrated = false;
let lastPersistWarningAt = 0;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
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
  hydrateSessions();
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

function artifactUrl(relativePath: string) {
  return `/api/artifacts/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
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
      url: typeof record.url === 'string' && record.url.startsWith('/api/artifacts/') ? record.url : artifactUrl(pathValue),
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

function compactStepForClient(step: StepExecutionResult): StepExecutionResult {
  const { aiRequest: _aiRequest, visualContext: _visualContext, workingMemory: _workingMemory, ...clientStep } = step;
  return clientStep;
}

function previewMessages(session: BrowserChatSessionRecord) {
  const firstUserMessage = session.messages.find((message) => message.role === 'user');
  const latestMessage = session.messages.at(-1);
  const selected = [firstUserMessage, latestMessage].filter((message): message is BrowserChatMessage => Boolean(message));
  return Array.from(new Map(selected.map((message) => [message.id, {
    ...message,
    content: compactText(message.content, 180),
  }])).values());
}

function snapshot(session: BrowserChatSessionRecord, options: { fullSteps?: boolean } = {}): BrowserChatSessionSnapshot {
  return {
    id: session.id,
    title: session.title,
    targetUrl: session.targetUrl,
    mode: session.mode,
    status: session.status,
    busy: session.busy,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    closedAt: session.closedAt,
    error: session.error,
    messages: [...session.messages],
    steps: options.fullSteps ? [...session.steps] : session.steps.map(compactStepForClient),
    consoleErrors: [...session.consoleErrors],
    networkErrors: [...session.networkErrors],
    logs: [...(session.logs || [])],
  };
}

function summarySnapshot(session: BrowserChatSessionRecord): BrowserChatSessionSnapshot {
  return {
    id: session.id,
    title: session.title,
    targetUrl: session.targetUrl,
    mode: session.mode,
    status: session.status,
    busy: session.busy,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    closedAt: session.closedAt,
    error: session.error,
    messages: previewMessages(session),
    steps: [],
    consoleErrors: [],
    networkErrors: [],
    logs: session.busy ? [...(session.logs || []).slice(-8)] : [],
  };
}

function recordFromSnapshot(session: BrowserChatSessionSnapshot): BrowserChatSessionRecord {
  const status = session.status === 'running' ? 'idle' : session.status;
  return {
    ...session,
    status,
    busy: false,
    logs: session.logs || [],
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
  persistAndNotify(session.id);
}

function persistSessions() {
  try {
    const payload = stringifyJsonSafe([...sessions.values()].map((session) => snapshot(session, { fullSteps: true })), 2);
    if (!payload) throw new Error('Browser chat sessions could not be serialized.');
    writeTextFileAtomic(sessionsPath, payload);
    return true;
  } catch (error) {
    warnPersistFailure(error);
    return false;
  }
}

function persistAndNotify(sessionId: string) {
  notifySessionUpdate(sessionId);
  schedulePersistSessions();
}

function schedulePersistSessions() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    persistSessions();
  }, persistDebounceMs);
  persistTimer.unref?.();
}

function hydrateSessions() {
  if (sessionsHydrated) return;
  sessionsHydrated = true;
  if (!existsSync(sessionsPath)) return;
  try {
    const data = JSON.parse(readFileSync(sessionsPath, 'utf8')) as BrowserChatSessionSnapshot[];
    if (!Array.isArray(data)) return;
    for (const item of data) {
      if (!item?.id) continue;
      sessions.set(item.id, recordFromSnapshot(item));
    }
  } catch {
    sessions.clear();
  }
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
    persistAndNotify(session.id);
  }
  store.applyRuntimeEnv();
  const startedAt = Date.now();
  appendLog(session, 'browser:start', '正在启动或连接浏览器');
  const hasPriorConversation = session.steps.length > 0
    || session.messages.some((message) => message.role === 'assistant' && message.id !== session.activeAssistantMessageId);
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

export function createBrowserChatSession(input: {
  targetUrl?: string;
  mode?: BrowserSessionMode | 'default';
  title?: string;
} = {}) {
  hydrateSessions();
  store.applyRuntimeEnv();
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

export function getBrowserChatSession(sessionId: string) {
  hydrateSessions();
  const session = sessions.get(sessionId);
  return session ? snapshot(session) : undefined;
}

export function listBrowserChatSessions() {
  hydrateSessions();
  return [...sessions.values()].map(summarySnapshot).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function closeBrowserChatSession(sessionId: string) {
  hydrateSessions();
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  await session.browser?.close().catch(() => undefined);
  session.browser = undefined;
  session.started = false;
  session.busy = false;
  session.status = 'closed';
  session.closedAt = now();
  session.updatedAt = session.closedAt;
  persistAndNotify(session.id);
  return snapshot(session);
}

export async function deleteBrowserChatSession(sessionId: string) {
  hydrateSessions();
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  await session.browser?.close().catch(() => undefined);
  session.browser = undefined;
  session.started = false;
  sessions.delete(sessionId);
  persistAndNotify(sessionId);
  return { id: sessionId };
}

export function exportBrowserChatMessageToTestCase(sessionId: string, messageId: string) {
  hydrateSessions();
  const session = sessions.get(sessionId);
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

  const recordedFlow: RecordedFlowStep[] = selectedSteps.flatMap((step) => (step.tools || []).map((tool) => ({
    index: 0,
    name: tool.name,
    input: tool.input,
    reason: tool.reason,
  }))).map((flow, index) => ({ ...flow, index: index + 1 }));

  const titleSeed = previousUser?.content || message.content || '浏览器对话导出用例';
  const content: TestCaseContent = {
    title: `对话导出 - ${compactText(titleSeed, 36)}`,
    description: [
      previousUser ? `用户消息：${previousUser.content}` : '',
      `AI 输出：${message.content}`,
    ].filter(Boolean).join('\n\n'),
    targetUrl: session.targetUrl || 'about:blank',
    priority: 'medium',
    browserMode: session.mode,
    isMarked: true,
    userRequirement: previousUser?.content || message.content,
    systemPrompt: '该用例由浏览器对话导出，已包含对话中 AI 实际执行过的步骤记录。',
    preconditions: ['已根据浏览器对话完成过一次执行，导出时同步创建一条已完成运行记录。'],
    testData: {},
    steps: selectedSteps.map((step, index) => {
      const firstTool = step.tools?.[0];
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

export async function sendBrowserChatMessage(
  sessionId: string,
  content: string,
  mode?: BrowserSessionMode | 'default',
  clientMessageId?: string,
  attachmentsInput?: unknown,
) {
  hydrateSessions();
  const session = sessions.get(sessionId);
  if (!session) throw new Error('Browser chat session not found');
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
  if (mode && !session.started && !session.steps.length && !session.messages.length) session.mode = mode;
  const firstUserMessage = !session.messages.some((message) => message.role === 'user');
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

function runningAssistantContent(step: StepExecutionResult) {
  const latestTool = step.tools?.at(-1);
  if (latestTool) {
    if (latestTool.ok === false) return `工具调用失败：${latestTool.name}`;
    if (latestTool.ok === true) return `工具调用完成：${latestTool.name}`;
    return `正在调用工具：${latestTool.name}`;
  }
  return step.actual?.trim() || step.action?.trim() || '正在处理...';
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

export function interruptBrowserChatSession(sessionId: string) {
  hydrateSessions();
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
      content: result.reply,
      updatedAt: finishedAt,
      stepIndexes: result.newSteps.map((step) => step.index),
      status: result.status,
    }));
    session.status = 'idle';
    session.busy = false;
    session.activeAssistantMessageId = undefined;
    session.activeAbortController = undefined;
    session.updatedAt = finishedAt;
    persistAndNotify(session.id);
  } catch (error) {
    const interrupted = abortController.signal.aborted || isAbortLikeError(error);
    if (!isActiveBrowserChatTurn(session, assistantMessageId, abortController) && interrupted) return;
    const message = error instanceof Error ? error.message : String(error);
    if (isDeadBrowserSessionError(error)) {
      await session.browser?.close().catch(() => undefined);
      session.browser = undefined;
      session.started = false;
    }
    appendLog(session, interrupted ? 'chat:run:interrupted' : 'chat:run:error', interrupted ? '本轮对话操作已中断。' : `本轮对话操作中断：${message}`);
    session.error = interrupted ? undefined : message;
    session.status = interrupted ? 'idle' : 'error';
    session.busy = false;
    session.updatedAt = now();
    updateAssistantMessage(session, assistantMessageId, (item) => ({
      ...item,
      content: interrupted ? '已中断本轮对话操作。浏览器保持当前状态，可以继续发送下一条消息。' : `执行中断：${message}`,
      updatedAt: session.updatedAt,
      status: interrupted ? 'interrupted' : 'failed',
    }));
    session.activeAssistantMessageId = undefined;
    session.activeAbortController = undefined;
    persistAndNotify(session.id);
  } finally {
    if (session.activeAbortController === abortController) session.activeAbortController = undefined;
  }
}
