import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BrowserSession, type BrowserSessionMode } from '@/server/browser/browser-session';
import { executeInteractiveBrowserTurn, type InteractiveBrowserTurnMessage } from '@/server/ai/agents/test-executor.agent';
import type { RecordedFlowStep, StepExecutionResult, TestCaseContent, TestRunRecord } from '@/server/ai/schemas/test-case.schema';
import { store } from '@/server/db/mock-store';
import { appDataRoot } from '@/server/storage/paths';

export type BrowserChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  updatedAt?: string;
  clientMessageId?: string;
  stepIndexes?: number[];
  status?: 'running' | 'passed' | 'failed' | 'blocked';
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

type BrowserChatSessionRecord = BrowserChatSessionSnapshot & {
  activeAssistantMessageId?: string;
  browser?: BrowserSession;
  started: boolean;
};

const sessions = new Map<string, BrowserChatSessionRecord>();
const sessionListeners = new Map<string, Set<(event: { sessionId: string; time: string }) => void>>();
const sessionsPath = path.join(appDataRoot(), '.data', 'browser-chat-sessions.json');
let sessionsHydrated = false;

function now() {
  return new Date().toISOString();
}

function id(prefix: string) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function notifySessionUpdate(sessionId: string) {
  const listeners = sessionListeners.get(sessionId);
  if (!listeners?.size) return;
  const event = { sessionId, time: now() };
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A broken client subscription must not interrupt the browser run.
    }
  }
}

export function subscribeBrowserChatSessionEvents(
  sessionId: string,
  listener: (event: { sessionId: string; time: string }) => void,
) {
  hydrateSessions();
  if (!sessions.has(sessionId)) return undefined;
  const listeners = sessionListeners.get(sessionId) || new Set();
  listeners.add(listener);
  sessionListeners.set(sessionId, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) sessionListeners.delete(sessionId);
  };
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

function compactText(value = '', max = 180) {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
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
      updatedAt: timestamp,
    }));
  }
  session.updatedAt = timestamp;
  persistSessions();
  notifySessionUpdate(session.id);
}

function persistSessions() {
  mkdirSync(path.dirname(sessionsPath), { recursive: true });
  const tempPath = `${sessionsPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tempPath, JSON.stringify([...sessions.values()].map((session) => snapshot(session, { fullSteps: true })), null, 2), 'utf8');
  try {
    renameSync(tempPath, sessionsPath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
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
    .map((message) => ({ role: message.role, content: message.content }));
}

async function ensureStarted(session: BrowserChatSessionRecord) {
  if (session.started && session.browser) {
    appendLog(session, 'browser:reuse', '复用当前会话已有浏览器标签');
    return session.browser;
  }
  store.applyRuntimeEnv();
  const startedAt = Date.now();
  appendLog(session, 'browser:start', '正在启动或连接浏览器');
  const browser = new BrowserSession(session.mode === 'default' ? undefined : session.mode, { isMarked: true, runId: session.id });
  session.browser = browser;
  session.started = true;
  session.status = 'running';
  session.updatedAt = now();
  persistSessions();
  await browser.start();
  appendLog(session, 'browser:ready', `浏览器已就绪，用时 ${elapsedMs(startedAt)}ms`, { elapsedMs: elapsedMs(startedAt) });
  const url = normalizeBrowserUrl(session.targetUrl);
  if (url) {
    const openStartedAt = Date.now();
    session.targetUrl = url;
    appendLog(session, 'browser:open', `正在打开目标地址：${url}`);
    await browser.open(url);
    appendLog(session, 'browser:url-ready', `目标地址已打开，用时 ${elapsedMs(openStartedAt)}ms`, { elapsedMs: elapsedMs(openStartedAt) });
  }
  session.status = 'idle';
  session.updatedAt = now();
  persistSessions();
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
  persistSessions();
  notifySessionUpdate(session.id);
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
  session.busy = false;
  session.status = 'closed';
  session.closedAt = now();
  session.updatedAt = session.closedAt;
  persistSessions();
  notifySessionUpdate(session.id);
  return snapshot(session);
}

export async function deleteBrowserChatSession(sessionId: string) {
  hydrateSessions();
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  await session.browser?.close().catch(() => undefined);
  sessions.delete(sessionId);
  persistSessions();
  notifySessionUpdate(sessionId);
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
) {
  hydrateSessions();
  const session = sessions.get(sessionId);
  if (!session) throw new Error('Browser chat session not found');
  if (session.status === 'closed') throw new Error('Browser chat session is closed');
  const text = content.trim();
  if (!text) throw new Error('Message is empty');
  const normalizedClientMessageId = clientMessageId?.trim().slice(0, 120) || undefined;
  if (normalizedClientMessageId && session.messages.some((message) => message.clientMessageId === normalizedClientMessageId)) {
    return snapshot(session);
  }
  if (session.busy) throw new Error('Browser chat session is already running');
  if (mode && !session.started && !session.steps.length && !session.messages.length) session.mode = mode;

  const timestamp = now();
  const fromStepIndex = Math.max(0, ...session.steps.map((step) => step.index)) + 1;
  const userMessage: BrowserChatMessage = {
    id: id('msg'),
    role: 'user',
    content: text,
    createdAt: timestamp,
    updatedAt: timestamp,
    clientMessageId: normalizedClientMessageId,
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
  session.busy = true;
  session.status = 'running';
  session.error = undefined;
  session.updatedAt = timestamp;
  persistSessions();
  notifySessionUpdate(session.id);
  appendLog(session, 'chat:queued', '已收到消息，准备浏览器执行');

  void runBrowserChatMessage(session, text, assistantMessage.id, fromStepIndex);
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

async function runBrowserChatMessage(session: BrowserChatSessionRecord, text: string, assistantMessageId: string, fromStepIndex: number) {
  try {
    appendLog(session, 'chat:run:start', '开始处理本轮对话操作');
    const browser = await ensureStarted(session);
    appendLog(session, 'ai:prepare', '浏览器已准备好，正在收集页面状态并请求 AI 决策');
    const result = await executeInteractiveBrowserTurn({
      session: browser,
      runId: session.id,
      targetUrl: session.targetUrl || 'about:blank',
      instruction: text,
      conversation: conversationForPrompt(session.messages),
      completedSteps: session.steps,
      mode: session.mode,
      onProgress: (step) => {
        const index = session.steps.findIndex((item) => item.index === step.index);
        if (index >= 0) session.steps[index] = { ...session.steps[index], ...step };
        else session.steps.push(step);
        session.steps.sort((a, b) => a.index - b.index);
        if (step.index >= fromStepIndex) {
          updateAssistantMessage(session, assistantMessageId, (message) => ({
            ...message,
            stepIndexes: Array.from(new Set([...(message.stepIndexes || []), step.index])).sort((a, b) => a - b),
          }));
        }
        session.updatedAt = now();
        persistSessions();
        notifySessionUpdate(session.id);
      },
      onDebug: (event) => {
        appendLog(session, event.phase, event.message, {
          stepIndex: event.stepIndex,
          elapsedMs: elapsedFromDetails(event.details),
        });
      },
    });
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
    session.updatedAt = finishedAt;
    persistSessions();
    notifySessionUpdate(session.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(session, 'chat:run:error', `本轮对话操作中断：${message}`);
    session.error = message;
    session.status = 'error';
    session.busy = false;
    session.updatedAt = now();
    updateAssistantMessage(session, assistantMessageId, (item) => ({
      ...item,
      content: `执行中断：${message}`,
      updatedAt: session.updatedAt,
      status: 'failed',
    }));
    session.activeAssistantMessageId = undefined;
    persistSessions();
    notifySessionUpdate(session.id);
  }
}
