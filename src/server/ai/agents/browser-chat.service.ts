import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { generateObject } from 'ai';
import { z } from 'zod';
import { BrowserSession, type BrowserScreencastFrame, type BrowserSessionMode, type BrowserTabSnapshot } from '@/server/browser/browser-session';
import { executeInteractiveBrowserTurn, type InteractiveBrowserTurnMessage, type InteractiveBrowserTurnResult } from '@/server/ai/agents/browser-chat-executor.agent';
import { formatSkillsForPrompt } from '@/server/ai/agents/skill-context';
import { getModel, getModelSettings } from '@/server/ai/model';
import type { RecordedFlowStep, SkillRecord, StepExecutionResult, TestCaseContent, TestRunRecord } from '@/server/ai/schemas/test-case.schema';
import { store } from '@/server/db/mock-store';
import { publishRefreshEvent } from '@/server/realtime/ws-refresh';
import { writeTextFileAtomic } from '@/server/storage/atomic-json';
import { appDataRoot, artifactPath as resolveArtifactPath } from '@/server/storage/paths';
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

export type BrowserChatConversationMemory = {
  version: 1;
  updatedAt: string;
  coveredMessageIds: string[];
  coveredStepIndexes: number[];
  latestUserGoal?: string;
  summary: string;
  userConstraints: string[];
  completed: string[];
  pending: string[];
  findings: string[];
  blockers: string[];
  decisions: string[];
  lastAssistantReply?: string;
  continuationHint?: string;
  evidenceRefs: Array<{
    type: 'message' | 'step' | 'tool' | 'ledger';
    id: string;
    note?: string;
  }>;
};

const browserChatConversationMemoryAiSchema = z.object({
  latestUserGoal: z.string().max(700).optional(),
  summary: z.string().min(1).max(2400),
  userConstraints: z.array(z.string().min(1).max(260)).max(24),
  completed: z.array(z.string().min(1).max(360)).max(36),
  pending: z.array(z.string().min(1).max(360)).max(24),
  findings: z.array(z.string().min(1).max(360)).max(36),
  blockers: z.array(z.string().min(1).max(360)).max(24),
  decisions: z.array(z.string().min(1).max(360)).max(28),
  lastAssistantReply: z.string().max(900).optional(),
  continuationHint: z.string().max(700).optional(),
  evidenceRefs: z.array(z.object({
    type: z.enum(['message', 'step', 'tool', 'ledger']),
    id: z.string().min(1).max(160),
    note: z.string().max(180).optional(),
  })).max(100),
});

export type BrowserChatSessionSnapshot = {
  id: string;
  title: string;
  userId?: string;
  targetUrl: string;
  noVncUrl?: string;
  mode: BrowserSessionMode | 'default';
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
  conversationMemory?: BrowserChatConversationMemory;
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
  sessionsHydrated: boolean;
  lastPersistWarningAt: number;
};

const browserChatRuntimeState = ((globalThis as typeof globalThis & {
  __browserChatRuntimeState?: BrowserChatRuntimeState;
}).__browserChatRuntimeState ??= {
  sessions: new Map<string, BrowserChatSessionRecord>(),
  interruptedAssistantMessageIds: new Set<string>(),
  sessionsHydrated: false,
  lastPersistWarningAt: 0,
});

const sessions = browserChatRuntimeState.sessions;
const sessionsPath = path.join(appDataRoot(), '.data', 'browser-chat-sessions.json');
const interruptedAssistantMessageIds = browserChatRuntimeState.interruptedAssistantMessageIds;
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
  return userId ? `user_${userId}` : session.id;
}

function fullLogDetails(value: unknown) {
  return { [fullLogDetailsFlag]: true, value };
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

function logDetailsFromUnknown(input: unknown) {
  const { value, full } = unwrapLogDetails(input);
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') return full ? value.trim() : trimLogText(value);
  try {
    const serialized = stringifyJsonSafe(value, 2) || String(value);
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
  const urlsFromToolContexts = steps.flatMap((step) => (step.tools || []).flatMap((tool) => [
    tool.contextBefore?.domContext?.url,
    tool.contextAfter?.domContext?.url,
  ]));
  const urlsFromOpenTools = steps.flatMap((step) => (step.tools || []).flatMap((tool) => (
    /^(openPage|openUrl)$/i.test(tool.name) ? [inputUrl(tool.input)] : []
  )));
  return firstExportableTargetUrl([
    session.targetUrl,
    browserCurrentUrl,
    ...urlsFromOpenTools,
    ...urlsFromToolContexts,
  ]);
}

function exportedRecordedToolInput(toolName: string, input: unknown, targetUrl: string) {
  if (!/^(openPage|openUrl)$/i.test(toolName)) return input;
  const url = exportableTargetUrl(inputUrl(input));
  if (url) return input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return targetUrl ? { url: targetUrl } : input;
  const { url: _url, ...rest } = input as Record<string, unknown>;
  return targetUrl ? { ...rest, url: targetUrl } : rest;
}

function compactText(value = '', max = 180) {
  const text = value.replace(/\s+/g, ' ').trim();
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

function normalizeConversationMemory(value: unknown): BrowserChatConversationMemory | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Partial<BrowserChatConversationMemory>;
  const arrayOfStrings = (items: unknown, limit: number, max = 420) => (
    Array.isArray(items)
      ? items.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => compactText(item, max)).slice(-limit)
      : []
  );
  const evidenceRefs = Array.isArray(record.evidenceRefs)
    ? record.evidenceRefs
      .filter((item): item is BrowserChatConversationMemory['evidenceRefs'][number] => (
        Boolean(item)
        && typeof item === 'object'
        && ['message', 'step', 'tool', 'ledger'].includes(String((item as { type?: unknown }).type))
        && typeof (item as { id?: unknown }).id === 'string'
      ))
      .map((item) => ({
        type: item.type,
        id: item.id,
        note: typeof item.note === 'string' ? compactText(item.note, 180) : undefined,
      }))
      .slice(-80)
    : [];
  return {
    version: 1,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : now(),
    coveredMessageIds: arrayOfStrings(record.coveredMessageIds, 300, 120),
    coveredStepIndexes: Array.isArray(record.coveredStepIndexes)
      ? record.coveredStepIndexes.filter((item): item is number => Number.isInteger(item)).slice(-300)
      : [],
    latestUserGoal: typeof record.latestUserGoal === 'string' ? compactText(record.latestUserGoal, 600) : undefined,
    summary: compactText(record.summary || '', 2400),
    userConstraints: arrayOfStrings(record.userConstraints, 24, 260),
    completed: arrayOfStrings(record.completed, 36, 360),
    pending: arrayOfStrings(record.pending, 24, 360),
    findings: arrayOfStrings(record.findings, 36, 360),
    blockers: arrayOfStrings(record.blockers, 24, 360),
    decisions: arrayOfStrings(record.decisions, 28, 360),
    lastAssistantReply: typeof record.lastAssistantReply === 'string' ? compactText(record.lastAssistantReply, 900) : undefined,
    continuationHint: typeof record.continuationHint === 'string' ? compactText(record.continuationHint, 700) : undefined,
    evidenceRefs,
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

function normalizeSkillIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean)))
    .slice(0, 8);
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

function browserChatRawHistoryMessages() {
  const raw = Number(process.env.AI_BROWSER_CHAT_RAW_HISTORY_MESSAGES || 8);
  const value = Math.floor(Number.isFinite(raw) ? raw : 8);
  return Math.min(Math.max(value, 2), 20);
}

function stableConversationMessages(messages: BrowserChatMessage[]) {
  return messages.filter((message) => (
    (message.role === 'user' || message.role === 'assistant')
    && message.status !== 'running'
    && !isTransientBrowserChatProgress(message.content)
  ));
}

function latestAssistantMessage(messages: BrowserChatMessage[], assistantMessageId?: string) {
  if (assistantMessageId) {
    const byId = messages.find((message) => message.id === assistantMessageId && message.role === 'assistant');
    if (byId) return byId;
  }
  return stableConversationMessages(messages).filter((message) => message.role === 'assistant').at(-1);
}

function browserChatMemoryMessageLimit() {
  const raw = Number(process.env.AI_BROWSER_CHAT_MEMORY_MESSAGE_LIMIT || 40);
  const value = Math.floor(Number.isFinite(raw) ? raw : 40);
  return Math.min(Math.max(value, 8), 120);
}

function browserChatMemoryStepLimit() {
  const raw = Number(process.env.AI_BROWSER_CHAT_MEMORY_STEP_LIMIT || 40);
  const value = Math.floor(Number.isFinite(raw) ? raw : 40);
  return Math.min(Math.max(value, 8), 120);
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

function compactStepForMemoryPrompt(step: StepExecutionResult) {
  return {
    index: step.index,
    status: step.status,
    action: compactText(step.action, 700),
    expected: compactText(step.expected, 700),
    actual: compactText(step.actual, 1400),
    note: compactText(step.note || '', 700) || undefined,
    findings: (step.findings || []).map((item) => compactText(item, 500)),
    memoryItems: (step.memoryItems || []).map((item) => compactText(item, 500)),
    taskFrame: step.taskFrame,
    ledgerItems: [
      ...(step.ledgerItems || []),
      ...(step.workingMemory?.ledgerItems || []),
    ],
    workingMemory: step.workingMemory ? {
      taskGoal: step.workingMemory.taskGoal,
      phase: step.workingMemory.phase,
      completed: step.workingMemory.completed,
      findings: step.workingMemory.findings,
      blockers: step.workingMemory.blockers,
      lastAction: step.workingMemory.lastAction,
      lastResult: step.workingMemory.lastResult,
      pageUnderstanding: step.workingMemory.pageUnderstanding,
      currentState: step.workingMemory.currentState,
      scrollSummary: step.workingMemory.scrollSummary,
      userConstraints: step.workingMemory.userConstraints,
      nextStep: step.workingMemory.nextStep,
    } : undefined,
    tools: (step.tools || []).map((tool, index) => ({
      index: index + 1,
      name: tool.name,
      input: tool.input,
      reason: compactText(tool.reason || '', 700) || undefined,
      ok: tool.ok,
      result: compactText(tool.result || '', 2000) || undefined,
    })),
  };
}

function buildBrowserChatConversationMemoryPrompt(
  session: BrowserChatSessionRecord,
  result: InteractiveBrowserTurnResult,
  assistantMessageId: string,
): { prompt: string; promptInput: unknown; tokenEstimate: number; coveredMessageIds: string[]; coveredStepIndexes: number[] } {
  const previous = normalizeConversationMemory(session.conversationMemory);
  const messages = stableConversationMessages(session.messages);
  const latestAssistant = latestAssistantMessage(messages, assistantMessageId);
  const selectedMessages = messages.slice(-browserChatMemoryMessageLimit()).map((message) => ({
    id: message.id,
    role: message.role,
    status: message.status,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    content: compactText(messageContentForPrompt(message), 3000),
    stepIndexes: message.stepIndexes || [],
  }));
  const selectedSteps = session.steps.slice(-browserChatMemoryStepLimit()).map(compactStepForMemoryPrompt);
  const promptInput = {
    previousMemory: previous || null,
    session: {
      id: session.id,
      title: session.title,
      targetUrl: session.targetUrl,
      mode: session.mode,
    },
    currentTurn: {
      assistantMessageId,
      status: result.status,
      reply: result.reply,
      latestAssistantReply: latestAssistant?.content || result.reply,
      newStepIndexes: result.newSteps.map((step) => step.index),
      consoleErrors: result.consoleErrors.slice(-20),
      networkErrors: result.networkErrors.slice(-20),
    },
    messages: selectedMessages,
    steps: selectedSteps,
  };
  const prompt = [
    'You are the memory summarizer for an interactive browser-chat agent.',
    'Create the next durable Conversation Memory JSON from the previous memory, the raw conversation window, and browser execution evidence.',
    '',
    'Rules:',
    '- You must synthesize semantically; do not copy long raw logs.',
    '- Preserve the latest user goal, constraints, completed work, pending work, findings, blockers, decisions, and continuation hint.',
    '- If the new evidence contradicts prior memory, prefer the new evidence and mention the correction.',
    '- Keep the memory useful for the next browser-chat turn, especially after Agent Loop limits.',
    '- Use Chinese for user-facing content when the conversation is Chinese; technical ids/tool names may stay as-is.',
    '- evidenceRefs must point to message ids, step indexes, tool ids like "12.1:fillCandidates", or ledger ids that support the memory.',
    '- Do not invent facts that are not present in the input.',
    '',
    `Input JSON:\n${stringifyJsonSafe(promptInput, 2)}`,
  ].join('\n');
  return {
    prompt,
    promptInput,
    tokenEstimate: estimateTextTokens(prompt),
    coveredMessageIds: messages.map((message) => message.id).slice(-300),
    coveredStepIndexes: session.steps.map((step) => step.index).slice(-300),
  };
}

async function generateBrowserChatConversationMemory(
  session: BrowserChatSessionRecord,
  result: InteractiveBrowserTurnResult,
  assistantMessageId: string,
  abortSignal?: AbortSignal,
): Promise<BrowserChatConversationMemory> {
  if (abortSignal?.aborted) throw abortSignal.reason || new Error('Browser-chat memory summary aborted.');
  const { provider, model } = getModelSettings();
  const built = buildBrowserChatConversationMemoryPrompt(session, result, assistantMessageId);
  appendLog(session, 'conversation:memory:request', 'Requesting AI conversation memory summary.', {
    messageId: assistantMessageId,
    details: fullLogDetails({
      provider,
      model,
      promptTokenEstimate: built.tokenEstimate,
      prompt: built.prompt,
      input: built.promptInput,
    }),
  });
  const startedAt = Date.now();
  const timeoutMs = Math.max(1000, Number(process.env.AI_BROWSER_CHAT_MEMORY_TIMEOUT_MS || process.env.AI_TEST_REQUEST_TIMEOUT_MS || 30000));
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new Error(`AI memory summary timed out after ${timeoutMs}ms`)), timeoutMs);
  const combinedSignal = abortSignal ? AbortSignal.any([abortSignal, timeoutController.signal]) : timeoutController.signal;
  try {
    const generated = await generateObject({
      model: getModel(),
      schema: browserChatConversationMemoryAiSchema,
      temperature: 0.1,
      prompt: built.prompt,
      maxRetries: 0,
      abortSignal: combinedSignal,
    });
    const memory = normalizeConversationMemory({
      ...generated.object,
      version: 1,
      updatedAt: now(),
      coveredMessageIds: built.coveredMessageIds,
      coveredStepIndexes: built.coveredStepIndexes,
    });
    if (!memory) throw new Error('AI memory summary did not match the BrowserChatConversationMemory schema.');
    appendLog(session, 'conversation:memory:response', 'AI conversation memory summary completed.', {
      messageId: assistantMessageId,
      elapsedMs: elapsedMs(startedAt),
      details: fullLogDetails({
        provider,
        model,
        elapsedMs: elapsedMs(startedAt),
        promptTokenEstimate: built.tokenEstimate,
        response: generated.object,
        memory,
      }),
    });
    return memory;
  } catch (error) {
    if (abortSignal?.aborted) throw abortSignal.reason || error;
    if (timeoutController.signal.aborted) {
      const timeoutError = new Error(`AI memory summary timed out after ${timeoutMs}ms`);
      (timeoutError as { cause?: unknown }).cause = error;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
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
    targetUrl: session.targetUrl,
    noVncUrl: browserChatNoVncUrl(session),
    mode: session.mode,
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
    conversationMemory: normalizeConversationMemory(session.conversationMemory),
  };
}

function summarySnapshot(session: BrowserChatSessionRecord): BrowserChatSessionSnapshot {
  finalizeIdleRunningAssistantMessages(session);
  return {
    id: session.id,
    title: session.title,
    userId: session.userId,
    targetUrl: session.targetUrl,
    noVncUrl: browserChatNoVncUrl(session),
    mode: session.mode,
    status: session.status,
    busy: session.busy,
    tabs: browserChatTabs(session),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    closedAt: session.closedAt,
    error: session.error,
    messages: previewMessages(session),
    steps: [],
    consoleErrors: [],
    networkErrors: [],
    logs: session.busy ? [...(session.logs || []).slice(-8)] : [],
    conversationMemory: normalizeConversationMemory(session.conversationMemory),
  };
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
  const preserveRecentRunningState = (session.busy || session.status === 'running' || options.preserveRunningState)
    && (options.preserveRunningState || isRecentTimestamp(session.updatedAt));
  const status = preserveRecentRunningState ? session.status : (session.status === 'running' ? 'idle' : session.status);
  const transientStepIndexes = new Set(
    (session.steps || [])
      .filter((step) => step.status === 'running' && isTransientBrowserChatProgress(step.actual))
      .map((step) => step.index),
  );
  const steps = (session.steps || []).filter((step) => !transientStepIndexes.has(step.index));
  const messages = (session.messages || []).map((message) => {
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
    messages,
    steps,
    conversationMemory: normalizeConversationMemory(session.conversationMemory),
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
  input: { stepIndex?: number; elapsedMs?: number; details?: unknown; messageId?: string | null } = {},
) {
  const timestamp = now();
  const runningActivity = runningActivityFromLog(phase, message);
  const details = logDetailsFromUnknown(input.details);
  const logMessageId = input.messageId === null ? undefined : input.messageId ?? session.activeAssistantMessageId;
  session.logs = [
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
  ].slice(-300);
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
  persistAndNotify(session.id);
}

function readSessionSnapshotsFromFile(): BrowserChatSessionSnapshot[] {
  if (!existsSync(sessionsPath)) return [];
  const data = JSON.parse(readFileSync(sessionsPath, 'utf8')) as unknown;
  if (!Array.isArray(data)) throw new Error('Browser chat sessions file must contain an array.');
  return data.filter((item): item is BrowserChatSessionSnapshot => (
    Boolean(item)
    && typeof item === 'object'
    && !Array.isArray(item)
    && typeof (item as { id?: unknown }).id === 'string'
  ));
}

function writeSessionSnapshotsToFile(items: BrowserChatSessionSnapshot[]) {
  const payload = stringifyJsonSafe(items, 2);
  if (!payload) throw new Error('Browser chat sessions could not be serialized.');
  writeTextFileAtomic(sessionsPath, payload);
}

function timestampValue(value?: string) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function messageTimestamp(message: BrowserChatMessage) {
  return Math.max(timestampValue(message.updatedAt), timestampValue(message.createdAt));
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
    const incomingNewer = messageTimestamp(message) >= messageTimestamp(previous);
    const merged = incomingNewer ? { ...previous, ...message } : { ...message, ...previous };
    byId.set(message.id, {
      ...merged,
      stepIndexes: mergeSortedNumbers(previous.stepIndexes, message.stepIndexes),
      attachments: incomingNewer ? message.attachments || previous.attachments : previous.attachments || message.attachments,
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
    .slice(-300);
}

function mergeConversationMemoryFromFile(
  existing?: BrowserChatConversationMemory,
  incoming?: BrowserChatConversationMemory,
) {
  if (!existing) return normalizeConversationMemory(incoming);
  if (!incoming) return normalizeConversationMemory(existing);
  return timestampValue(incoming.updatedAt) >= timestampValue(existing.updatedAt)
    ? normalizeConversationMemory(incoming)
    : normalizeConversationMemory(existing);
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
    conversationMemory: mergeConversationMemoryFromFile(existing.conversationMemory, incoming.conversationMemory),
  };
}

function applyFileSnapshotToRuntime(snapshotFromFile: BrowserChatSessionSnapshot) {
  const existing = sessions.get(snapshotFromFile.id);
  if (!existing) {
    sessions.set(snapshotFromFile.id, recordFromSnapshot(snapshotFromFile));
    return;
  }
  const preserveRuntimeTurn = shouldPreserveRuntimeTurn(existing, snapshotFromFile);
  const fromDisk = recordFromSnapshot(snapshotFromFile, { preserveRunningState: preserveRuntimeTurn });
  const runtimeState = {
    activeAbortController: preserveRuntimeTurn ? existing.activeAbortController : undefined,
    activeAssistantMessageId: preserveRuntimeTurn ? existing.activeAssistantMessageId : undefined,
    browser: existing.browser,
    started: existing.started,
  };
  Object.assign(existing, fromDisk, runtimeState);
}

function persistSessionToFile(sessionId: string) {
  try {
    const diskSnapshots = readSessionSnapshotsFromFile();
    const currentSession = sessions.get(sessionId);
    const incoming = currentSession ? snapshot(currentSession, { fullSteps: true }) : undefined;
    let writtenSnapshot: BrowserChatSessionSnapshot | undefined;
    let found = false;
    const nextSnapshots = diskSnapshots
      .map((item) => {
        if (item.id !== sessionId) return item;
        found = true;
        if (!incoming) return undefined;
        writtenSnapshot = mergeSessionSnapshotFromFile(item, incoming);
        return writtenSnapshot;
      })
      .filter((item): item is BrowserChatSessionSnapshot => Boolean(item));
    if (incoming && !found) {
      writtenSnapshot = mergeSessionSnapshotFromFile(undefined, incoming);
      nextSnapshots.push(writtenSnapshot);
    }
    writeSessionSnapshotsToFile(nextSnapshots);
    if (writtenSnapshot) applyFileSnapshotToRuntime(writtenSnapshot);
    return true;
  } catch (error) {
    warnPersistFailure(error);
    return false;
  }
}

function persistAndNotify(sessionId: string) {
  const persisted = persistSessionToFile(sessionId);
  if (!persisted) return false;
  notifySessionUpdate(sessionId);
  return true;
}

function persistDeletedSessionsToFile(sessionIds: string[]) {
  try {
    const deletedIds = new Set(sessionIds);
    const nextSnapshots = readSessionSnapshotsFromFile().filter((item) => !deletedIds.has(item.id));
    writeSessionSnapshotsToFile(nextSnapshots);
    return true;
  } catch (error) {
    warnPersistFailure(error);
    return false;
  }
}

function hydrateSessions() {
  const wasHydrated = browserChatRuntimeState.sessionsHydrated;
  browserChatRuntimeState.sessionsHydrated = true;
  try {
    const data = readSessionSnapshotsFromFile();
    const diskSessionIds = new Set<string>();
    for (const item of data) {
      diskSessionIds.add(item.id);
      const existing = sessions.get(item.id);
      if (!existing) {
        sessions.set(item.id, recordFromSnapshot(item));
        continue;
      }
      const preserveRuntimeTurn = shouldPreserveRuntimeTurn(existing, item);
      const fromDisk = recordFromSnapshot(item, { preserveRunningState: preserveRuntimeTurn });
      const runtimeState = {
        activeAbortController: preserveRuntimeTurn ? existing.activeAbortController : undefined,
        activeAssistantMessageId: preserveRuntimeTurn ? existing.activeAssistantMessageId : undefined,
        browser: existing.browser,
        started: existing.started,
      };
      Object.assign(existing, fromDisk, runtimeState);
    }
    for (const [sessionId, session] of sessions) {
      if (diskSessionIds.has(sessionId)) continue;
      if (session.activeAbortController && !session.activeAbortController.signal.aborted) {
        session.activeAbortController.abort(new Error('Browser chat session no longer exists in the session file.'));
      }
      session.activeAbortController = undefined;
      session.activeAssistantMessageId = undefined;
      session.busy = false;
      sessions.delete(sessionId);
    }
  } catch (error) {
    warnPersistFailure(error);
    if (!wasHydrated) sessions.clear();
  }
}

function conversationForPrompt(
  messages: BrowserChatMessage[],
  memory?: BrowserChatConversationMemory,
): InteractiveBrowserTurnMessage[] {
  const rawLimit = browserChatRawHistoryMessages();
  const stableMessages = stableConversationMessages(messages);
  const coveredIds = new Set(memory?.coveredMessageIds || []);
  const uncovered = stableMessages.filter((message) => !coveredIds.has(message.id)).slice(-rawLimit);
  const recent = stableMessages.slice(-rawLimit);
  const merged = new Map<string, BrowserChatMessage>();
  for (const message of [...uncovered, ...recent]) merged.set(message.id, message);
  return [...merged.values()]
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
    browserProfileKey: browserChatBrowserProfileKey(session),
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
  mode?: BrowserSessionMode | 'default';
  title?: string;
  userId?: string | number;
} = {}) {
  hydrateSessions();
  store.applyRuntimeEnv();
  const timestamp = now();
  const session: BrowserChatSessionRecord = {
    id: id('chat'),
    title: input.title?.trim() || '浏览器对话操作',
    userId: normalizeUserId(input.userId) || undefined,
    targetUrl: exportableTargetUrl(input.targetUrl || ''),
    mode: input.mode || 'visual-markers',
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
  sessions.set(session.id, session);
  persistAndNotify(session.id);
  return snapshot(session);
}

export function getBrowserChatSession(sessionId: string, userId?: string | number) {
  hydrateSessions();
  const session = sessions.get(sessionId);
  if (session && !sessionBelongsToUser(session, userId)) return undefined;
  return session ? snapshot(session) : undefined;
}

export function listBrowserChatSessions(input: { userId?: string | number } = {}) {
  hydrateSessions();
  return [...sessions.values()]
    .filter((session) => sessionBelongsToUser(session, input.userId))
    .map(summarySnapshot)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function closeBrowserChatSession(sessionId: string, userId?: string | number) {
  hydrateSessions();
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  if (!sessionBelongsToUser(session, userId)) return undefined;
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

export async function deleteBrowserChatSession(sessionId: string, userId?: string | number) {
  hydrateSessions();
  const session = sessions.get(sessionId);
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
  hydrateSessions();
  const session = sessions.get(sessionId);
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
  hydrateSessions();
  const session = sessions.get(sessionId);
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
  await session.browser?.close().catch(() => undefined);
  session.browser = undefined;
  session.started = false;
  session.activeAbortController = undefined;
  session.activeAssistantMessageId = undefined;
  sessions.delete(sessionId);
  return { deleted: { id: sessionId }, session };
}

export async function deleteBrowserChatSessions(sessionIds: string[], userId?: string | number) {
  hydrateSessions();
  const uniqueIds = Array.from(new Set(sessionIds.map((item) => item.trim()).filter(Boolean)));
  const deleted: Array<{ id: string }> = [];
  const removed: Array<{ deleted: { id: string }; session: BrowserChatSessionRecord }> = [];
  for (const sessionId of uniqueIds) {
    const session = sessions.get(sessionId);
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
  const targetUrl = exportedTargetUrl(session, selectedSteps);

  const recordedFlow: RecordedFlowStep[] = selectedSteps.flatMap((step) => (step.tools || []).map((tool, toolIndex) => ({
    index: 0,
    name: tool.name,
    input: exportedRecordedToolInput(tool.name, tool.input, targetUrl),
    reason: tool.reason,
    sourceStepIndex: step.index,
    sourceStepAction: step.action,
    sourceStepExpected: step.expected,
    sourceToolIndex: toolIndex + 1,
  }))).map((flow, index) => ({ ...flow, index: index + 1 }));

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

export function exportBrowserChatMessagesToTestCase(sessionId: string, messageIds: string[]) {
  hydrateSessions();
  const session = sessions.get(sessionId);
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
  const recordedFlow: RecordedFlowStep[] = selectedSteps.flatMap((step) => (step.tools || []).map((tool, toolIndex) => ({
    index: 0,
    name: tool.name,
    input: exportedRecordedToolInput(tool.name, tool.input, targetUrl),
    reason: tool.reason,
    sourceStepIndex: step.index,
    sourceStepAction: step.action,
    sourceStepExpected: step.expected,
    sourceToolIndex: toolIndex + 1,
  }))).map((flow, index) => ({ ...flow, index: index + 1 }));

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
    userRequirement: turnDescriptions.join('\n\n') || titleSeed,
    systemPrompt: '该用例由浏览器对话中的多轮消息导出，已包含所选轮次中 AI 实际执行过的步骤记录。',
    preconditions: ['已根据所选浏览器对话轮次完成过执行，导出时同步创建一条已完成运行记录。'],
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


export async function sendBrowserChatMessage(
  sessionId: string,
  content: string,
  mode?: BrowserSessionMode | 'default',
  clientMessageId?: string,
  attachmentsInput?: unknown,
  skillIdsInput?: unknown,
  userId?: string | number,
) {
  hydrateSessions();
  const session = sessions.get(sessionId);
  if (!session) throw new Error('Browser chat session not found');
  if (!sessionBelongsToUser(session, userId)) throw new Error('Browser chat session not found');
  if (session.status === 'closed') throw new Error('Browser chat session is closed');
  const text = content.trim();
  const attachments = normalizeAttachments(attachmentsInput);
  const skillIds = normalizeSkillIds(skillIdsInput);
  const selectedSkills = store.getSkills(skillIds).filter((skill) => skill.status === 'ready');
  if (!text && !attachments.length && !selectedSkills.length) throw new Error('Message is empty');
  const messageText = text || (selectedSkills.length ? '请结合已选择的 Skills 继续处理当前任务。' : '请结合我上传的图片继续处理当前任务。');
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

  void runBrowserChatMessage(session, messageText, assistantMessage.id, fromStepIndex, abortController, attachments, selectedSkills);
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
  if (timestamp - browserChatRuntimeState.lastPersistWarningAt < 1000) return;
  browserChatRuntimeState.lastPersistWarningAt = timestamp;
  console.warn('[browser-chat] Failed to persist sessions; keeping realtime state in memory.', error);
}

function runningAssistantActivity(step: StepExecutionResult, timestamp: string) {
  const latestTool = step.tools?.at(-1);
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
  if (phase === 'ai:runtime-input:start') return '正在准备页面上下文';
  if (phase === 'perf:runtime-input') return '正在准备页面上下文';
  if (phase === 'ai:prepare') return '正在收集页面状态';
  if (phase === 'ai:runtime:request') return '正在请求 AI 模型';
  if (phase === 'ai:runtime:response') return 'AI 已返回，正在处理结果';
  if (phase === 'ai:runtime:object') return 'AI 已返回，正在解析动作';
  if (phase === 'ai:runtime:retry') return 'AI 请求失败，正在重试';
  if (phase === 'ai:runtime:partial') return '工具已执行，正在继续判断';
  if (phase === 'ai:context-compressed') return '正在整理上下文';
  if (phase === 'ai:visual-context') return '正在更新视觉上下文';
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

async function updateBrowserChatConversationMemoryInBackground(
  session: BrowserChatSessionRecord,
  result: InteractiveBrowserTurnResult,
  assistantMessageId: string,
  abortController: AbortController,
) {
  if (abortController.signal.aborted) return;
  try {
    const nextConversationMemory = await generateBrowserChatConversationMemory(session, result, assistantMessageId, abortController.signal);
    if (abortController.signal.aborted || sessions.get(session.id) !== session) return;
    session.conversationMemory = nextConversationMemory;
    appendLog(session, 'conversation:memory:update', 'Updated browser-chat conversation memory for the next turn.', {
      messageId: assistantMessageId,
      details: fullLogDetails(session.conversationMemory),
    });
  } catch (memoryError) {
    if (abortController.signal.aborted || sessions.get(session.id) !== session) return;
    appendLog(session, 'conversation:memory:error', 'Failed to update browser-chat conversation memory; continuing without blocking the turn.', {
      messageId: assistantMessageId,
      details: errorLogDetails(memoryError),
    });
  }
}

export function interruptBrowserChatSession(sessionId: string, userId?: string | number) {
  hydrateSessions();
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  if (!sessionBelongsToUser(session, userId)) return undefined;
  const timestamp = now();
  const assistantMessageId = session.activeAssistantMessageId || latestRunningAssistantMessageId(session);
  const abortController = session.activeAbortController;
  markAssistantMessageInterrupted(assistantMessageId);
  if (abortController && !abortController.signal.aborted) {
    abortController.abort(new Error('Browser chat operation interrupted by user.'));
  } else if (assistantMessageId) {
    appendLog(session, 'chat:interrupt:controller-missing', 'Interrupt requested, but the active AbortController was not available; stale runtime writes will be ignored by message id.', {
      details: { assistantMessageId },
    });
  }
  if (assistantMessageId) {
    updateAssistantMessage(session, assistantMessageId, (message) => ({
      ...message,
      content: '已中断本轮对话操作。浏览器保持当前状态，可以继续发送下一条消息。',
      updatedAt: timestamp,
      status: 'interrupted',
      activity: undefined,
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
  if (!persistAndNotify(session.id)) {
    throw new Error('Browser chat interrupt state could not be persisted.');
  }
  return snapshot(session);
}

async function runBrowserChatMessage(
  session: BrowserChatSessionRecord,
  text: string,
  assistantMessageId: string,
  fromStepIndex: number,
  abortController: AbortController,
  attachments: BrowserChatAttachment[],
  skills: SkillRecord[] = [],
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
      conversation: conversationForPrompt(session.messages, session.conversationMemory),
      conversationMemory: normalizeConversationMemory(session.conversationMemory),
      completedSteps: session.steps,
      mode: session.mode,
      referenceImagePaths,
      skillContext: formatSkillsForPrompt(skills),
      abortSignal: abortController.signal,
      shouldContinue: () => isActiveBrowserChatTurn(session, assistantMessageId, abortController),
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
        persistAndNotify(session.id);
      },
      onDebug: (event) => {
        if (!isActiveBrowserChatTurn(session, assistantMessageId, abortController)) return;
        appendLog(session, event.phase, event.message, {
          stepIndex: event.stepIndex,
          elapsedMs: elapsedFromDetails(event.details),
          details: event.details,
        });
      },
    });
    if (!isActiveBrowserChatTurn(session, assistantMessageId, abortController)) return;
    appendLog(session, 'chat:run:saving', '正在写入本轮对话最终结果');
    session.steps = result.steps;
    session.consoleErrors = result.consoleErrors;
    session.networkErrors = result.networkErrors;
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
    session.status = 'idle';
    session.busy = false;
    session.activeAssistantMessageId = undefined;
    session.activeAbortController = undefined;
    session.updatedAt = completedAt;
    session.logs = [
      ...(session.logs || []),
      {
        id: id('log'),
        time: completedAt,
        phase: 'chat:run:done',
        message: '本轮对话操作已完成，最终结果已写入。',
        messageId: assistantMessageId,
      },
    ].slice(-300);
    persistAndNotify(session.id);
    void updateBrowserChatConversationMemoryInBackground(session, result, assistantMessageId, abortController);
  } catch (error) {
    const stillActive = isActiveBrowserChatTurn(session, assistantMessageId, abortController);
    const interrupted = abortController.signal.aborted || interruptedAssistantMessageIds.has(assistantMessageId);
    if (!stillActive) return;
    const message = userFacingErrorMessage(error);
    const details = errorLogDetails(error);
    if (isDeadBrowserSessionError(error)) {
      await session.browser?.close().catch(() => undefined);
      session.browser = undefined;
      session.started = false;
    }
    appendLog(
      session,
      interrupted ? 'chat:run:interrupted' : 'chat:run:error',
      interrupted ? '用户主动中断了本轮对话。' : `本轮对话异常：${message}`,
      { details },
    );
    session.error = interrupted ? undefined : message;
    session.status = interrupted ? 'idle' : 'error';
    session.busy = false;
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
    if (session.activeAbortController === abortController) session.activeAbortController = undefined;
  }
}
