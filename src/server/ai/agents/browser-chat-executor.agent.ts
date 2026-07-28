import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { generateText, hasToolCall, tool, type ModelMessage } from 'ai';
import sharp from 'sharp';
import { z } from 'zod';
import type { AiRequestSnapshot, AiToolContextSnapshot, RecordedFlowStep, RuntimeWorkingMemory, StepExecutionResult, StepToolCall, TaskFrame, TaskLedgerItem, VisualFrameRecord } from '@/server/ai/schemas/test-case.schema';
import { getModel, getModelSettings } from '@/server/ai/model';
import { buildCodexObjectPrompt, customRuntimePromptFromEnv } from '@/server/ai/prompts/runtime-agent.prompt';
import { BrowserSession, type BrowserActionResult, type BrowserSessionMode, type ScreenshotCaptureMode } from '@/server/browser/browser-session';
import { analyzeBrowserCodeRisk, type BrowserCodeCredentialBinding } from '@/server/browser/browser-code-runner';
import { richTextToPlainText } from '@/lib/rich-text';
import { browserChatReplyClaimsBrowserAction, browserChatToolRequirement, type BrowserChatToolRequirement } from './browser-chat-intent';
import { racePromiseWithAbort } from './browser-chat-interrupt-state';
import {
  BROWSER_CHAT_FILE_READ_MAX_CHARS,
  BROWSER_CHAT_FILE_READ_MIN_CHARS,
  normalizeBrowserChatFileReadLimit,
} from './browser-chat-file-read';
import { downloadFileArtifact, formatFileArtifactResult, generateMarkdownArtifact } from './file-artifact-tools';
import { browserChatCodeRules } from './runtime-prompt-rules';
import { summarizeRuntimeLogTimings } from './runtime-log-timings';
import { cloneRuntimeRetryState, type RuntimeRetryState as RuntimeRetryStateBase } from './runtime-retry-state';
import { runtimeAllowedToolTypes } from './runtime-tool-selection';
import {
  isEffectiveToolTraceFailure,
  notifyRuntimeToolTrace,
  runtimeToolTraceId,
} from './runtime-tool-trace';

type ExecutionDebug = (event: { phase: string; message: string; stepIndex?: number; details?: unknown }) => void | Promise<void>;
type RuntimeModelMessage = ModelMessage;
type RuntimeRetryState = RuntimeRetryStateBase<RuntimeModelMessage>;

type ToolTrace = {
  id?: string;
  name: string;
  input: unknown;
  result?: BrowserActionResult;
  recovered?: boolean;
  transient?: boolean;
  startedAt?: number;
  completedAt?: number;
  elapsedMs?: number;
  actionElapsedMs?: number;
  postprocessTimings?: Record<string, number>;
  contextBefore?: AiToolContextSnapshot;
  contextAfter?: AiToolContextSnapshot;
  visualAfter?: VisualAfterPolicy;
  screenshots?: Array<{
    title: string;
    path: string;
    kind?: 'current' | 'history' | 'pinned' | 'after' | 'marker' | 'original' | 'other';
  }>;
};

type ToolTraceProgress = {
  workingMemory: RuntimeWorkingMemory;
  visualContext: ReturnType<VisualContextManager['snapshot']>;
};

type VisualAfterPolicy = {
  capture?: 'auto' | 'viewport' | 'fullPage';
  retention?: 'auto' | 'replace' | 'append';
  reason?: string;
};


type BrowserChatSafetyMode = 'strict' | 'full';

export type BrowserToolConfirmationDecision = 'confirmed' | 'cancelled';

export type BrowserToolConfirmationRequest = {
  toolName: string;
  input: unknown;
  reason?: string;
  prompt: string;
  stepIndex?: number;
};

export type BrowserChatSubagentTask = {
  title: string;
  instruction: string;
  url?: string;
};

export type BrowserChatSubagentRunner = (
  tasks: BrowserChatSubagentTask[],
  abortSignal?: AbortSignal,
  toolCallId?: string,
) => Promise<BrowserActionResult>;

export type BrowserChatSubagentReader = (
  uuid: string,
) => Promise<BrowserActionResult>;

type RuntimeDecision = {
  action: string;
  expected: string;
  actual: string;
  status: 'passed' | 'failed' | 'blocked';
  done: boolean;
  note?: string;
  observation?: string;
  findings?: string[];
  memoryItems?: string[];
  taskFrame?: TaskFrame;
  ledgerItems?: TaskLedgerItem[];
};

type BrowserChatRuntimeRecord = {
  description: string;
  targetUrl: string;
  systemPrompt: string;
};

type BrowserChatOperationalContext = {
  operationalContext: string;
  credentialBindings?: BrowserCodeCredentialBinding[];
};

const codexRuntimeObjectSchema = z.object({
  type: z.string().min(1).describe('Tool type to execute. Use reportState when the requirement is complete, blocked, impossible, or only needs a no-op status update.'),
  message: z.string().nullable().optional().describe('Optional short Chinese progress text that must match the selected tool.'),
  params: z.object({
    reason: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    urlOrPath: z.string().nullable().optional(),
    text: z.string().nullable().optional(),
    content: z.string().nullable().optional(),
    fileName: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    capture: z.enum(['viewport', 'fullPage']).nullable().optional(),
    path: z.string().nullable().optional(),
    maxMs: z.number().nullable().optional(),
    action: z.string().nullable().optional(),
    expected: z.string().nullable().optional(),
    actual: z.string().nullable().optional(),
    status: z.enum(['passed', 'failed', 'blocked']).nullable().optional(),
    done: z.boolean().nullable().optional(),
    limit: z.number().nullable().optional(),
    ids: z.array(z.string()).nullable().optional(),
    selectionReason: z.string().nullable().optional(),
    sameInterfaceGroup: z.string().nullable().optional(),
    requiresConfirmation: z.boolean().nullable().optional(),
    confirmationMessage: z.string().nullable().optional(),
    code: z.string().nullable().optional(),
    maxOutputChars: z.number().nullable().optional(),
  }).describe('Parameters for the selected tool. Include only keys needed by that tool plus a concise reason.'),
});
type CodexRuntimeObject = z.infer<typeof codexRuntimeObjectSchema>;

// 判断当前模型配置是否支持图片输入；这只是模型能力判断，不代表一定会发送截图。
function modelSupportsScreenshotInput() {
  if (process.env.SEND_SCREENSHOT_TO_AI === 'true') return true;
  if (process.env.SEND_SCREENSHOT_TO_AI === 'false') return false;

  const { provider, model: configuredModel } = getModelSettings();
  const model = configuredModel.toLowerCase();
  return provider !== 'deepseek' && !model.startsWith('deepseek');
}

function browserModeFromEnv(): BrowserSessionMode {
  return 'dom';
}

function browserModeOf(): BrowserSessionMode {
  return browserModeFromEnv();
}


function toolContextFromAiRequest(aiRequest?: AiRequestSnapshot): AiToolContextSnapshot | undefined {
  if (!aiRequest?.id) return undefined;
  return {
    requestId: aiRequest.id,
    requestCreatedAt: aiRequest.createdAt,
  };
}

// 是否启用视觉候选标识。关闭时仍发送截图，但候选元素只以文本摘要进入 prompt。

// Default to inline marker labels so visual mode screenshots show interactive targets.

// 只有视觉点击模式才允许把截图作为 AI 输入；DOM 模式即使模型支持图片也不会发送。

// 将调试数据转成可安全 JSON 序列化的结构，避免 Buffer/BigInt 破坏持久化。
function jsonSafe(value: unknown) {
  if (value === undefined) return undefined;
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (typeof item === 'function' || typeof item === 'symbol') return undefined;
    if (item instanceof Error) {
      return {
        name: item.name,
        message: item.message,
        stack: item.stack,
      };
    }
    if (Buffer.isBuffer(item)) return `[Buffer ${item.length} bytes]`;
    if (item instanceof ArrayBuffer) return `[ArrayBuffer ${item.byteLength} bytes]`;
    if (ArrayBuffer.isView(item)) return `[${item.constructor.name || 'TypedArray'} ${(item as ArrayBufferView).byteLength} bytes]`;
    if (item && typeof item === 'object') {
      if (seen.has(item)) return '[Circular]';
      seen.add(item);
    }
    return item;
  });
  return serialized ? JSON.parse(serialized) : serialized;
}

function aiScreenshotMaxBytes() {
  const raw = process.env.AI_SCREENSHOT_MAX_KB || '';
  const kb = Number(raw);
  if (!Number.isFinite(kb) || kb <= 0) return undefined;
  return Math.max(1, Math.floor(kb * 1024));
}

async function compressScreenshotForAi(buffer: Buffer, maxBytes: number) {
  if (buffer.length <= maxBytes) return buffer;

  const metadata = await sharp(buffer, { failOn: 'none' }).rotate().metadata();
  const originalWidth = metadata.width || 0;
  const originalHeight = metadata.height || 0;
  const qualities = [80, 65, 50, 35, 25];
  let best = buffer;

  async function render(width: number | undefined, quality: number) {
    const pipeline = width
      ? sharp(buffer, { failOn: 'none' }).rotate().resize({ width, withoutEnlargement: true })
      : sharp(buffer, { failOn: 'none' }).rotate();
    return pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
  }

  for (const quality of qualities) {
    const output = await render(undefined, quality);
    if (output.length < best.length) best = output;
    if (output.length <= maxBytes) return output;
  }

  if (!originalWidth || !originalHeight) return best;

  let scale = Math.sqrt(maxBytes / Math.max(best.length, 1)) * 0.92;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const width = Math.max(320, Math.floor(originalWidth * Math.max(0.18, Math.min(0.9, scale))));
    const output = await render(width, attempt < 4 ? 45 : 32);
    if (output.length < best.length) best = output;
    if (output.length <= maxBytes) return output;
    if (width <= 320) return best;
    scale *= Math.sqrt(maxBytes / Math.max(output.length, 1)) * 0.9;
  }

  return best;
}

async function readScreenshotForAi(filePath: string) {
  const buffer = await readFile(filePath);
  const maxBytes = aiScreenshotMaxBytes();
  if (!maxBytes) return buffer;
  return compressScreenshotForAi(buffer, maxBytes).catch(() => buffer);
}

// 纯标识图必须跟随原图最终发送尺寸缩放，否则两张图经过压缩后会失去像素对齐关系。

function trimDebugText(value: string, max = 4000) {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function looksLikeDomSnapshot(value?: string) {
  const text = (value || '').trim();
  return Boolean(text && /\buid=\d+\s+(?:RootWebArea|button|link|textbox|combobox|StaticText)\b/.test(text));
}

function providerToolSchemaError(value?: string) {
  return /Failed to deserialize the JSON body|unknown variant `?custom`?|invalid_request_error|AnthropicException|litellm\.BadRequestError/i.test(value || '');
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  const numberValue = typeof value === 'number' ? value : Number(value);
  const normalized = Number.isFinite(numberValue) ? Math.floor(numberValue) : fallback;
  return Math.min(Math.max(normalized, min), max);
}

function runtimeRequestConsecutiveFailureLimit() {
  return boundedInteger(process.env.AI_RUNTIME_REQUEST_RETRY_ATTEMPTS, 3, 1, 10);
}

function upstreamApiDisconnectReason(value?: string) {
  const text = value || '';
  const apiMatch = text.match(/Cannot connect to API:\s*([^\n]+)/i);
  if (apiMatch?.[1]) return apiMatch[1].trim();
  const genericMatch = text.match(/(?:other side closed|socket hang up|ECONNRESET|connection (?:closed|reset|terminated)|fetch failed)/i);
  return genericMatch?.[0];
}

function aiRequestFromError(error: unknown) {
  if (!error || typeof error !== 'object') return undefined;
  return (error as { aiRequest?: AiRequestSnapshot }).aiRequest;
}

function runtimeRetryFromError(error: unknown) {
  if (!error || typeof error !== 'object') return undefined;
  const retry = (error as { runtimeRetry?: unknown }).runtimeRetry;
  if (!retry || typeof retry !== 'object' || Array.isArray(retry)) return undefined;
  const record = retry as Record<string, unknown>;
  const retryAttempts = Number(record.retryAttempts);
  const maxRetryAttempts = Number(record.maxRetryAttempts);
  const consecutiveFailures = Number(record.consecutiveFailures ?? retryAttempts);
  const consecutiveFailureLimit = Number(record.consecutiveFailureLimit ?? maxRetryAttempts);
  if (!Number.isFinite(consecutiveFailures) || !Number.isFinite(consecutiveFailureLimit)) return undefined;
  return {
    consecutiveFailures: Math.max(0, Math.floor(consecutiveFailures)),
    consecutiveFailureLimit: Math.max(1, Math.floor(consecutiveFailureLimit)),
  };
}

function diagnosticValueText(value: unknown, max = 900) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.trim() ? trimDebugText(value.trim(), max) : undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return trimDebugText(JSON.stringify(value), max);
  } catch {
    return trimDebugText(String(value), max);
  }
}

function aiRequestBrief(aiRequest?: AiRequestSnapshot) {
  if (!aiRequest) return undefined;
  const agentStepIndex = aiRequest.options?.agentStepIndex;
  return [
    aiRequest.id ? `requestId=${aiRequest.id}` : '',
    aiRequest.provider ? `provider=${aiRequest.provider}` : '',
    aiRequest.model ? `model=${aiRequest.model}` : '',
    `stepIndex=${aiRequest.stepIndex}`,
    typeof agentStepIndex === 'number' ? `agentStep=${agentStepIndex}` : '',
  ].filter(Boolean).join(', ');
}

function upstreamDisconnectLines(
  reason: string,
  text: string,
  context?: { error?: unknown; aiRequest?: AiRequestSnapshot },
) {
  const error = context?.error;
  const aiRequest = context?.aiRequest || aiRequestFromError(error);
  const requestBrief = aiRequestBrief(aiRequest);
  const retryInfo = runtimeRetryFromError(error);
  const code = firstErrorString(error, 'code');
  const status = firstErrorValue(error, 'status') ?? firstErrorValue(error, 'statusCode');
  const causeMessage = errorCauseMessage(error);
  const responseBody = firstErrorDisplay(error, 'responseBody', 1200)
    || firstErrorDisplay(error, 'body', 1200)
    || firstErrorDisplay(error, 'data', 1200);
  const technical = [
    code ? `code=${code}` : '',
    status !== undefined ? `status=${diagnosticValueText(status, 120)}` : '',
    causeMessage ? `cause=${trimDebugText(causeMessage, 600)}` : '',
    responseBody ? `responseBody=${responseBody}` : '',
  ].filter(Boolean).join('; ');
  const raw = trimDebugText(text, 1200);
  const lines = [
    `网关返回原因：${reason}`,
    requestBrief ? `请求信息：${requestBrief}` : '',
    retryInfo ? `重试信息：连续失败 ${retryInfo.consecutiveFailures} 次，达到上限 ${retryInfo.consecutiveFailureLimit} 次；仍然失败。` : '',
    technical ? `技术细节：${technical}` : '',
    raw ? `原始错误：${raw}` : '',
  ].filter(Boolean);
  if (!code && status === undefined && !causeMessage && !responseBody) {
    lines.push('补充：上游只返回了连接被对端关闭，未返回 HTTP 状态码或响应体。');
  }
  return lines;
}

function userFacingInfrastructureError(value?: string, context?: { error?: unknown; aiRequest?: AiRequestSnapshot }) {
  const text = value || '';
  const upstreamReason = upstreamApiDisconnectReason(text);
  if (upstreamReason) {
    return [
      '上游 AI 服务连接已断开。',
      ...upstreamDisconnectLines(upstreamReason, text, context),
      '本轮操作已停止，当前页面状态已保留。',
    ].join('\n');
  }
  if (providerToolSchemaError(text)) return 'AI 模型请求失败：当前模型网关不兼容本轮工具调用格式，已保留页面状态并准备继续。';
  if (/Request aborted|operation interrupted/i.test(text)) return '本轮 AI 请求被中断，未继续写入技术错误。';
  if (/timed out|timeout/i.test(text)) return 'AI 请求超时，已保留当前页面状态并准备继续。';
  if (/No capacity available|rate limit/i.test(text)) return 'AI 服务暂时不可用，已保留当前页面状态并准备继续。';
  return 'AI 请求或响应处理失败，已保留当前页面状态并准备继续。';
}

function userFacingToolResult(name: string, result?: BrowserActionResult, _max = 360) {
  void _max;
  if (!result) return undefined;
  if (!result.ok && providerToolSchemaError(result.actual)) return userFacingInfrastructureError(result.actual);
  if (name === 'downloadFile' || name === 'generateMarkdownFile') return formatFileArtifactResult(name, result.actual);
  return result.actual;
}

function compactToolResultForModel(
  name: string,
  result: BrowserActionResult,
): BrowserActionResult {
  const modelResult = { ...result };
  delete modelResult.referenceImagePath;
  delete modelResult.referenceImagePaths;
  if (!modelResult.actual) return modelResult;
  const fileResult = modelResult.ok ? formatFileArtifactResult(name, modelResult.actual) : undefined;
  if (fileResult) return { ...modelResult, actual: fileResult };
  return modelResult;
}

function elapsedSince(startedAt: number) {
  return Date.now() - startedAt;
}

// 拆分工具参数和 AI 给出的调用原因，便于历史步骤里单独展示。
function splitToolInputAndReason(input: unknown) {
  const safeInput = jsonSafe(input);
  if (!safeInput || typeof safeInput !== 'object' || Array.isArray(safeInput)) {
    return { input: safeInput, reason: undefined };
  }
  const { reason, requiresConfirmation, confirmationMessage, ...rest } = safeInput as Record<string, unknown>;
  void requiresConfirmation;
  void confirmationMessage;
  const compactInput = Object.keys(rest).length ? rest : undefined;
  return {
    input: compactInput,
    reason: typeof reason === 'string' && reason.trim() ? trimDebugText(reason.trim(), 300) : undefined,
  };
}

function toolConfirmationFromInput(toolName: string, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  if (record.requiresConfirmation !== true) return undefined;
  const reason = typeof record.reason === 'string' ? trimDebugText(record.reason.trim(), 300) : undefined;
  const explicit = typeof record.confirmationMessage === 'string' ? record.confirmationMessage.trim() : '';
  const prompt = trimDebugText(
    explicit || `请确认是否执行工具 ${toolName}${reason ? `：${reason}` : ''}`,
    300,
  );
  return { prompt, reason };
}

function browserCodeInputWithRisk<T extends Record<string, unknown>>(input: T, strictSafety: boolean) {
  if (!strictSafety || typeof input.code !== 'string') return input;
  const risk = analyzeBrowserCodeRisk(input.code);
  if (!risk.requiresConfirmation || input.requiresConfirmation === true) return input;
  return {
    ...input,
    requiresConfirmation: true,
    confirmationMessage: `即将执行可能产生重要影响的浏览器代码：${risk.reasons.join('；')}`,
  };
}

function parseJsonObjectText(text?: string) {
  const trimmed = (text || '').trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('```')) return undefined;
  try {
    const parsed = extractJson(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function toolNameLike(value?: string) {
  if (!value) return false;
  const names = new Set<string>(runtimeToolNames('dom'));
  return names.has(value);
}

function cleanDisplayText(value?: string) {
  const trimmed = (value || '').replace(/\s+/g, ' ').trim();
  if (!trimmed || /^无$|^none$/i.test(trimmed)) return undefined;
  if (looksLikeDomSnapshot(trimmed)) return undefined;
  if (parseJsonObjectText(trimmed)) return undefined;
  return trimmed;
}

function readableTextFromToolRecord(record: Record<string, unknown>, options: { reportState?: boolean } = {}) {
  const preferredKeys = options.reportState
    ? ['action', 'actual', 'reason']
    : ['reason', 'targetVisual', 'action', 'actual'];
  for (const key of preferredKeys) {
    const value = typeof record[key] === 'string' ? cleanDisplayText(record[key] as string) : undefined;
    if (!value || toolNameLike(value)) continue;
    return value;
  }
  return undefined;
}

function readableActionFromRawText(value?: string, options: { reportState?: boolean } = {}) {
  const parsed = parseJsonObjectText(value);
  if (parsed) return readableTextFromToolRecord(parsed, options);
  const cleaned = cleanDisplayText(value);
  if (!cleaned || toolNameLike(cleaned)) return undefined;
  return cleaned;
}

function readableActionFromTrace(trace?: ToolTrace, options: { reportState?: boolean } = {}) {
  if (!trace?.input || typeof trace.input !== 'object' || Array.isArray(trace.input)) return undefined;
  return readableTextFromToolRecord(trace.input as Record<string, unknown>, options);
}

function toolConsistentAssistantText(value: string | undefined, toolName?: string) {
  void toolName;
  return readableActionFromRawText(value) || '';
}

function alignCodexRuntimeObjectTool(object: CodexRuntimeObject, allowedTypes: string[]) {
  void allowedTypes;
  return object;
}

function browserChatAbortError(signal?: AbortSignal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new Error('Browser chat operation interrupted by user.');
}

function isBrowserChatAbortError(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return true;
  const text = error instanceof Error ? `${error.name}\n${error.message}` : String(error || '');
  return /Browser chat (?:operation interrupted|session (?:closed|deleted)) by user|operation interrupted by user/i.test(text);
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw browserChatAbortError(signal);
}

function throwIfStopped(signal?: AbortSignal, shouldContinue?: () => boolean) {
  throwIfAborted(signal);
  if (shouldContinue && !shouldContinue()) throw browserChatAbortError(signal);
}

// 为每次 AI 请求加超时保护，避免模型长时间无响应导致整次执行卡死。
function generateTextTimeoutMs(options: Parameters<typeof generateText>[0]) {
  void options;
  const raw = Number(process.env.AI_TEST_REQUEST_TIMEOUT_MS || 30000);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 30000;
}

async function generateTextWithTimeout(options: Parameters<typeof generateText>[0], timeoutOverrideMs?: number) {
  throwIfAborted(options.abortSignal);
  // A native Agent Loop includes tool execution time. In particular,
  // spawnSubagents must remain awaited until every child finishes, so an
  // elapsed wall-clock timeout must never start a second main-Agent attempt.
  if (typeof (options as { prepareStep?: unknown }).prepareStep === 'function') {
    const upstream = options.abortSignal;
    return racePromiseWithAbort(generateText(options), upstream);
  }
  const timeoutMs = Number.isFinite(timeoutOverrideMs) && Number(timeoutOverrideMs) > 0
    ? Math.floor(Number(timeoutOverrideMs))
    : generateTextTimeoutMs(options);
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new Error(`AI request timed out after ${timeoutMs}ms`)), timeoutMs);
  const upstream = options.abortSignal;
  const abortSignal = upstream ? AbortSignal.any([upstream, timeoutController.signal]) : timeoutController.signal;
  let stopAbortWatch = () => {};
  const abortPromise = new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      if (upstream?.aborted) {
        reject(browserChatAbortError(upstream));
        return;
      }
      if (timeoutController.signal.aborted) {
        reject(timeoutController.signal.reason || new Error(`AI request timed out after ${timeoutMs}ms`));
        return;
      }
      reject(browserChatAbortError(upstream));
    };
    abortSignal.addEventListener('abort', onAbort, { once: true });
    stopAbortWatch = () => abortSignal.removeEventListener('abort', onAbort);
    if (abortSignal.aborted) onAbort();
  });
  try {
    return await Promise.race([
      generateText({ ...options, abortSignal }),
      abortPromise,
    ]);
  } catch (error) {
    if (isBrowserChatAbortError(error, upstream)) throw browserChatAbortError(upstream);
    if (timeoutController.signal.aborted && !upstream?.aborted) {
      const timeoutError = new Error(`AI request timed out after ${timeoutMs}ms`);
      (timeoutError as { cause?: unknown }).cause = error;
      throw timeoutError;
    }
    throw error;
  } finally {
    stopAbortWatch();
    clearTimeout(timer);
  }
}

// 从模型回复中提取 JSON，兼容模型把 JSON 包在 markdown 代码块里的情况。
function extractJson(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced?.[1] || text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('AI did not return JSON.');
  return JSON.parse(raw.slice(start, end + 1));
}

// 将测试需求富文本转为纯文本，作为执行器理解目标的主输入。
function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function codexRuntimeObjectFromText(text: string, fallbackType: 'answer' | 'reportState' = 'reportState'): CodexRuntimeObject {
  let raw: Record<string, unknown> | undefined;
  try {
    raw = recordFromUnknown(extractJson(text));
  } catch {
    const fallbackText = trimDebugText((text || '').trim() || 'Codex did not return a valid action JSON.', 2000);
    return {
      type: fallbackType,
      message: fallbackText,
      params: {
        content: fallbackText,
        actual: fallbackText,
        status: fallbackType === 'reportState' ? 'blocked' : undefined,
        done: fallbackType === 'reportState' ? true : undefined,
      },
    };
  }

  const rawRecord = raw || {};
  const params = recordFromUnknown(rawRecord.params);
  const candidate = {
    type: typeof rawRecord.type === 'string' && rawRecord.type.trim() ? rawRecord.type.trim() : fallbackType,
    message: typeof rawRecord.message === 'string' && rawRecord.message.trim() ? rawRecord.message.trim() : undefined,
    params,
  };
  const parsed = codexRuntimeObjectSchema.safeParse(candidate);
  return parsed.success ? parsed.data : candidate as CodexRuntimeObject;
}

function requirementOf(runtimeRecord: BrowserChatRuntimeRecord) {
  return richTextToPlainText(runtimeRecord.description) || runtimeRecord.description;
}

function systemPromptOf(runtimeRecord: BrowserChatRuntimeRecord) {
  return richTextToPlainText(runtimeRecord.systemPrompt || '').trim();
}

// 将浏览器工具调用轨迹压缩为步骤证据，保存到运行历史中。
const browserChatDefaultSystemPrompt = 'This is an interactive browser chat. Operate from the live page and answer the latest user message in Chinese.';

function browserChatSystemPromptForRuntime(value: string) {
  return value.replace(browserChatDefaultSystemPrompt, '').trim();
}

function summarizeToolTraces(traces: ToolTrace[]): StepToolCall[] {
  return traces.map((trace) => {
    const { input, reason } = splitToolInputAndReason(trace.input);
    return {
      id: trace.id,
      name: trace.name,
      input,
      reason,
      ok: trace.result?.ok,
      recovered: trace.recovered,
      transient: trace.transient,
      result: userFacingToolResult(trace.name, trace.result, 360),
      rawResult: trace.result,
      contextBefore: trace.contextBefore,
      contextAfter: trace.contextAfter,
      visualAfter: trace.visualAfter,
      screenshots: trace.screenshots,
    };
  });
}

function upsertToolTrace(traces: ToolTrace[], trace: ToolTrace) {
  const index = trace.id ? traces.findIndex((item) => item.id === trace.id) : -1;
  if (index >= 0) traces[index] = trace;
  else traces.push(trace);
}

function concise(value?: string, max = 220) {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function basenameOfPath(value?: string) {
  return value ? value.split(/[\\/]/).filter(Boolean).at(-1) || value : '';
}

function formatCurrentToolAttemptSummary(traces: ToolTrace[], limit = 5) {
  const recent = traces.slice(-limit);
  if (!recent.length) return '[none]';
  return recent.map((trace, index) => {
    const { reason } = splitToolInputAndReason(trace.input);
    const fileResult = trace.result?.ok ? formatFileArtifactResult(trace.name, trace.result.actual) : undefined;
    const status = !trace.result
      ? 'running'
      : trace.result.ok
        ? fileResult ? `ok: ${sanitizeHistoricalToolText(fileResult, 260)}` : 'ok'
        : `failed: ${sanitizeHistoricalToolText(trace.result.actual, 180)}`;
    const shots = trace.screenshots?.length ? `; screenshots=${trace.screenshots.length}` : '';
    const why = reason ? `; reason=${sanitizeHistoricalToolText(reason, 140)}` : '';
    return `${index + 1}. ${trace.name}: ${status}${why}${shots}`;
  }).join('\n');
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

function agentStepLabel(stepIndex: number) {
  return String(stepIndex + 1);
}

function continuationSummaryMessageHistory(modelMessages: unknown) {
  const record = modelMessages && typeof modelMessages === 'object' && !Array.isArray(modelMessages)
    ? modelMessages as Record<string, unknown>
    : {};
  const messages = Array.isArray(record.messages) ? record.messages : [];
  return JSON.stringify({ messages }, null, 2);
}

function continuationRuntimeState(memory: RuntimeWorkingMemory) {
  return {
    completed: memory.completed,
    findings: memory.findings,
    blockers: memory.blockers,
    userConstraints: memory.userConstraints,
    pageUnderstanding: memory.pageUnderstanding,
    currentState: memory.currentState,
    lastAction: memory.lastAction,
    lastResult: memory.lastResult,
    nextStep: memory.nextStep,
  };
}

function buildContinuationSummaryPrompt(input: {
  goal: string;
  browserMode: BrowserSessionMode;
  stepIndex: number;
  agentStep: number;
  estimatedTokens: number;
  thresholdTokens: number;
  modelMessages: unknown;
  workingMemory: RuntimeWorkingMemory;
}) {
  const serializedMessages = continuationSummaryMessageHistory(input.modelMessages);
  return [
    'You are compressing a WebPilot browser-agent loop so the SAME user request can continue in a fresh model context.',
    'Return concise JSON only. Do not use markdown.',
    '',
    'Required JSON shape:',
    '{ "goal": string, "completed": string[], "currentPage": string, "confirmedFacts": string[], "negativeResults": string[], "failedAttempts": string[], "importantEvidence": string[], "openObservations": string[], "remaining": string[], "nextStep": string }',
    '',
    'Rules:',
    '- Preserve stable Playwright locator intent and the exact structured evidence returned by browserCode when it materially affects the next action.',
    '- Preserve tool results that materially affect the next action.',
    '- Preserve current URL/page state, blockers, manual verification state, and user constraints.',
    '- Preserve every completed search/query and its observed result. If a query had no result, put the exact query and outcome in negativeResults; do not schedule that same query again unless the user changed it or new evidence contradicts it.',
    '- Merge the previousContinuationSummary with the newest evidence. The authoritative runtime state below is produced after the latest completed tool call and wins on conflict.',
    '- Do not include raw screenshots, candidate coordinates, full DOM dumps, long logs, or old tool parameter JSON unless essential.',
    '- Write Chinese for user-facing summaries when possible.',
    '',
    `Goal: ${input.goal}`,
    `Executor step: ${input.stepIndex}`,
    `Agent step before compression: ${input.agentStep}`,
    `Browser mode: ${input.browserMode}`,
    `Estimated model-context tokens: ${input.estimatedTokens}/${input.thresholdTokens}`,
    '',
    `Authoritative current runtime state JSON:\n${JSON.stringify(continuationRuntimeState(input.workingMemory), null, 2)}`,
    '',
    `Complete message history JSON (backend did not truncate or select excerpts):\n${serializedMessages}`,
  ].join('\n');
}

function fallbackContinuationSummary(input: {
  goal: string;
  browserMode: BrowserSessionMode;
  stepIndex: number;
  agentStep: number;
  traces: ToolTrace[];
  workingMemory: RuntimeWorkingMemory;
}) {
  return JSON.stringify({
    goal: input.goal,
    browserMode: input.browserMode,
    executorStep: input.stepIndex,
    agentStepBeforeCompression: input.agentStep,
    completed: input.workingMemory.completed,
    currentPage: input.workingMemory.currentState || input.workingMemory.pageUnderstanding || '',
    importantEvidence: input.workingMemory.findings,
    confirmedFacts: input.workingMemory.findings,
    negativeResults: [],
    failedAttempts: [],
    openObservations: [],
    remaining: input.workingMemory.nextStep ? [input.workingMemory.nextStep] : [],
    nextStep: input.workingMemory.nextStep || 'Continue from the latest live browser state.',
    recentToolAttempts: formatCurrentToolAttemptSummary(input.traces, 5),
  }, null, 2);
}

function estimateTextTokens(text: string) {
  let ascii = 0;
  let nonAscii = 0;
  for (const char of text) {
    if (char.charCodeAt(0) <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4 + nonAscii);
}

function imageTokenEstimatePerImage() {
  return Math.max(0, Number(process.env.AI_IMAGE_CONTEXT_ESTIMATE_TOKENS || 1200));
}

function isInfrastructureNoise(value?: string) {
  if (!value) return false;
  return /No capacity available|Request aborted|Active browser page has been closed|Execution context was destroyed|ECONNRESET|ETIMEDOUT|timeout|rate limit|model .*server|Failed after \d+ attempts/i.test(value)
    || providerToolSchemaError(value);
}

function sanitizeHistoricalToolText(value: unknown, max = 180) {
  if (typeof value !== 'string') return '';
  return concise(
    value
      .replace(/\b(?:candidate|Candidate)\s*#?\s*\d+\b/g, 'current screenshot target')
      .replace(/候选\s*\d+/g, '当前截图中的目标标识')
      .replace(/\b(?:areaId|id|fromId|toId)\s*=\s*["']?[^,\s)]+/gi, '$1=[current]')
      .replace(/\bS\d+\b/g, '当前截图中的滚动区域')
      .replace(/\bbox=\d+,\d+,\d+x\d+/gi, '')
      .replace(/\bat\s*\(\d+\s*,\s*\d+\)/gi, 'at the visible center')
      .replace(/\b(deltaX|deltaY|x|y)\s*=\s*-?\d+(?:\.\d+)?/gi, '$1=[current]')
      .replace(/\s+/g, ' ')
      .trim(),
    max,
  );
}

function defaultVisualAfterForTool(name: string): VisualAfterPolicy {
  void name;
  return { capture: 'auto', retention: 'replace' };
}

function browserChatDomScreenshotsEnabled() {
  return process.env.BROWSER_CHAT_DOM_SCREENSHOTS === 'true';
}

function sanitizeVisualAfterRetention(retention: unknown, fallback: VisualAfterPolicy['retention']) {
  if (typeof retention !== 'string') return fallback;
  if (retention === 'auto' || retention === 'replace' || retention === 'append') return retention;
  return fallback;
}

const noVisualAfterCaptureToolNames = new Set<string>();

function visualAfterFromInput(name: string, input: unknown): VisualAfterPolicy {
  const fallback = defaultVisualAfterForTool(name);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fallback;
  const raw = (input as Record<string, unknown>).visualAfter;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
  const visualAfter = raw as Record<string, unknown>;
  const capture = typeof visualAfter.capture === 'string' && ['auto', 'viewport', 'fullPage'].includes(visualAfter.capture)
    ? visualAfter.capture as VisualAfterPolicy['capture']
    : fallback.capture;
  return {
    capture,
    retention: sanitizeVisualAfterRetention(visualAfter.retention, fallback.retention),
    reason: typeof visualAfter.reason === 'string' ? visualAfter.reason : undefined,
  };
}

function shouldCaptureVisualAfter(name: string, visualAfter: VisualAfterPolicy) {
  if (!browserChatDomScreenshotsEnabled()) return false;
  if (visualAfter.capture === 'viewport' || visualAfter.capture === 'fullPage') return true;
  return !noVisualAfterCaptureToolNames.has(name);
}

function screenshotOptionsFromVisualAfter(visualAfter: VisualAfterPolicy): { capture: ScreenshotCaptureMode } {
  if (visualAfter.capture === 'fullPage') return { capture: 'fullPage' };
  return { capture: 'viewport' };
}

function summarizeTraceForMemory(trace: ToolTrace) {
  const input = trace.input && typeof trace.input === 'object' && !Array.isArray(trace.input)
    ? trace.input as Record<string, unknown>
    : {};
  const { reason } = splitToolInputAndReason(input);
  const semanticAction = [
    typeof input.action === 'string' ? input.action : '',
    reason || '',
    typeof input.targetVisual === 'string' ? input.targetVisual : '',
    typeof input.expected === 'string' ? input.expected : '',
  ].map((item) => item.trim()).find((item): item is string => Boolean(item));
  const displayResult = userFacingToolResult(trace.name, trace.result, trace.result?.ok ? 160 : 180);
  const result = !trace.result
    ? 'running'
    : trace.result.ok
    ? sanitizeHistoricalToolText(displayResult, 160) || 'ok'
    : `failed: ${sanitizeHistoricalToolText(displayResult || trace.result.actual, 180)}`;
  return [
    `上一动作：${trace.name}${semanticAction ? ` - ${sanitizeHistoricalToolText(semanticAction, 180)}` : ''}`,
    `结果：${result}`,
  ].join('；');
}

function toolTraceStatus(trace: ToolTrace) {
  if (!trace.result) return 'started';
  return trace.result.ok ? 'ok' : 'failed';
}

function updateWorkingMemoryFromTrace(memory: RuntimeWorkingMemory, trace: ToolTrace, sourceStep?: number) {
  void sourceStep;
  const next: RuntimeWorkingMemory = { ...memory };
  const displayResult = userFacingToolResult(trace.name, trace.result, 400);
  const resultText = sanitizeHistoricalToolText(displayResult || '', 400);
  next.lastAction = summarizeTraceForMemory(trace);
  next.lastResult = concise(displayResult || trace.result?.actual || '工具调用已开始，正在等待页面反馈。', 240);
  if (resultText) {
    next.pageUnderstanding = resultText;
    next.currentState = concise(`${trace.name}: ${resultText}`, 260);
  }
  if (isEffectiveToolTraceFailure(trace)) {
    next.blockers = Array.from(new Set([...next.blockers, concise(trace.result?.actual || '', 220)])).slice(-8);
  }
  if (trace.name === 'reportState') {
    next.phase = '正在汇报当前状态或最终结论';
  } else {
    next.phase = '正在执行网页操作并等待页面反馈';
  }
  next.nextStep = trace.name === 'reportState' ? '根据报告状态决定是否结束' : '根据当前截图继续完成任务';
  return next;
}

class VisualContextManager {
  private frames: VisualFrameRecord[] = [];
  private currentId?: string;
  private sequence = 0;

  constructor(private readonly maxHistory = Number(process.env.AI_VISUAL_HISTORY_LIMIT || 6)) {}

  init(frame: Omit<VisualFrameRecord, 'id' | 'role' | 'createdAt'>) {
    const record = this.createFrame(frame, 'current');
    this.frames = [record];
    this.currentId = record.id;
    return record;
  }

  apply(frame: Omit<VisualFrameRecord, 'id' | 'role' | 'createdAt'>, policy: VisualAfterPolicy) {
    const retention = policy.retention === 'append' ? 'append' : 'replace';
    if (retention === 'append') {
      this.demoteCurrent();
      const record = this.createFrame(frame, 'current');
      this.frames.push(record);
      this.currentId = record.id;
      this.trim();
      return record;
    }
    this.demoteCurrent();
    const record = this.createFrame(frame, 'current');
    this.frames = [...this.frames.filter((item) => item.role === 'pinned'), record];
    this.currentId = record.id;
    this.trim();
    return record;
  }

  manage(action: 'clearHistory' | 'keepLatestOnly' | 'pinCurrent' | 'compressScrollSequence', reason: string) {
    if (action === 'clearHistory') {
      this.frames = this.frames.filter((frame) => frame.id === this.currentId || frame.role === 'pinned');
    } else if (action === 'keepLatestOnly') {
      this.frames = this.frames.filter((frame) => frame.id === this.currentId);
    } else if (action === 'pinCurrent') {
      this.frames = this.frames.map((frame) => frame.id === this.currentId ? { ...frame, role: 'pinned', reason } : frame);
    } else if (action === 'compressScrollSequence') {
      const scrollFrames = this.frames.filter((frame) => frame.group === 'scroll-sequence' && frame.id !== this.currentId);
      const keep = new Set(scrollFrames.slice(-2).map((frame) => frame.id));
      this.frames = this.frames.filter((frame) => frame.group !== 'scroll-sequence' || frame.id === this.currentId || keep.has(frame.id) || frame.role === 'pinned');
    }
    this.trim();
  }

  compressForBudget(reason: string) {
    const beforeCount = this.frames.length;
    const current = this.current();
    const historyLimit = Math.max(0, Number(process.env.AI_VISUAL_COMPRESSED_HISTORY_LIMIT || 2));
    const pinnedLimit = Math.max(0, Number(process.env.AI_VISUAL_COMPRESSED_PINNED_LIMIT || 2));
    const keep = new Map<string, VisualFrameRecord>();
    for (const frame of this.frames.filter((item) => item.role !== 'pinned' && item.id !== this.currentId).slice(-historyLimit)) {
      keep.set(frame.id, { ...frame, reason: frame.reason || reason });
    }
    for (const frame of this.frames.filter((item) => item.role === 'pinned').slice(-pinnedLimit)) {
      keep.set(frame.id, { ...frame, reason: frame.reason || reason });
    }
    if (current) keep.set(current.id, { ...current, reason: current.reason || reason });
    this.frames = Array.from(keep.values());
    this.trim();
    return Math.max(0, beforeCount - this.frames.length);
  }

  current() {
    return this.frames.find((frame) => frame.id === this.currentId);
  }

  snapshot() {
    return {
      current: this.current(),
      history: this.frames.filter((frame) => frame.id !== this.currentId),
    };
  }

  renderText() {
    const current = this.current();
    const history = this.frames.filter((frame) => frame.id !== this.currentId);
    const frameSummary = (frame: VisualFrameRecord) => (
      `${frame.id} ${concise(frame.reason, 80)} image=${basenameOfPath(frame.path)}${frame.originalPath ? ` original=${basenameOfPath(frame.originalPath)}` : ''}${frame.markerPath ? ` marker=${basenameOfPath(frame.markerPath)}` : ''}${frame.capture ? ` capture=${frame.capture}` : ''}`
    );
    return [
      'Visual Context Manager:',
      `current: ${current ? frameSummary(current) : '[none]'}`,
      'current 是唯一允许使用编号进行点击、输入、hover、drag 定位的截图。',
      history.length
        ? `history 仅供参考，不能使用其中编号操作：\n${history.map((frame) => `- ${frameSummary(frame)} role=${frame.role} group=${frame.group || '-'}`).join('\n')}`
        : 'history: [none]',
    ].join('\n');
  }

  imagePaths(historyLimit = Number(process.env.AI_VISUAL_ATTACHED_HISTORY_LIMIT || 0)) {
    const paths: string[] = [];
    const current = this.current();
    if (current) paths.push(current.path);
    if (current?.markerPath) paths.push(current.markerPath);
    const history = this.frames.filter((item) => item.id !== this.currentId).slice(-Math.max(0, historyLimit));
    for (const frame of history) {
      paths.push(frame.path);
      if (frame.markerPath) paths.push(frame.markerPath);
    }
    return paths;
  }

  private createFrame(frame: Omit<VisualFrameRecord, 'id' | 'role' | 'createdAt'>, role: VisualFrameRecord['role']) {
    this.sequence += 1;
    return {
      ...frame,
      id: `vf-${this.sequence}`,
      role,
      createdAt: new Date().toISOString(),
    };
  }

  private demoteCurrent() {
    this.frames = this.frames.map((frame) => frame.id === this.currentId && frame.role === 'current'
      ? { ...frame, role: 'history' }
      : frame);
  }

  private trim() {
    const pinned = this.frames.filter((frame) => frame.role === 'pinned');
    const current = this.current();
    const history = this.frames
      .filter((frame) => frame.role !== 'pinned' && frame.id !== this.currentId)
      .slice(-this.maxHistory);
    this.frames = [...history, ...pinned, ...(current ? [current] : [])];
  }
}

function pushBeforeFrameScreenshots(screenshots: ToolTrace['screenshots'], name: string, frame?: VisualFrameRecord) {
  if (!frame?.path) return;
  screenshots?.push({ title: `${name} before`, path: frame.path, kind: 'history' });
  if (frame.originalPath) screenshots?.push({ title: `${name} before original`, path: frame.originalPath, kind: 'original' });
  if (frame.markerPath) screenshots?.push({ title: `${name} before marker map`, path: frame.markerPath, kind: 'marker' });
}

function pushFailureFrameScreenshots(screenshots: ToolTrace['screenshots'], name: string, frame?: VisualFrameRecord) {
  if (!frame?.path) return;
  screenshots?.push({ title: `${name} failure evidence`, path: frame.path, kind: 'other' });
  if (frame.originalPath) screenshots?.push({ title: `${name} failure original`, path: frame.originalPath, kind: 'original' });
  if (frame.markerPath) screenshots?.push({ title: `${name} marker map`, path: frame.markerPath, kind: 'marker' });
}

function createToolTrace(input: {
  traces: ToolTrace[];
  name: string;
  toolInput: unknown;
  aiRequest?: AiRequestSnapshot;
  runId?: string;
  stepIndex?: number;
  visualContext?: VisualContextManager;
}) {
  const { traces, name, toolInput, aiRequest, runId, stepIndex, visualContext } = input;
  const screenshots: ToolTrace['screenshots'] = [];
  if (browserChatDomScreenshotsEnabled()) pushBeforeFrameScreenshots(screenshots, name, visualContext?.current());
  const visualAfter = browserChatDomScreenshotsEnabled() ? visualAfterFromInput(name, toolInput) : undefined;
  const traceId = runtimeToolTraceId({ runId, stepIndex, traceIndex: traces.length + 1 });
  const trace: ToolTrace = {
    id: traceId,
    name,
    input: toolInput,
    startedAt: Date.now(),
    contextBefore: toolContextFromAiRequest(aiRequest),
    visualAfter,
    screenshots,
  };
  traces.push(trace);
  return trace;
}

async function finalizeToolTraceVisuals(input: {
  session: BrowserSession;
  traces: ToolTrace[];
  trace: ToolTrace;
  result: BrowserActionResult;
  runId?: string;
  stepIndex?: number;
  visualContext?: VisualContextManager;
  abortSignal?: AbortSignal;
  shouldContinue?: () => boolean;
  onDebug?: ExecutionDebug;
  onVisualContextChange?: (snapshot: ReturnType<VisualContextManager['snapshot']>) => void | Promise<void>;
}) {
  const { session, traces, trace, runId, stepIndex, visualContext, abortSignal, shouldContinue, onDebug, onVisualContextChange } = input;
  throwIfStopped(abortSignal, shouldContinue);
  let result = input.result;
  const screenshots = trace.screenshots || [];
  const emittedImagePaths = result.referenceImagePaths?.length
    ? result.referenceImagePaths
    : result.referenceImagePath ? [result.referenceImagePath] : [];
  for (const [index, imagePath] of emittedImagePaths.entries()) {
    if (!screenshots.some((item) => item.path === imagePath)) {
      screenshots.push({ title: `${trace.name} code image ${index + 1}`, path: imagePath, kind: 'current' });
    }
  }
  const visualAfter = trace.visualAfter || defaultVisualAfterForTool(trace.name);

  if (result.ok && shouldCaptureVisualAfter(trace.name, visualAfter) && runId && stepIndex !== undefined && visualContext) {
    try {
      throwIfStopped(abortSignal, shouldContinue);
      const visualIndex = traces.filter((item) => item.screenshots?.some((shot) => shot.kind === 'current')).length + 1;
      const screenshotOptions = screenshotOptionsFromVisualAfter(visualAfter);
      const screenshotStartedAt = Date.now();
      const screenshotPath = await session.takeScreenshot(runId, stepIndex, `visual-${visualIndex}`, screenshotOptions);
      throwIfStopped(abortSignal, shouldContinue);
      const timingSummary = session.formatLastScreenshotTiming();
      await onDebug?.({
        phase: 'browser:screenshot:visual-after',
        stepIndex,
        message: `${trace.name} visual-after screenshot captured in ${elapsedSince(screenshotStartedAt)}ms${timingSummary ? ` ${timingSummary}` : ''}`,
        details: {
          elapsedMs: elapsedSince(screenshotStartedAt),
          path: screenshotPath,
          capture: screenshotOptions.capture,
          toolName: trace.name,
          timings: session.getLastScreenshotTiming(),
        },
      });
      const markerPath = session.getLastCandidateMarkerScreenshotPath();
      const originalPath = session.getLastOriginalScreenshotPath();
      const frame = visualContext.apply({
        path: screenshotPath,
        originalPath,
        markerPath,
        stepIndex,
        toolName: trace.name,
        capture: screenshotOptions.capture,
        reason: visualAfter.reason || `${trace.name} after screenshot`,
      }, visualAfter);
      screenshots.push({ title: `${trace.name} ${screenshotOptions.capture} after`, path: screenshotPath, kind: frame.role === 'pinned' ? 'pinned' : 'current' });
      if (originalPath) screenshots.push({ title: `${trace.name} ${screenshotOptions.capture} after original`, path: originalPath, kind: 'original' });
      if (markerPath) screenshots.push({ title: `${trace.name} marker map`, path: markerPath, kind: 'marker' });
      await onVisualContextChange?.(visualContext.snapshot());
    } catch (error) {
      if (abortSignal?.aborted || (shouldContinue && !shouldContinue())) throw browserChatAbortError(abortSignal);
      result = {
        ...result,
        actual: `${result.actual} Visual-after screenshot failed, so the action is kept and will not be retried: ${infrastructureError(error)}`,
      };
    }
  } else if (!result.ok && visualContext) {
    pushFailureFrameScreenshots(screenshots, trace.name, visualContext.current());
  }

  trace.result = result;
  trace.screenshots = screenshots;
  return result;
}

async function executeTracedBrowserAction(input: {
  session: BrowserSession;
  traces: ToolTrace[];
  name: string;
  toolInput: unknown;
  action: (abortSignal?: AbortSignal, trace?: ToolTrace) => Promise<BrowserActionResult>;
  aiRequest?: AiRequestSnapshot;
  runId?: string;
  stepIndex?: number;
  visualContext?: VisualContextManager;
  abortSignal?: AbortSignal;
  shouldContinue?: () => boolean;
  onDebug?: ExecutionDebug;
  onToolTrace?: (trace: ToolTrace) => void | Promise<void>;
  onVisualContextChange?: (snapshot: ReturnType<VisualContextManager['snapshot']>) => void | Promise<void>;
}) {
  const { session, traces, name, toolInput, action, aiRequest, runId, stepIndex, visualContext, abortSignal, shouldContinue, onDebug, onToolTrace, onVisualContextChange } = input;
  throwIfStopped(abortSignal, shouldContinue);
  const trace = createToolTrace({ traces, name, toolInput, aiRequest, runId, stepIndex, visualContext });
  const postprocessTimings: Record<string, number> = {};
  trace.postprocessTimings = postprocessTimings;
  let postprocessStartedAt = Date.now();
  await notifyRuntimeToolTrace(onToolTrace, trace);
  postprocessTimings.notifyStartMs = elapsedSince(postprocessStartedAt);
  throwIfStopped(abortSignal, shouldContinue);

  let result: BrowserActionResult;
  const actionStartedAt = Date.now();
  try {
    result = await action(abortSignal, trace);
    throwIfStopped(abortSignal, shouldContinue);
  } catch (error) {
    if (abortSignal?.aborted || (shouldContinue && !shouldContinue())) throw browserChatAbortError(abortSignal);
    result = {
      ok: false,
      actual: `Tool ${name} threw after execution started: ${infrastructureError(error)}`,
    };
  }
  trace.actionElapsedMs = elapsedSince(actionStartedAt);

  throwIfStopped(abortSignal, shouldContinue);
  trace.result = result;
  postprocessStartedAt = Date.now();
  await notifyRuntimeToolTrace(onToolTrace, trace);
  postprocessTimings.notifyResultMs = elapsedSince(postprocessStartedAt);
  throwIfStopped(abortSignal, shouldContinue);
  postprocessStartedAt = Date.now();
  result = await finalizeToolTraceVisuals({
    session,
    traces,
    trace,
    result,
    runId,
    stepIndex,
    visualContext,
    abortSignal,
    shouldContinue,
    onDebug,
    onVisualContextChange,
  });
  postprocessTimings.visualAfterMs = elapsedSince(postprocessStartedAt);
  throwIfStopped(abortSignal, shouldContinue);
  trace.completedAt = Date.now();
  trace.elapsedMs = trace.startedAt ? trace.completedAt - trace.startedAt : undefined;
  postprocessStartedAt = Date.now();
  await notifyRuntimeToolTrace(onToolTrace, trace);
  postprocessTimings.notifyCompleteMs = elapsedSince(postprocessStartedAt);
  trace.completedAt = Date.now();
  trace.elapsedMs = trace.startedAt ? trace.completedAt - trace.startedAt : undefined;
  return result;
}

function makeBrowserTools(
  session: BrowserSession,
  traces: ToolTrace[],
  aiRequest?: AiRequestSnapshot,
  onToolTrace?: (trace: ToolTrace) => void | Promise<void>,
  referenceOptions?: {
    runId?: string;
    stepIndex?: number;
    allowedToolTypes?: string[];
    visualContext?: VisualContextManager;
    toolExecutionGate?: { stepNumber: number; executed: boolean };
    getAiRequest?: () => AiRequestSnapshot | undefined;
    abortSignal?: AbortSignal;
    shouldContinue?: () => boolean;
    onDebug?: ExecutionDebug;
    onVisualContextChange?: (snapshot: ReturnType<VisualContextManager['snapshot']>) => void | Promise<void>;
    requestToolConfirmation?: (request: BrowserToolConfirmationRequest) => Promise<BrowserToolConfirmationDecision>;
    runSubagents?: BrowserChatSubagentRunner;
    readSubagent?: BrowserChatSubagentReader;
    readFile?: (input: { attachmentId?: string; artifactId?: string; limit?: number; offset?: number }) => Promise<BrowserActionResult>;
    onReadFileImage?: (input: { path: string }) => void;
    ensureBrowserStarted?: () => Promise<void>;
    credentialBindings?: BrowserCodeCredentialBinding[];
    getCredentialBindings?: () => BrowserCodeCredentialBinding[] | undefined;
  },
) {
  // Enforce one executed browser tool per model step. The native AI SDK loop may call the model
  // multiple times inside one user turn, so prepareStep resets this gate before each LLM call.
  // If a single model response emits several tool calls, only the first one can produce side
  // effects; the following calls receive an ignored result and the model can continue from the
  // fresh tool result in the next step.
  const toolExecutionGate = referenceOptions?.toolExecutionGate || { stepNumber: 0, executed: false };
  const toolTextRule = 'Do not include old tool params, candidate ids as business meaning, coordinates, screenshot ids/file names, or tool input JSON.';
  const toolReasonInput = z.string().min(1).max(300).describe(`Required: concise Chinese reason for this exact tool call. Name the visible target and expected page change; do not merely repeat a candidate ID. ${toolTextRule}`);
  const toolContextShape = {
    reason: toolReasonInput,
    requiresConfirmation: z.boolean().optional().describe('Browser chat strict safety mode only: set true when this important tool call must pause for user confirm/cancel before execution. Do not use this in full safety mode.'),
    confirmationMessage: z.string().min(1).max(300).optional().describe('Browser chat strict safety mode only: concise Chinese text shown next to the tool confirm/cancel buttons.'),
  };
  const browserToolInput = <T extends z.ZodRawShape>(shape: T) => z.object({ ...toolContextShape, ...shape });
  async function record(name: string, input: unknown, action: (abortSignal?: AbortSignal, trace?: ToolTrace) => Promise<BrowserActionResult>) {
    throwIfStopped(referenceOptions?.abortSignal, referenceOptions?.shouldContinue);
    if (toolExecutionGate.executed) {
      // Do not execute or trace extra calls; just tell the model to stop. This keeps the recorded
      // step clean (one real action) and avoids any duplicate side effect.
      return {
        ok: false,
        actual: `Ignored: only one browser tool can execute in model step ${toolExecutionGate.stepNumber + 1}. Continue from the executed tool result in the next model step.`,
      } satisfies BrowserActionResult;
    }
    toolExecutionGate.executed = true;
    const pendingConfirmation = referenceOptions?.requestToolConfirmation ? toolConfirmationFromInput(name, input) : undefined;
    let browserActionExecuted = false;
    const actionWithConfirmation = async (actionSignal?: AbortSignal, trace?: ToolTrace) => {
      if (pendingConfirmation && referenceOptions?.requestToolConfirmation) {
        const decision = await referenceOptions.requestToolConfirmation({
          toolName: name,
          input,
          reason: pendingConfirmation.reason,
          prompt: pendingConfirmation.prompt,
          stepIndex: referenceOptions.stepIndex,
        });
        throwIfStopped(referenceOptions?.abortSignal, referenceOptions?.shouldContinue);
        if (decision !== 'confirmed') {
          return {
            ok: true,
            actual: 'Skipped before execution because the user cancelled this confirmed tool call. Do not retry the same operation in this turn unless the user explicitly asks again.',
          } satisfies BrowserActionResult;
        }
        if (toolRequiresBrowserSession(name)) await referenceOptions?.ensureBrowserStarted?.();
        browserActionExecuted = true;
        const result = await action(actionSignal, trace);
        // This becomes the native tool-result message for the next model step
        // and is also retained by working-memory/continuation compression.
        // A confirmation log alone is UI state and is not model context.
        return {
          ...result,
          actual: `用户已确认本次工具调用，现已执行。\n${result.actual}`,
        } satisfies BrowserActionResult;
      }
      if (toolRequiresBrowserSession(name)) await referenceOptions?.ensureBrowserStarted?.();
      browserActionExecuted = true;
      return action(actionSignal, trace);
    };
    const traceVisualContext = referenceOptions?.visualContext;
    return executeTracedBrowserAction({
      session,
      traces,
      name,
      toolInput: input,
      runId: referenceOptions?.runId,
      stepIndex: referenceOptions?.stepIndex,
      visualContext: traceVisualContext,
      abortSignal: referenceOptions?.abortSignal,
      shouldContinue: referenceOptions?.shouldContinue,
      aiRequest: referenceOptions?.getAiRequest?.() || aiRequest,
      onDebug: referenceOptions?.onDebug,
      onToolTrace,
      onVisualContextChange: traceVisualContext ? referenceOptions?.onVisualContextChange : undefined,
      action: actionWithConfirmation,
    }).then(async (result) => {
      void browserActionExecuted;
    const imagePaths = result.referenceImagePaths?.length
      ? result.referenceImagePaths
      : result.referenceImagePath ? [result.referenceImagePath] : [];
    for (const path of new Set(imagePaths)) referenceOptions?.onReadFileImage?.({ path });
    return compactToolResultForModel(name, result);
    });
  }

  const sharedTools = {
    browserCode: tool({
      description: 'Execute one ordinary JavaScript cell against the real Playwright page/context in a persistent isolated Node-backed kernel. This is the primary browser inspection, screenshot, and operation entrypoint. Every result automatically includes a fresh full semantic DOM snapshot, page-console delta, and code-console output. Use top-level await, nodeRepl.write(value) for JSON, and nodeRepl.emitImage(await page.screenshot(...)) for visual evidence. Coordinate clicks require the model to inspect a viewport screenshot returned by the previous cell; same-cell screenshot-and-click is rejected. When the prompt supplies a credential reference, credentialVault.fill(locator, ref) securely fills the real Playwright locator without returning the raw value. Locator actions have a 3000ms default timeout and navigation has a 30000ms default timeout; force: true and scripted DOM clicks are forbidden, and a failed operation ends only the current cell and preserves kernel bindings.',
      inputSchema: browserToolInput({
        code: z.string().min(1).max(40_000).describe('Ordinary JavaScript cell for the persistent kernel. Use page/context or browser/tab directly with top-level await. Emit JSON with nodeRepl.write(...) and screenshots with await nodeRepl.emitImage(await page.screenshot(...)). Prefer top-level var or fresh binding names because bindings persist. Do not write a function wrapper, module, export, or Markdown fences.'),
        maxOutputChars: z.number().int().min(1_000).max(50_000).optional().describe('Maximum serialized return size. Defaults to 20000 characters.'),
      }),
      execute: (input) => {
        const normalizedInput = browserCodeInputWithRisk(input, Boolean(referenceOptions?.requestToolConfirmation));
        return record('browserCode', normalizedInput, (abortSignal) => session.executeBrowserCode({
          code: normalizedInput.code,
          maxOutputChars: normalizedInput.maxOutputChars,
          credentials: referenceOptions?.getCredentialBindings?.() || referenceOptions?.credentialBindings,
          runId: referenceOptions?.runId || 'browser-code',
          stepIndex: referenceOptions?.stepIndex || 0,
          abortSignal,
        }));
      },
    }),
    clickByUid: tool({
      description: 'Click exactly one rendered element using its exact UID from the latest automatically returned semantic DOM snapshot. Use only when a normal visible Playwright locator cannot uniquely identify the target. The runtime rejects stale, hidden, disabled, detached, or covered UIDs. Never invent or reuse an older UID.',
      inputSchema: browserToolInput({
        uid: z.string().min(1).max(160).describe('Exact UID copied from the latest automatic DOM snapshot.'),
      }),
      execute: (input) => record('clickByUid', input, (abortSignal) => session.mouse({
        action: 'click',
        uid: input.uid,
        abortSignal,
      })),
    }),
    waitForHumanVerification: tool({
      description: 'Immediately pause for the user to complete a visible CAPTCHA, OTP, QR-code scan, login/security check, identity confirmation, or other credential/device-owned verification in the non-headless browser. Use this proactively whenever live page evidence shows such a blocker, or required credentials were not explicitly supplied. Do not try to solve, bypass, guess, or merely describe the verification in assistant text.',
      inputSchema: browserToolInput({
        maxMs: z.number().optional().describe('Maximum wait time in milliseconds. Defaults to MANUAL_VERIFICATION_TIMEOUT_MS or 180000.'),
      }),
      execute: (input) => record('waitForHumanVerification', input, () => session.waitForManualVerification(input.maxMs)),
    }),
    ...(referenceOptions?.runSubagents ? {
      spawnSubagents: tool({
        description: 'Run several independent research or testing tasks concurrently with full browser-agent tools. The main Agent strictly waits for the original batch barrier, including retries. This returns one backend-maintained UUID per child, never the child content. Read child results one at a time in later model steps with readSubagent. One child failure does not cancel its siblings.',
        inputSchema: browserToolInput({
          tasks: z.array(z.object({
            title: z.string().min(1).max(160).describe('Short Chinese display name for this child Agent.'),
            instruction: z.string().min(1).max(4_000).describe('Self-contained task and expected evidence for this child Agent.'),
            url: z.string().url().max(4_000).optional().describe('Optional independent page or PRD entry URL.'),
          })).min(1).max(6),
        }),
        execute: (input) => record('spawnSubagents', input, (abortSignal, trace) => referenceOptions.runSubagents!(input.tasks, abortSignal, trace?.id)),
      }),
    } : {}),
    ...(referenceOptions?.readSubagent ? {
      readSubagent: tool({
        description: 'Read exactly one completed child Agent result. Call this once per child UUID in separate model steps. Failed children still return any partial summary they produced.',
        inputSchema: browserToolInput({
          uuid: z.string().uuid().describe('One child Agent UUID returned by spawnSubagents.'),
        }),
        execute: (input) => record('readSubagent', input, () => referenceOptions.readSubagent!(input.uuid)),
      }),
    } : {}),
    ...(referenceOptions?.readFile ? {
      readFile: tool({
        description: 'Read one registered file on demand. User attachments are listed with attachmentId; downloaded/generated artifacts return an Artifact ID. Use exactly one of attachmentId or artifactId. On the first read, omit offset and limit to read the first 20000 characters. Every text read returns at least 20000 characters. Continue only from the exact next offset returned by the previous read. Supports text, PDF, Word, Excel, PowerPoint, OpenDocument, ZIP listings, images, and extensible format detection. For an image, the tool attaches it to the next model request for visual understanding instead of returning image bytes as text.',
        inputSchema: browserToolInput({
          attachmentId: z.string().min(1).max(160).optional().describe('One uploaded-file ID listed in the conversation metadata.'),
          artifactId: z.string().min(1).max(4_000).optional().describe('One Artifact ID returned by downloadFile or generateMarkdownFile.'),
          offset: z.number().int().min(0).optional().describe('Zero-based character offset. Omit for the first segment.'),
          limit: z.number().int().min(BROWSER_CHAT_FILE_READ_MIN_CHARS).max(BROWSER_CHAT_FILE_READ_MAX_CHARS).optional().describe('Returned character count, from 20000 to 40000. Omit to read 20000 characters.'),
        }).refine((input) => Boolean(input.attachmentId) !== Boolean(input.artifactId), { message: 'Provide exactly one of attachmentId or artifactId.' }),
        execute: (input) => {
          const normalizedInput = { ...input, limit: normalizeBrowserChatFileReadLimit(input.limit) };
          return record('readFile', normalizedInput, () => referenceOptions.readFile!(normalizedInput));
        },
      }),
    } : {}),
    downloadFile: tool({
      description: 'Download a file into the configured local output directory or this run artifacts. Pass an absolute URL, an origin-relative path starting with / resolved against the current page origin, or a page-relative path resolved against the current page directory. Use this when the user asks to download/save a file; include the returned download target as a clickable Markdown link in the final answer.',
      inputSchema: browserToolInput({
        url: z.string().optional().describe('Absolute download URL. If omitted, path or urlOrPath is used.'),
        path: z.string().optional().describe('Download path. /files/a.pdf resolves against current page origin; report/a.pdf resolves against current page directory.'),
        urlOrPath: z.string().optional().describe('Absolute URL, origin-relative path, or page-relative path to download.'),
        fileName: z.string().optional().describe('Optional saved file name, including extension when known.'),
      }),
      execute: (input) => record('downloadFile', input, () => downloadFileArtifact({ ...input, runId: referenceOptions?.runId, sourcePageUrl: session.currentUrl() })),
    }),
    generateMarkdownFile: tool({
      description: 'Create a Markdown .md file in the configured local output directory or this run artifacts from complete Markdown content written by the AI. Use this when the user asks to generate/export/save a Markdown file, then include the returned Markdown download link exactly as a clickable Markdown link in the final answer.',
      inputSchema: browserToolInput({
        fileName: z.string().optional().describe('Optional Markdown file name. The .md extension is added when missing.'),
        title: z.string().optional().describe('Optional title used as fallback file name.'),
        content: z.string().min(1).describe('Complete Markdown file content to save.'),
      }),
      execute: (input) => record('generateMarkdownFile', input, () => generateMarkdownArtifact({ ...input, runId: referenceOptions?.runId })),
    }),
    reportState: tool({
      description: 'No-op reporting tool. Use exactly this tool when no browser action is needed: requirement complete, blocked, failed, or a short textual status update is enough. This tool does not change the browser.',
      inputSchema: browserToolInput({
        action: z.string().min(1).describe('Chinese summary of the current assistant state or final conclusion.'),
        expected: z.string().min(1).describe('Chinese expected condition or remaining goal.'),
        actual: z.string().min(1).describe('Chinese evidence-based actual state, including important details.'),
        status: z.enum(['passed', 'failed', 'blocked']).describe('passed for complete or non-terminal status update, failed for impossible/end-to-end failure, blocked for manual verification/security/user input.'),
        done: z.boolean().describe('true only when the full requirement is complete or impossible. false when more useful browser work remains or user/manual intervention is needed.'),
      }),
      execute: (input) => record('reportState', input, async () => ({
        ok: true,
        actual: `Reported state without browser action: ${input.actual}`,
      })),
    }),
  };

  const tools = sharedTools;
  const allowedToolTypes = referenceOptions?.allowedToolTypes;
  if (!allowedToolTypes?.length) return tools;
  const allowed = new Set(allowedToolTypes);
  return Object.fromEntries(Object.entries(tools).filter(([name]) => allowed.has(name))) as typeof tools;
}

type RuntimeToolDefinitions = ReturnType<typeof makeBrowserTools>;

function toolInputJsonSchema(inputSchema: unknown) {
  if (!inputSchema) return undefined;
  try {
    return z.toJSONSchema(inputSchema as z.ZodType);
  } catch (error) {
    return { unavailable: true, reason: error instanceof Error ? error.message : String(error) };
  }
}

function toolSchemaEstimateInput(tools?: RuntimeToolDefinitions) {
  if (!tools) return [];
  return Object.entries(tools).map(([name, toolDefinition]) => {
    const record = toolDefinition as Record<string, unknown>;
    return {
      type: 'function',
      function: {
        name,
        description: typeof record.description === 'string' ? record.description : '',
        parameters: toolInputJsonSchema(record.inputSchema),
      },
    };
  });
}

function runtimePrompt(input: {
  runtimeRecord: BrowserChatRuntimeRecord;
  operationalContext?: string;
}) {
  const { runtimeRecord } = input;
  const rawCaseSystemPrompt = systemPromptOf(runtimeRecord);
  const caseSystemPrompt = browserChatSystemPromptForRuntime(rawCaseSystemPrompt);
  const customPrompt = customRuntimePromptFromEnv();
  const screenshotAvailable = modelSupportsScreenshotInput();
  return [
    'You are an AI browser chat agent. Satisfy the latest user message from the live browser or answer directly when browser evidence is unnecessary.',
    '',
    'Operating rules:',
    '- In one model step, either answer in Chinese Markdown without a tool or call at most one relevant tool. A new action request is a new occurrence even when its wording repeats an earlier request.',
    '- Keep tool input limited to the exact arguments, a concise semantic reason, and confirmation fields only when loaded safety rules require them. Inspect the live page in browserCode before acting; do not reuse old UIDs, coordinates, screenshots, or prior tool JSON as current evidence.',
    '- Never expose internal JSON, tool parameters, UIDs, coordinates, screenshot paths, credential references, or other implementation details in the visible answer. An external-app candidate only attempts a native protocol launch; unchanged page state does not prove failure or native success.',
    ...browserChatCodeRules(screenshotAvailable),
    '- If progress stops or the target mismatches, inspect fresh evidence and change approach instead of repeating the same failed target.',
    '- Only for multi-document requirement analysis, inspect/search the root links, spawn one parallel subagent batch for independent URLs, keep dependent end-to-end work in the main Agent, and read one completed child result per later model step.',
    '- Use waitForHumanVerification only when an empty captcha/OTP/security check, unavailable user credential, QR scan, payment/identity confirmation, or personal-device action genuinely requires the user. If a detected captcha is already filled, submit and continue.',
    '- For downloads, call downloadFile with the already-known absolute or page-relative URL. For Markdown export, call generateMarkdownFile with the complete content. Report the saved file name and return its clickable download link.',
    caseSystemPrompt ? `Loaded safety rules and Skills:\n${caseSystemPrompt}` : '',
    input.operationalContext
      ? `Relevant memory and secure capabilities supplied by the runtime:\n${input.operationalContext}`
      : '',
    customPrompt,
    '',
    'Finish with Chinese Markdown when the request is satisfied, blocked, failed, or needs clarification. Do not return standalone JSON.',
  ].filter(Boolean).join('\n');
}

function runtimeToolNames(mode: BrowserSessionMode) {
  void mode;
  return [
    'browserCode',
    'clickByUid',
    'waitForHumanVerification',
    'spawnSubagents',
    'readSubagent',
    'readFile',
    'downloadFile',
    'generateMarkdownFile',
    'reportState',
  ];
}

const browserSessionToolNames = new Set([
  'browserCode',
  'clickByUid',
  'waitForHumanVerification',
  'spawnSubagents',
]);

function toolRequiresBrowserSession(name: string) {
  return browserSessionToolNames.has(name);
}

function isCodexProvider() {
  return getModelSettings().provider === 'codex';
}

// 记录一次 AI 请求的可展示上下文；图片只在真实发送给 AI 时写入 messages。
function createAiRequestSnapshot(input: {
  kind: AiRequestSnapshot['kind'];
  stepIndex: number;
  prompt: string;
  screenshotPath?: string;
  imagePaths?: string[];
  imageAttached: boolean;
  tools?: string[];
  options?: Record<string, unknown>;
  systemPrompt?: string;
}): AiRequestSnapshot {
  const { provider, model } = getModelSettings();
  const attachedImagePaths = input.imageAttached
    ? input.imagePaths?.length
      ? input.imagePaths
      : input.screenshotPath
        ? [input.screenshotPath]
        : []
    : [];
  const imageContent = attachedImagePaths.map((imagePath) => ({
    type: 'image' as const,
    imagePath,
    attached: true,
  }));
  return {
    id: randomUUID(),
    kind: input.kind,
    stepIndex: input.stepIndex,
    createdAt: new Date().toISOString(),
    provider,
    model,
    systemPrompt: input.systemPrompt,
    screenshotPath: input.screenshotPath,
    imageAttached: input.imageAttached,
    tools: input.tools,
    options: input.options,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: input.prompt },
          ...imageContent,
        ],
      },
    ],
  };
}

const fullLogDetailsFlag = '__browserChatFullLogDetails';function binaryLogDescriptor(value: unknown, imagePath?: string) {
  const bytes = Buffer.isBuffer(value)
    ? value.length
    : ArrayBuffer.isView(value)
      ? value.byteLength
      : value instanceof ArrayBuffer
        ? value.byteLength
        : typeof value === 'string'
          ? value.length
          : undefined;
  return {
    type: 'binary',
    bytes,
    imagePath,
    attached: Boolean(imagePath),
  };
}

function sanitizeModelLogValue(
  value: unknown,
  imagePaths: string[],
  state: { imageIndex: number },
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    const imagePath = imagePaths[state.imageIndex++];
    return binaryLogDescriptor(value, imagePath);
  }
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeModelLogValue(item, imagePaths, state, seen));
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'image') {
      const imagePath = imagePaths[state.imageIndex++];
      output[key] = binaryLogDescriptor(item, imagePath);
    } else {
      output[key] = sanitizeModelLogValue(item, imagePaths, state, seen);
    }
  }
  return output;
}

function sanitizeModelMessagesForLog(system: string | undefined, messages: unknown, imagePaths: string[]) {
  const orderedMessages = [
    ...(system?.trim() ? [{ role: 'system', content: system }] : []),
    ...(Array.isArray(messages) ? messages : []),
  ];
  return sanitizeModelLogValue(orderedMessages, imagePaths, { imageIndex: 0 });
}

function sanitizeModelInputForStats(system: string | undefined, messages: unknown, imagePaths: string[]) {
  return sanitizeModelLogValue({
    system: system || '',
    messages: Array.isArray(messages) ? messages : [],
  }, imagePaths, { imageIndex: 0 });
}

function modelMessagesTextAndImageStats(messages: unknown, tools?: RuntimeToolDefinitions) {
  let text = '';
  let imageCount = 0;
  const walk = (value: unknown) => {
    if (typeof value === 'string') {
      text += `\n${value}`;
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.type === 'image' || (record.image && typeof record.image === 'object')) {
      imageCount += 1;
      return;
    }
    Object.values(record).forEach(walk);
  };
  walk(messages);
  const serialized = JSON.stringify(messages) || '';
  const estimatedValueTextTokens = estimateTextTokens(text);
  const estimatedSerializedTextTokens = estimateTextTokens(serialized);
  const estimatedTextTokens = Math.max(estimatedValueTextTokens, estimatedSerializedTextTokens);
  const estimatedImageTokens = imageCount * imageTokenEstimatePerImage();
  const toolSchema = toolSchemaEstimateInput(tools);
  const serializedToolSchema = JSON.stringify(toolSchema) || '';
  const estimatedToolSchemaTokens = estimateTextTokens(serializedToolSchema);
  return {
    textCharacters: text.length,
    serializedCharacters: serialized.length,
    imageCount,
    toolCount: toolSchema.length,
    toolSchemaCharacters: serializedToolSchema.length,
    estimatedValueTextTokens,
    estimatedSerializedTextTokens,
    estimatedTextTokens,
    estimatedImageTokens,
    estimatedToolSchemaTokens,
    estimatedTotalTokens: estimatedTextTokens + estimatedImageTokens + estimatedToolSchemaTokens,
    method: 'rough estimate from sanitized modelMessages plus current browser tool schemas: max(value-text tokens, serialized JSON tokens) + imageCount * AI_IMAGE_CONTEXT_ESTIMATE_TOKENS + serialized current tool definitions',
  };
}

function fullLogDetails(value: unknown) {
  return {
    [fullLogDetailsFlag]: true,
    value: jsonSafe(value),
  };
}

function aiRequestLogDetails(aiRequest: AiRequestSnapshot | undefined, extra: Record<string, unknown> = {}, modelMessages?: unknown) {
  const messages = modelMessages || aiRequest?.messages || [];
  return fullLogDetails({
    aiInput: {
      provider: aiRequest?.provider || extra.provider,
      model: aiRequest?.model || extra.model,
      tools: aiRequest?.tools,
      options: {
        ...(aiRequest?.options || {}),
        ...extra,
      },
      system: aiRequest?.systemPrompt,
      messages,
    },
    aiInputTokens: modelMessagesTextAndImageStats(messages),
  });
}

function aiResponseLogDetails(input: {
  aiRequest?: AiRequestSnapshot;
  modelMessages?: unknown;
  response: unknown;
  elapsedMs: number;
  aiElapsedMs?: number;
  stepStartedAt?: number;
  traces?: ToolTrace[];
  visualContext?: ReturnType<VisualContextManager['snapshot']>;
  workingMemory?: RuntimeWorkingMemory;
  extra?: Record<string, unknown>;
}) {
  return fullLogDetails({
    aiOutput: sanitizeModelLogValue({
      ...(input.extra || {}),
      elapsedMs: input.elapsedMs,
      timings: summarizeRuntimeLogTimings({
        aiElapsedMs: input.aiElapsedMs,
        stepStartedAt: input.stepStartedAt,
        totalElapsedMs: input.elapsedMs,
        traces: input.traces,
      }),
      response: input.response,
    }, [], { imageIndex: 0 }),
  });
}

function extractProgressNote(text: string) {
  if (!text) return undefined;
  // The model is asked to emit a single "PROGRESS: ... NEXT: ..." line alongside its tool call.
  const match = text.match(/PROGRESS\s*[:：][\s\S]*/i);
  const note = (match ? match[0] : text).replace(/```[\s\S]*?```/g, '').replace(/\s+/g, ' ').trim();
  return readableActionFromRawText(note)?.slice(0, 400);
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

function ledgerMemoryLimit() {
  const raw = Number(process.env.AI_LEDGER_MEMORY_LIMIT || 1000);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1000;
}

function ledgerKey(item: TaskLedgerItem) {
  return item.id || `${item.dimensionId}:${item.status || ''}:${item.title}`.toLowerCase();
}

function mergeLedgerItems(existing: TaskLedgerItem[] = [], incoming: TaskLedgerItem[] = [], limit = 80) {
  const map = new Map<string, TaskLedgerItem>();
  for (const item of [...existing, ...incoming]) map.set(ledgerKey(item), item);
  return [...map.values()].slice(-limit);
}

function extractAssistantStepInfoFromToolInputs(traces: ToolTrace[], goal = ''): Pick<RuntimeDecision, 'taskFrame' | 'ledgerItems'> {
  void traces;
  void goal;
  return {};
}

function deriveBrowserChatStepDecision(text: string, traces: ToolTrace[], goal = ''): RuntimeDecision {
  const executed = traces.filter((trace) => trace.name && trace.result);
  const last = executed.at(-1);
  // Earlier failed attempts are diagnostic history, not the terminal outcome.
  // A later successful tool or final report means the branch recovered.
  const failed = last ? isEffectiveToolTraceFailure(last) : false;
  const names = executed.map((trace) => summarizeTraceForMemory(trace)).join('; ');
  const note = extractProgressNote(text);
  const assistantInfo = extractAssistantStepInfoFromToolInputs(executed, goal);
  const toolReason = executed.map((trace) => readableActionFromTrace(trace)).find(Boolean);

  if (last?.name === 'reportState' && last.result && last.input && typeof last.input === 'object' && !Array.isArray(last.input)) {
    const input = last.input as Record<string, unknown>;
    const status = input.status === 'failed' || input.status === 'blocked' || input.status === 'passed' ? input.status : 'passed';
    return {
      action: readableActionFromRawText(typeof input.action === 'string' ? input.action : undefined, { reportState: true })
        || readableActionFromTrace(last, { reportState: true })
        || toolReason
        || 'AI reported current browser-chat state',
      expected: typeof input.expected === 'string' ? input.expected : 'AI should report progress or conclusion based on current page state.',
      actual: typeof input.actual === 'string' ? input.actual : last.result.actual,
      status,
      done: typeof input.done === 'boolean' ? input.done : true,
      note,
      ...assistantInfo,
    };
  }

  if (last?.name === 'waitForHumanVerification') {
    return {
      action: readableActionFromTrace(last) || toolReason || 'Wait for human verification',
      expected: 'The user should complete captcha, login, security verification, or other manual work in the visible browser.',
      actual: last.result?.actual || 'AI requested human intervention before continuing browser-chat work.',
      status: 'blocked',
      done: false,
      note,
      ...assistantInfo,
    };
  }

  return {
    action: note || readableActionFromTrace(last) || toolReason || `AI executed browser-chat action: ${names || last?.name || 'browser action'}`,
    expected: 'This browser-chat action should move the conversation forward; the next turn will decide whether to continue or answer.',
    actual: last
      ? userFacingToolResult(last.name, last.result, 500) || 'Tool call finished; waiting for the next browser-chat turn.'
      : text || 'Browser chat returned no browser tool result.',
    status: failed ? 'failed' : 'passed',
    done: false,
    note,
    ...assistantInfo,
  };
}

// 执行单个运行时步骤：采集页面上下文，调用 AI 选择一个动作，并记录请求快照。
function browserChatReplyFromDecision(decision: RuntimeDecision, lastToolName?: string) {
  const candidates = [
    decision.actual,
    decision.note,
    decision.observation,
    decision.action,
  ].map((item) => String(item || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const text = candidates.find((item) => (
    item
    && !/^Tool call finished/i.test(item)
    && !/^Browser chat returned no browser tool/i.test(item)
    && !/^AI executed browser-chat action/i.test(item)
  )) || candidates[0] || '';
  if (!text) return lastToolName === 'reportState' ? '已完成本轮操作。' : '';
  return text.length > 900 ? `${text.slice(0, 900)}...` : text;
}

function progressFieldsFromToolTraces(
  traces: ToolTrace[],
  goal: string,
  stepIndex: number,
  progress?: ToolTraceProgress,
): Partial<StepExecutionResult> {
  const assistantInfo = extractAssistantStepInfoFromToolInputs(traces, goal);
  const workingMemory = progress?.workingMemory;
  const ledgerItems = mergeLedgerItems(
    assistantInfo.ledgerItems || [],
    workingMemory?.ledgerItems || [],
    ledgerMemoryLimit(),
  ).map((item) => ({ ...item, sourceStep: item.sourceStep ?? stepIndex }));

  return {
    taskFrame: assistantInfo.taskFrame || workingMemory?.taskFrame,
    ledgerItems,
    workingMemory,
    visualContext: progress?.visualContext,
  };
}

async function executeRuntimeStep(input: {
  session: BrowserSession;
  runtimeRecord: BrowserChatRuntimeRecord;
  runId: string;
  stepIndex: number;
  beforeScreenshotPath: string;
  instruction?: string;
  operationalContext?: string;
  conversation?: InteractiveBrowserTurnMessage[];
  referenceImagePaths?: string[];
  abortSignal?: AbortSignal;
  shouldContinue?: () => boolean;
  onDebug?: ExecutionDebug;
  onToolTrace?: (trace: ToolTrace, progress?: ToolTraceProgress) => void | Promise<void>;
  getRuntimeOperationalContext?: () => BrowserChatOperationalContext | Promise<BrowserChatOperationalContext>;
  requestToolConfirmation?: (request: BrowserToolConfirmationRequest) => Promise<BrowserToolConfirmationDecision>;
  allowedToolTypes?: string[];
  runSubagents?: BrowserChatSubagentRunner;
  readSubagent?: BrowserChatSubagentReader;
  readFile?: (input: { attachmentId?: string; artifactId?: string; limit?: number; offset?: number }) => Promise<BrowserActionResult>;
  credentialBindings?: BrowserCodeCredentialBinding[];
  ensureBrowserStarted?: () => Promise<void>;
  isBrowserStarted?: () => boolean;
  agentLoopTimeoutMs?: number;
}) {
  const {
    session,
    runtimeRecord,
    stepIndex,
    beforeScreenshotPath,
    referenceImagePaths = [],
    abortSignal,
    onDebug,
    onToolTrace,
  } = input;
  const mode = browserModeOf();
  const screenshotInputEnabled = false;
  const markerEnabled = false;
  const ensureActive = () => throwIfStopped(abortSignal, input.shouldContinue);
  const markerScreenshotPath = undefined;
  const originalScreenshotPath = session.getLastOriginalScreenshotPath();
  ensureActive();
  await onDebug?.({
    phase: 'ai:runtime-input:start',
    stepIndex,
    message: `Preparing runtime input for ${mode} mode.`,
    details: { browserMode: mode, screenshotInputEnabled, markerEnabled },
  });
  const contextMs = 0;
  const screenshotReadStartedAt = Date.now();
  const screenshot = undefined;
  ensureActive();
  const userReferenceImagePaths = Array.from(new Set(referenceImagePaths.filter(Boolean))).slice(0, 4);
  const userReferenceImages = modelSupportsScreenshotInput()
    ? await Promise.all(userReferenceImagePaths.map(async (imagePath) => ({
        imagePath,
        image: await readScreenshotForAi(imagePath).catch(() => undefined),
      })))
    : [];
  ensureActive();
  const screenshotReadMs = elapsedSince(screenshotReadStartedAt);
  const promptStartedAt = Date.now();
  const userReferenceImagePrompt = userReferenceImagePaths.length
    ? [
        '',
        'User uploaded reference images:',
        ...userReferenceImagePaths.map((imagePath, index) => `- reference image ${index + 1}: ${imagePath}`),
        'Use these reference images as user-provided visual context. Do not confuse them with the live browser screenshot.',
      ].join('\n')
    : '';
  const prompt = `${runtimePrompt({
    runtimeRecord,
    operationalContext: input.operationalContext,
  })}${userReferenceImagePrompt}`;
  let activeOperationalContext = input.operationalContext || '';
  let activeCredentialBindings = input.credentialBindings || [];
  const promptMs = elapsedSince(promptStartedAt);
  await onDebug?.({
    phase: 'perf:runtime-input',
    stepIndex,
    message: `Runtime input prepared: page context ${contextMs}ms, screenshot read/compress ${screenshotReadMs}ms, prompt build ${promptMs}ms.`,
    details: {
      contextMs,
      screenshotReadMs,
      promptMs,
      screenshotInputEnabled,
      screenshotBytes: undefined,
      markerScreenshotBytes: undefined,
      selectedReferenceScreenshotCount: 0,
      userReferenceImageCount: userReferenceImages.filter((item) => item.image).length,
      browserMode: mode,
    },
  });
  let lastAiRequest: AiRequestSnapshot | undefined;
  let lastRetryState: RuntimeRetryState | undefined;
  let consecutiveRequestFailures = 0;
  const durableTraces: ToolTrace[] = [];

  function rememberRetryState(state: RuntimeRetryState) {
    lastRetryState = cloneRuntimeRetryState(state);
  }

  async function runAgent(includeImage: boolean, retryState?: RuntimeRetryState) {
    ensureActive();
    const traces: ToolTrace[] = [...durableTraces];
    const codexMode = isCodexProvider();
    const retryAgentStepOffset = retryState?.agentStepOffset || 0;
    const availableRuntimeToolNames = runtimeToolNames(mode).filter((name) => (
      (name !== 'spawnSubagents' || Boolean(input.runSubagents))
      && (name !== 'readSubagent' || Boolean(input.readSubagent))
      && (name !== 'readFile' || Boolean(input.readFile))
    ));
    const runtimeTools = runtimeAllowedToolTypes({
      browserChatMode: true,
      codexMode,
      nativeToolNames: availableRuntimeToolNames,
      observationToolNames: new Set<string>(),
    });
    const requestedToolTypes = input.allowedToolTypes?.length ? new Set(input.allowedToolTypes) : undefined;
    const allowedToolTypes = requestedToolTypes
      ? runtimeTools.filter((toolType) => requestedToolTypes.has(toolType))
      : runtimeTools;
    const nativeToolsRef: { current?: RuntimeToolDefinitions } = {};
    const visualContext = new VisualContextManager();
    visualContext.init({ path: beforeScreenshotPath, originalPath: originalScreenshotPath, markerPath: markerScreenshotPath, stepIndex, capture: 'viewport', reason: 'Initial current screenshot for this agent loop' });
    let requestSystemPrompt = codexMode ? buildCodexObjectPrompt(prompt, allowedToolTypes) : prompt;
    let workingMemory: RuntimeWorkingMemory = {
      taskGoal: requirementOf(runtimeRecord),
      phase: 'Browser chat turn; answer directly when current evidence is enough, otherwise use one browser tool.',
      completed: [],
      findings: [],
      blockers: [],
      pageUnderstanding: '',
      currentState: 'No page state is preloaded; use browserCode when browser evidence is needed.',
      scrollSummary: '',
      userConstraints: systemPromptOf(runtimeRecord) ? [systemPromptOf(runtimeRecord)] : [],
      nextStep: 'Satisfy the latest user message; do not use a tool when a Markdown answer is already supported by evidence.',
    };
    let latestText = '';
    const initialVisualPaths: string[] = [];
    const initialUserReferenceImagePaths = userReferenceImages.filter((item) => item.image).map((item) => item.imagePath);
    type PendingObservationMessage = {
      text: string;
      imagePaths: string[];
    };
    const pendingObservationMessages: PendingObservationMessage[] = [];
    const historyMessages = (input.conversation || [])
      .map((message) => {
        const content = textFromUnknown(message?.content);
        if (!content.trim()) return undefined;
        return {
          role: message?.role === 'assistant' ? 'assistant' as const : 'user' as const,
          content,
        };
      })
      .filter((message): message is { role: 'user' | 'assistant'; content: string } => Boolean(message)) as RuntimeModelMessage[];
    const initialImagePaths = [...initialVisualPaths, ...initialUserReferenceImagePaths];
    const initialImages: Buffer[] = [];
    for (const imagePath of initialImagePaths) {
      const image = await readScreenshotForAi(imagePath).catch(() => undefined);
      if (image) initialImages.push(image);
    }
    let initialMessages = [...historyMessages] as RuntimeModelMessage[];
    const latestInstruction = (
      textFromUnknown(input.instruction)
      || textFromUnknown(runtimeRecord.description)
    ).trim();
    const hasLatestUserMessage = Boolean(latestInstruction && initialMessages.some((message) => {
      if (message.role !== 'user' || typeof message.content !== 'string') return false;
      const content = textFromUnknown(message.content);
      return content.trim() === latestInstruction || content.includes(latestInstruction);
    }));
    if (latestInstruction && !hasLatestUserMessage) {
      initialMessages.push({ role: 'user' as const, content: latestInstruction });
    }
    if (initialImages.length) {
      const latestUserIndex = initialMessages.map((message) => message.role).lastIndexOf('user');
      const fallbackText = latestInstruction || 'User uploaded reference image(s).';
      if (latestUserIndex >= 0) {
        const latestUser = initialMessages[latestUserIndex];
        const text = typeof latestUser.content === 'string' && latestUser.content.trim()
          ? latestUser.content
          : fallbackText;
        initialMessages[latestUserIndex] = {
          role: 'user' as const,
          content: [
            { type: 'text' as const, text },
            ...initialImages.map((image) => ({ type: 'image' as const, image })),
          ],
        };
      } else {
        initialMessages.push({
          role: 'user' as const,
          content: [
            { type: 'text' as const, text: fallbackText },
            ...initialImages.map((image) => ({ type: 'image' as const, image })),
          ],
        });
      }
    }
    if (retryState?.messages.length) {
      initialMessages = [...retryState.messages];
    }
    let messageImagePaths = retryState?.messages.length ? [...retryState.imagePaths] : [...initialImagePaths];
    rememberRetryState({
      messages: initialMessages,
      imagePaths: messageImagePaths,
      agentStepOffset: retryAgentStepOffset,
    });
    let aiRequest = createAiRequestSnapshot({
      kind: 'runtime',
      stepIndex,
      prompt: '[system prompt]',
      systemPrompt: requestSystemPrompt,
      screenshotPath: undefined,
      imagePaths: messageImagePaths,
      imageAttached: Boolean(messageImagePaths.length),
      tools: allowedToolTypes,
      options: { agentLoop: true, explicitPageState: true, visualContext: visualContext.snapshot(), workingMemory, imageCount: messageImagePaths.length, markerScreenshotPath, isMarked: false, markerOverlayInScreenshot: false, separateMarkerMap: false, modelSupportsScreenshotInput: modelSupportsScreenshotInput(), screenshotInputEnabled: false, screenshotToolEnabled: false, browserCodeImageOutputEnabled: modelSupportsScreenshotInput(), browserMode: mode, visualClickMode: false, codexObjectMode: codexMode, selectedReferenceScreenshotCount: 0, userReferenceImageCount: initialUserReferenceImagePaths.length },
    });
    lastAiRequest = aiRequest;
    const toolExecutionGate = { stepNumber: 0, executed: false };
    const stepTraceStarts = new Map<number, number>();
    const stepStartedAt = new Map<number, number>();
    const stepModelMessagesForLog = new Map<number, unknown>();
    let contextSegmentationTurns = 0;
    const continuationSummaryMarker = '[WebPilot continuation summary]';
    let compactedModelContext: RuntimeModelMessage[] | undefined;
    let compactedSourceMessageCount = 0;

    function messagesAddedAfterCompactedContext(sourceMessages: RuntimeModelMessage[]) {
      if (!compactedModelContext?.length) return sourceMessages;
      const markerIndex = sourceMessages.findIndex((message) => (
        textFromUnknown(message.content).startsWith(continuationSummaryMarker)
      ));
      if (markerIndex >= 0) {
        return sourceMessages.slice(markerIndex + Math.min(
          compactedModelContext.length,
          sourceMessages.length - markerIndex,
        ));
      }
      return sourceMessages.slice(Math.min(compactedSourceMessageCount, sourceMessages.length));
    }

    const summarizeContinuation = async (modelMessagesForLog: unknown, turnIndex: number, messageStats: ReturnType<typeof modelMessagesTextAndImageStats>, thresholdTokens: number) => {
      ensureActive();
      const agentStepIndex = retryAgentStepOffset + turnIndex + 1;
      try {
        const result = await generateTextWithTimeout({
          model: getModel(),
          messages: [{
            role: 'user' as const,
            content: buildContinuationSummaryPrompt({
              goal: requirementOf(runtimeRecord),
              browserMode: mode,
              stepIndex,
              agentStep: agentStepIndex,
              estimatedTokens: messageStats.estimatedTotalTokens,
              thresholdTokens,
              modelMessages: modelMessagesForLog,
              workingMemory,
            }),
          }],
          temperature: 0.1,
          maxRetries: 0,
          abortSignal,
        });
        ensureActive();
        return (result.text || '').trim() || fallbackContinuationSummary({
          goal: requirementOf(runtimeRecord),
          browserMode: mode,
          stepIndex,
          agentStep: agentStepIndex,
          traces,
          workingMemory,
        });
      } catch (error) {
        if (isBrowserChatAbortError(error, abortSignal)) throw browserChatAbortError(abortSignal);
        return fallbackContinuationSummary({
          goal: requirementOf(runtimeRecord),
          browserMode: mode,
          stepIndex,
          agentStep: agentStepIndex,
          traces,
          workingMemory,
        });
      }
    };

    async function prepareStep(turnIndex: number, previousMessages?: RuntimeModelMessage[]) {
      ensureActive();
      if (input.getRuntimeOperationalContext) {
        try {
          const runtimeContext = await input.getRuntimeOperationalContext();
          ensureActive();
          activeOperationalContext = runtimeContext.operationalContext;
          activeCredentialBindings = runtimeContext.credentialBindings || [];
        } catch (error) {
          await onDebug?.({
            phase: 'runtime-context:refresh:error',
            stepIndex,
            message: `Unable to rebuild runtime context for the current page: ${infrastructureError(error)}`,
            details: serializeError(error),
          });
        }
      }
      const refreshedPrompt = `${runtimePrompt({ runtimeRecord, operationalContext: activeOperationalContext })}${userReferenceImagePrompt}`;
      requestSystemPrompt = codexMode ? buildCodexObjectPrompt(refreshedPrompt, allowedToolTypes) : refreshedPrompt;
      const agentStepIndex = retryAgentStepOffset + turnIndex + 1;
      const windowTokens = contextWindowTokens();
      const thresholdRatio = contextCompressionThresholdRatio();
      const thresholdTokens = Math.floor(windowTokens * thresholdRatio);
      const appendedMessages: RuntimeModelMessage[] = [];
      const appendedImagePaths: string[] = [];
      while (pendingObservationMessages.length) {
        const observation = pendingObservationMessages.shift();
        if (!observation) break;
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; image: Buffer }> = [{ type: 'text', text: observation.text }];
        for (const imagePath of observation.imagePaths) {
          const image = await readScreenshotForAi(imagePath).catch(() => undefined);
          if (image) {
            content.push({ type: 'image', image });
            appendedImagePaths.push(imagePath);
          }
        }
        appendedMessages.push({ role: 'user' as const, content });
      }

      const sourceMessages = previousMessages?.length ? [...previousMessages] : [...initialMessages];
      let messagesToSend = compactedModelContext?.length
        ? [...compactedModelContext, ...messagesAddedAfterCompactedContext(sourceMessages)]
        : sourceMessages;
      if (appendedMessages.length) {
        messagesToSend = [...messagesToSend, ...appendedMessages];
        messageImagePaths = [...messageImagePaths, ...appendedImagePaths];
      }

      let attachedImagePaths = [...messageImagePaths];
      let modelMessagesForLog = sanitizeModelMessagesForLog(requestSystemPrompt, messagesToSend, attachedImagePaths);
      let modelContextSegmentation: Record<string, unknown> | undefined;
      const modelInputForStats = sanitizeModelInputForStats(requestSystemPrompt, messagesToSend, attachedImagePaths);
      const messageStats = modelMessagesTextAndImageStats(modelInputForStats, codexMode ? undefined : nativeToolsRef.current);
      if ((previousMessages?.length || messagesToSend.length > 1) && messageStats.estimatedTotalTokens > thresholdTokens) {
        const summary = await summarizeContinuation(modelInputForStats, turnIndex, messageStats, thresholdTokens);
        contextSegmentationTurns += 1;
        messagesToSend = [
          { role: 'user' as const, content: `${continuationSummaryMarker}\n${summary}` },
          ...(appendedMessages.length
            ? appendedMessages
            : [{ role: 'user' as const, content: 'Continue from the continuation summary. Treat completed, confirmedFacts, negativeResults, and failedAttempts as durable facts: do not repeat a completed or known-empty search unless the user changed the query or fresh evidence contradicts it. If fresh page state is needed, inspect it with browserCode.' }]),
        ];
        attachedImagePaths = appendedImagePaths;
        messageImagePaths = [...attachedImagePaths];
        modelMessagesForLog = sanitizeModelMessagesForLog(requestSystemPrompt, messagesToSend, attachedImagePaths);
        const afterStats = modelMessagesTextAndImageStats(sanitizeModelInputForStats(requestSystemPrompt, messagesToSend, attachedImagePaths), codexMode ? undefined : nativeToolsRef.current);
        modelContextSegmentation = {
          segment: contextSegmentationTurns,
          reason: 'modelMessages exceeded context threshold',
          estimatedTokensBefore: messageStats.estimatedTotalTokens,
          estimatedTokensAfter: afterStats.estimatedTotalTokens,
          thresholdTokens,
        };
        await onDebug?.({
          phase: 'ai:context-segmented',
          stepIndex,
          message: `Model message context exceeded threshold; inserted continuation summary segment ${contextSegmentationTurns}.`,
          details: modelContextSegmentation,
        });
      }
      const finalStats = modelContextSegmentation
        ? modelMessagesTextAndImageStats(sanitizeModelInputForStats(requestSystemPrompt, messagesToSend, attachedImagePaths), codexMode ? undefined : nativeToolsRef.current)
        : messageStats;
      if (compactedModelContext?.length || modelContextSegmentation) {
        // The SDK passes its full pre-segmentation history back to every prepareStep.
        // Retain the compact form locally and append only newly produced SDK messages.
        compactedModelContext = [...messagesToSend];
        compactedSourceMessageCount = sourceMessages.length;
      }
      rememberRetryState({
        messages: [...messagesToSend],
        imagePaths: [...attachedImagePaths],
        agentStepOffset: agentStepIndex - 1,
      });
      aiRequest = createAiRequestSnapshot({ kind: 'runtime', stepIndex, prompt: '[modelMessages logged separately]', systemPrompt: requestSystemPrompt, screenshotPath: undefined, imagePaths: attachedImagePaths, imageAttached: attachedImagePaths.length > 0, tools: allowedToolTypes, options: { agentLoop: true, agentStepIndex, visualContext: visualContext.snapshot(), workingMemory, imageCount: attachedImagePaths.length, explicitPageState: true, screenshotToolEnabled: false, browserCodeImageOutputEnabled: modelSupportsScreenshotInput(), modelContextStats: { ...finalStats, windowTokens, thresholdRatio, thresholdTokens }, modelContextSegmentation } });
      lastAiRequest = aiRequest;
      return {
        system: requestSystemPrompt || undefined,
        messages: messagesToSend,
        modelMessagesForLog,
      };
    }

    if (codexMode) {
      const aiStartedAt = Date.now();
      const { system, messages, modelMessagesForLog } = await prepareStep(0);
      ensureActive();
      await onDebug?.({
        phase: 'ai:runtime:request',
        stepIndex,
        message: 'AI request started; waiting for browser action decision.',
        details: aiRequestLogDetails(aiRequest, {
          provider: getModelSettings().provider,
          model: getModelSettings().model,
          codexObjectMode: true,
        }, modelMessagesForLog),
      });
      const result = await generateTextWithTimeout({ model: getModel(), system, messages, temperature: 0.1, maxRetries: 0, abortSignal });
      const aiElapsedMs = elapsedSince(aiStartedAt);
      ensureActive();
      const object = alignCodexRuntimeObjectTool(
        codexRuntimeObjectFromText(result.text, allowedToolTypes.includes('answer') ? 'answer' : 'reportState'),
        allowedToolTypes,
      );
      const execution = await executeCodexRuntimeObject({
        session,
        runId: input.runId,
        stepIndex,
        mode,
        type: object.type,
        message: object.message || undefined,
        params: object.params,
        allowedTypes: allowedToolTypes,
        traces,
        aiRequest,
        visualContext,
        abortSignal,
        shouldContinue: input.shouldContinue,
        requestToolConfirmation: input.requestToolConfirmation,
        runSubagents: input.runSubagents,
        readSubagent: input.readSubagent,
        readFile: input.readFile,
        credentialBindings: activeCredentialBindings,
        ensureBrowserStarted: input.ensureBrowserStarted,
        onDebug,
        onVisualContextChange: async (snapshot) => { ensureActive(); await onDebug?.({ phase: 'ai:visual-context', stepIndex, message: 'Visual Context Manager updated.', details: snapshot }); },
        onToolTrace: async (trace) => {
          ensureActive();
          upsertToolTrace(durableTraces, trace);
          workingMemory = updateWorkingMemoryFromTrace(workingMemory, trace, stepIndex);
          await onToolTrace?.(trace, { workingMemory, visualContext: visualContext.snapshot() });
          ensureActive();
          await onDebug?.({ phase: 'ai:tool', stepIndex, message: `${trace.name} -> ${toolTraceStatus(trace)}`, details: { trace, visualContext: visualContext.snapshot(), workingMemory } });
        },
        onReferenceImage: (path) => {
          if (!modelSupportsScreenshotInput()) return;
          pendingObservationMessages.push({
            text: '[browserCode visual output]\nThe JavaScript cell emitted this image. Use it as fresh visual evidence for the next decision.',
            imagePaths: [path],
          });
        },
      });
      ensureActive();
      await onDebug?.({
        phase: 'ai:runtime:object',
        stepIndex,
        message: 'Codex object -> ' + object.type + '; AI+tool ' + elapsedSince(aiStartedAt) + 'ms',
        details: aiResponseLogDetails({
          aiRequest,
          modelMessages: modelMessagesForLog,
          response: { result, object, execution },
          elapsedMs: elapsedSince(aiStartedAt),
          aiElapsedMs,
          traces,
          visualContext: visualContext.snapshot(),
          workingMemory,
          extra: { responseType: 'object', objectType: object.type },
        }),
      });
      return {
        text: execution.text,
        traces,
        aiRequest,
        visualContext: visualContext.snapshot(),
        workingMemory,
        endedWithText: !execution.executed && Boolean(textFromUnknown(execution.text).trim()),
      };
    }

    const stopWhen = [hasToolCall('reportState'), hasToolCall('waitForHumanVerification')];
    nativeToolsRef.current = makeBrowserTools(session, traces, aiRequest, async (trace) => {
      ensureActive();
      upsertToolTrace(durableTraces, trace);
      workingMemory = updateWorkingMemoryFromTrace(workingMemory, trace, stepIndex);
      await onToolTrace?.(trace, { workingMemory, visualContext: visualContext.snapshot() });
      ensureActive();
      await onDebug?.({
        phase: 'ai:tool',
        stepIndex,
        message: `${trace.name} -> ${toolTraceStatus(trace)}`,
        details: { trace, visualContext: visualContext.snapshot(), workingMemory },
      });
    }, {
      allowedToolTypes,
      runId: input.runId,
      stepIndex,
      visualContext,
      toolExecutionGate,
      getAiRequest: () => aiRequest,
      abortSignal,
      shouldContinue: input.shouldContinue,
      requestToolConfirmation: input.requestToolConfirmation,
      runSubagents: input.runSubagents,
      readSubagent: input.readSubagent,
      readFile: input.readFile,
      credentialBindings: input.credentialBindings,
      getCredentialBindings: () => activeCredentialBindings,
      onReadFileImage: ({ path }) => {
        if (!modelSupportsScreenshotInput()) return;
        pendingObservationMessages.push({
          text: '[文件视觉内容]\n已读取图片文件；该图片已附加到本次工具调用后的下一轮模型请求。请直接基于图片内容进行分析。',
          imagePaths: [path],
        });
      },
      ensureBrowserStarted: input.ensureBrowserStarted,
      onDebug,
      onVisualContextChange: async (snapshot) => {
        ensureActive();
        await onDebug?.({ phase: 'ai:visual-context', stepIndex, message: 'Visual Context Manager updated.', details: snapshot });
      },
    });
    const toolsForRequest = nativeToolsRef.current;
    try {
      const result = await generateTextWithTimeout({
        model: getModel(),
        messages: initialMessages,
        tools: toolsForRequest,
        stopWhen,
        prepareStep: async ({ stepNumber, messages }) => {
          ensureActive();
          const prepared = await prepareStep(stepNumber, messages as RuntimeModelMessage[]);
          ensureActive();
          stepModelMessagesForLog.set(stepNumber, prepared.modelMessagesForLog);
          toolExecutionGate.stepNumber = stepNumber;
          toolExecutionGate.executed = false;
          stepTraceStarts.set(stepNumber, traces.length);
          stepStartedAt.set(stepNumber, Date.now());
          await onDebug?.({
            phase: 'ai:runtime:request',
            stepIndex,
            message: 'AI request started; waiting for browser action decision. agent step ' + agentStepLabel(retryAgentStepOffset + stepNumber) + '.',
            details: aiRequestLogDetails(aiRequest, {
              provider: getModelSettings().provider,
              model: getModelSettings().model,
              agentStepIndex: retryAgentStepOffset + stepNumber + 1,
              nativeToolLoop: true,
            }, prepared.modelMessagesForLog),
          });
          return { system: prepared.system, messages: prepared.messages };
        },
        onStepFinish: async (event) => {
          ensureActive();
          consecutiveRequestFailures = 0;
          latestText = event.text || '';
          const eventStep = event as { stepNumber?: unknown };
          const turnIndex = typeof eventStep.stepNumber === 'number' ? eventStep.stepNumber : toolExecutionGate.stepNumber;
          const traceStart = stepTraceStarts.get(turnIndex) ?? 0;
          const newTraces = traces.slice(traceStart);
          const startedAt = stepStartedAt.get(turnIndex) || Date.now();
          await onDebug?.({
            phase: 'ai:runtime:response',
            stepIndex,
            message: trimDebugText(latestText || 'AI returned no text; tool call completed.', 220) + '; agent step ' + agentStepLabel(retryAgentStepOffset + turnIndex) + '; AI+tool ' + elapsedSince(startedAt) + 'ms',
            details: aiResponseLogDetails({
              aiRequest,
              modelMessages: stepModelMessagesForLog.get(turnIndex),
              response: event,
              elapsedMs: elapsedSince(startedAt),
              stepStartedAt: startedAt,
              traces: newTraces,
              visualContext: visualContext.snapshot(),
              workingMemory,
              extra: {
                responseType: 'text',
                text: latestText,
                agentStepIndex: retryAgentStepOffset + turnIndex + 1,
                nativeToolLoop: true,
              },
            }),
          });
        },
        temperature: 0.1,
        maxRetries: 0,
        abortSignal,
      }, input.agentLoopTimeoutMs);
      ensureActive();
      latestText = toolConsistentAssistantText(result.text || latestText, traces.at(-1)?.name);
      return {
        text: latestText,
        traces,
        aiRequest,
        visualContext: visualContext.snapshot(),
        workingMemory,
        endedWithText: Boolean(textFromUnknown(latestText).trim()) && traces.at(-1)?.name !== 'waitForHumanVerification',
      };
    } catch (error) {
      if (isBrowserChatAbortError(error, abortSignal) || (input.shouldContinue && !input.shouldContinue())) throw browserChatAbortError(abortSignal);
      if (error && typeof error === 'object') (error as { aiRequest?: AiRequestSnapshot }).aiRequest = aiRequest;
      throw error;
    }
  }

  // Keep SDK retries disabled, but allow the runtime loop to retry transient upstream
  // disconnects with the exact model messages prepared for the failed request. The
  // limit is consecutive failures; any successful model step resets the counter.
  const consecutiveFailureLimit = runtimeRequestConsecutiveFailureLimit();
  let lastError: unknown;
  let retryingAfterFailure = false;

  while (true) {
    ensureActive();
    const includeImage = Boolean(screenshot);
    const retryState = retryingAfterFailure && lastRetryState?.messages.length ? lastRetryState : undefined;
    try {
      if (retryingAfterFailure) {
        if (!retryState) {
          await onDebug?.({
            phase: 'ai:runtime:retry-skipped',
            stepIndex,
            message: 'AI request failed, but no preserved model messages exist; not rebuilding messages for retry.',
            details: {
              error: infrastructureError(lastError),
              consecutiveFailures: consecutiveRequestFailures,
              consecutiveFailureLimit,
            },
          });
          ensureActive();
          break;
        }
        ensureActive();
        await onDebug?.({
          phase: 'ai:runtime:retry',
          stepIndex,
          message: `AI request failed; retrying after consecutive failure ${consecutiveRequestFailures}/${consecutiveFailureLimit} with the previously prepared model messages.`,
          details: {
            error: infrastructureError(lastError),
            consecutiveFailures: consecutiveRequestFailures,
            consecutiveFailureLimit,
            reusePreparedMessages: Boolean(retryState),
            messageCount: retryState?.messages.length,
            imageCount: retryState?.imagePaths.length,
            agentStepIndex: retryState ? retryState.agentStepOffset + 1 : undefined,
          },
        });
        ensureActive();
      }
      ensureActive();
      return await runAgent(includeImage, retryState);
    } catch (error) {
      if (isBrowserChatAbortError(error, abortSignal) || (input.shouldContinue && !input.shouldContinue())) throw browserChatAbortError(abortSignal);
      lastError = error;
      consecutiveRequestFailures += 1;
      if (consecutiveRequestFailures >= consecutiveFailureLimit) break;
      retryingAfterFailure = true;
    }
  }

  ensureActive();
  if (lastError && typeof lastError === 'object') {
    (lastError as { aiRequest?: AiRequestSnapshot }).aiRequest ??= lastAiRequest;
    (lastError as { runtimeRetry?: { consecutiveFailures: number; consecutiveFailureLimit: number } }).runtimeRetry ??= {
      consecutiveFailures: consecutiveRequestFailures,
      consecutiveFailureLimit,
    };
    throw lastError;
  }

  const wrapped = new Error(String(lastError || 'AI request failed before a response was returned'));
  (wrapped as { aiRequest?: AiRequestSnapshot }).aiRequest = lastAiRequest;
  (wrapped as { runtimeRetry?: { consecutiveFailures: number; consecutiveFailureLimit: number } }).runtimeRetry = {
    consecutiveFailures: consecutiveRequestFailures,
    consecutiveFailureLimit,
  };
  throw wrapped;
}

export type InteractiveBrowserTurnMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type InteractiveBrowserTurnResult = {
  status: 'passed' | 'failed' | 'blocked';
  reply: string;
  steps: StepExecutionResult[];
  newSteps: StepExecutionResult[];
  consoleErrors: string[];
  networkErrors: string[];
};

function browserChatMaxConsecutiveAiRequestFailures() {
  const raw = Number(process.env.AI_BROWSER_CHAT_MAX_CONSECUTIVE_REQUEST_FAILURES || 3);
  return Math.max(1, Math.floor(Number.isFinite(raw) ? raw : 3));
}

function browserChatTurnHasToolEvidence(steps: StepExecutionResult[], requirement: BrowserChatToolRequirement) {
  const toolCalls = steps.flatMap((step) => (step.tools || []).filter((toolCall) => toolCall.ok !== false));
  if (requirement === 'action') return toolCalls.some((toolCall) => toolCall.name === 'browserCode' || toolCall.name === 'clickByUid');
  return toolCalls.some((toolCall) => toolCall.name === 'browserCode');
}

function browserChatSafetyInstructions(mode?: BrowserChatSafetyMode) {
  if (mode === 'full') {
    return [
      'Safety mode: full.',
      '- When the user request is clear, do not ask for extra confirmation only because an operation is important.',
      '- Do not set requiresConfirmation or confirmationMessage for browser tools in full mode.',
      '- Still stop or ask for help when the page requires captcha/OTP/security verification, missing credentials, or information only the user can provide.',
    ].join('\n');
  }
  return [
    'Safety mode: strict.',
    '- Before executing an operation you judge important, irreversible, externally visible, data-changing, privacy-sensitive, or costly, call the intended browser tool with requiresConfirmation=true and a concise Chinese confirmationMessage.',
    '- Important operations can include submit/publish/send/delete/modify records, payment/order/authorization, login/security actions, file upload/download/export, or similar actions based on page context.',
    '- The backend will pause this same browser-chat turn and show Confirm/Cancel buttons on that tool before executing it.',
    '- Do not ask for this confirmation in plain text and do not end the turn just to ask the user to type confirm.',
  ].join('\n');
}

function createInteractiveBrowserRuntimeRecord(input: {
  safetyMode?: BrowserChatSafetyMode;
  targetUrl: string;
  instruction: string;
}): BrowserChatRuntimeRecord {
  const targetUrl = input.targetUrl || 'about:blank';
  const systemPrompt = browserChatSafetyInstructions(input.safetyMode);
  return {
    description: input.instruction,
    targetUrl,
    systemPrompt,
  };
}

function upsertStep(steps: StepExecutionResult[], step: StepExecutionResult) {
  const index = steps.findIndex((item) => item.index === step.index);
  if (index >= 0) steps[index] = { ...steps[index], ...step };
  else steps.push(step);
  steps.sort((a, b) => a.index - b.index);
}

export async function executeInteractiveBrowserTurn(input: {
  session: BrowserSession;
  runId: string;
  initialStepIndex?: number;
  targetUrl: string;
  instruction: string;
  modelInstruction?: string;
  operationalContext?: string;
  conversation?: InteractiveBrowserTurnMessage[];
  completedSteps?: StepExecutionResult[];
  mode?: BrowserSessionMode;
  safetyMode?: BrowserChatSafetyMode;
  referenceImagePaths?: string[];
  getRuntimeOperationalContext?: () => BrowserChatOperationalContext | Promise<BrowserChatOperationalContext>;
  onProgress?: (step: StepExecutionResult) => void | Promise<void>;
  onDebug?: ExecutionDebug;
  abortSignal?: AbortSignal;
  shouldContinue?: () => boolean;
  requestToolConfirmation?: (request: BrowserToolConfirmationRequest) => Promise<BrowserToolConfirmationDecision>;
  runSubagents?: BrowserChatSubagentRunner;
  readSubagent?: BrowserChatSubagentReader;
  readFile?: (input: { attachmentId?: string; artifactId?: string; limit?: number; offset?: number }) => Promise<BrowserActionResult>;
  credentialBindings?: BrowserCodeCredentialBinding[];
  ensureBrowserStarted?: () => Promise<void>;
  isBrowserStarted?: () => boolean;
  agentLoopTimeoutMs?: number;
  allowedToolTypes?: string[];
}): Promise<InteractiveBrowserTurnResult> {
  const ensureActive = () => throwIfStopped(input.abortSignal, input.shouldContinue);
  const steps = [...(input.completedSteps || [])];
  const newSteps: StepExecutionResult[] = [];
  const runtimeRecord = createInteractiveBrowserRuntimeRecord({
    safetyMode: input.safetyMode,
    targetUrl: input.targetUrl,
    instruction: input.instruction,
  });
  const runtimeMode = browserModeOf();
  let finalStatus: InteractiveBrowserTurnResult['status'] = 'passed';
  let reply = '';
  let endedWithFinalAnswer = false;
  const requiredTool = browserChatToolRequirement(input.instruction);
  let rejectedDirectAnswerCount = 0;
  const maxConsecutiveAiRequestFailures = browserChatMaxConsecutiveAiRequestFailures();
  let consecutiveAiRequestFailures = 0;

  async function takeStepScreenshot(phase: 'before' | 'after', stepIndex: number) {
    if (input.isBrowserStarted?.() === false) {
      await input.onDebug?.({
        phase: `browser:screenshot:${phase}:skipped`,
        stepIndex,
        message: `Skipped automatic ${phase} screenshot because no browser tool has started this session yet.`,
        details: { browserMode: runtimeMode, browserStarted: false },
      });
      return undefined;
    }
    if (runtimeMode === 'dom' && !browserChatDomScreenshotsEnabled()) {
      await input.onDebug?.({
        phase: `browser:screenshot:${phase}:skipped`,
        stepIndex,
        message: `Skipped automatic ${phase} screenshot; explicit browserCode image evidence remains authoritative.`,
        details: { browserMode: runtimeMode, enabledBy: 'BROWSER_CHAT_DOM_SCREENSHOTS=true' },
      });
      return undefined;
    }
    const startedAt = Date.now();
    try {
      const screenshotPath = await input.session.takeScreenshot(input.runId, stepIndex, phase);
      ensureActive();
      const message = phase === 'before'
        ? `Current page screenshot captured in ${elapsedSince(startedAt)}ms.`
        : `Post-action screenshot captured in ${elapsedSince(startedAt)}ms.`;
      const timingSummary = input.session.formatLastScreenshotTiming();
      await input.onDebug?.({
        phase: `browser:screenshot:${phase}`,
        stepIndex,
        message: timingSummary ? `${message} ${timingSummary}` : message,
        details: { elapsedMs: elapsedSince(startedAt), path: screenshotPath, timings: input.session.getLastScreenshotTiming() },
      });
      return screenshotPath;
    } catch (error) {
      throw error;
    }
  }

  while (true) {
    ensureActive();
    const stepIndex = Math.max(input.initialStepIndex || 0, ...steps.map((step) => step.index)) + 1;
    await input.onDebug?.({ phase: 'chat:step:start', stepIndex, message: `正在准备第 ${stepIndex} 步浏览器操作。` });
    let runningStep: StepExecutionResult = {
      index: stepIndex,
      action: 'AI is handling the latest browser chat message',
      expected: 'AI should inspect the live browser state and perform one useful browser action or report the current state.',
      actual: 'AI is preparing the current browser state.',
      status: 'running',
    };

    const beforeScreenshotPath = await takeStepScreenshot('before', stepIndex);
    runningStep = {
      ...runningStep,
      actual: 'AI is choosing the next browser action from the current page.',
      beforeScreenshotPath,
    };

    const liveToolTraces: ToolTrace[] = [];
    let latestToolProgress: ToolTraceProgress | undefined;
    let actionResult: Awaited<ReturnType<typeof executeRuntimeStep>>;

    try {
      actionResult = await executeRuntimeStep({
        session: input.session,
        runtimeRecord,
        runId: input.runId,
        stepIndex,
        beforeScreenshotPath: beforeScreenshotPath || '',
        instruction: rejectedDirectAnswerCount
          ? `${input.modelInstruction || input.instruction}\n\n[Backend correction] Your previous text-only completion claim was rejected because this user message requires a real browser tool. Execute the requested action or inspection now. Do not claim success without a successful tool result from this turn.`
          : input.modelInstruction || input.instruction,
        operationalContext: input.operationalContext,
        conversation: input.conversation || [],
        referenceImagePaths: input.referenceImagePaths,
        getRuntimeOperationalContext: input.getRuntimeOperationalContext,
        abortSignal: input.abortSignal,
        shouldContinue: input.shouldContinue,
        requestToolConfirmation: input.requestToolConfirmation,
        allowedToolTypes: input.allowedToolTypes,
        runSubagents: input.runSubagents,
        readSubagent: input.readSubagent,
        readFile: input.readFile,
        credentialBindings: input.credentialBindings,
        ensureBrowserStarted: input.ensureBrowserStarted,
        isBrowserStarted: input.isBrowserStarted,
        agentLoopTimeoutMs: input.agentLoopTimeoutMs,
        onDebug: input.onDebug,
        onToolTrace: async (trace, progress) => {
          ensureActive();
          upsertToolTrace(liveToolTraces, trace);
          latestToolProgress = progress || latestToolProgress;
          await input.onProgress?.({
            ...runningStep,
            actual: 'AI called a browser tool; waiting for page feedback.',
            tools: summarizeToolTraces(liveToolTraces),
            ...progressFieldsFromToolTraces(liveToolTraces, requirementOf(runtimeRecord), stepIndex, latestToolProgress),
          });
          ensureActive();
        },
      });
      ensureActive();
    } catch (error) {
      if (isBrowserChatAbortError(error, input.abortSignal) || (input.shouldContinue && !input.shouldContinue())) throw browserChatAbortError(input.abortSignal);
      const errorText = infrastructureError(error);
      const upstreamDisconnected = isUpstreamAiDisconnectError(error);
      if (!upstreamDisconnected && !liveToolTraces.length && isInfrastructureNoise(errorText)) {
        consecutiveAiRequestFailures += 1;
        const runningIndex = steps.findIndex((step) => step.index === stepIndex && step.status === 'running');
        if (runningIndex >= 0) steps.splice(runningIndex, 1);
        await input.onDebug?.({
          phase: 'chat:runtime:request-aborted',
          stepIndex,
          message: `Browser chat AI request failed before any browser tool executed: ${trimDebugText(errorText, 700)}`,
          details: serializeError(error),
        });
        if (consecutiveAiRequestFailures > maxConsecutiveAiRequestFailures) {
          ensureActive();
          const errorStep = await createRecoverableRuntimeErrorStep({
            session: input.session,
            runId: input.runId,
            stepIndex,
            mode: runtimeMode,
            beforeScreenshotPath,
            error,
            tools: [],
            aiRequest: error && typeof error === 'object' ? (error as { aiRequest?: AiRequestSnapshot }).aiRequest : undefined,
          });
          ensureActive();
          upsertStep(steps, errorStep);
          newSteps.push(errorStep);
          await input.onProgress?.(errorStep);
          ensureActive();
          finalStatus = 'failed';
          reply = '';
          endedWithFinalAnswer = true;
          break;
        }
        finalStatus = 'passed';
        reply = '';
        continue;
      }
      ensureActive();
      const recoveredState = progressFieldsFromToolTraces(liveToolTraces, requirementOf(runtimeRecord), stepIndex, latestToolProgress);
      const errorStep = await createRecoverableRuntimeErrorStep({
        session: input.session,
        runId: input.runId,
        stepIndex,
        mode: runtimeMode,
        beforeScreenshotPath,
        error,
        tools: summarizeToolTraces(liveToolTraces),
        aiRequest: error && typeof error === 'object' ? (error as { aiRequest?: AiRequestSnapshot }).aiRequest : undefined,
        recoveredState,
      });
      ensureActive();
      upsertStep(steps, errorStep);
      newSteps.push(errorStep);
      await input.onProgress?.(errorStep);
      ensureActive();
      await input.onDebug?.({
        phase: 'ai:runtime:recoverable-error',
        stepIndex,
        message: userFacingRecoverableRuntimeError(error),
        details: {
          error: serializeError(error),
          screenshotPath: errorStep.screenshotPath,
          aiRequest: errorStep.aiRequest,
          tools: errorStep.tools,
          upstreamDisconnected,
        },
      });
      if (upstreamDisconnected) {
        finalStatus = 'failed';
        reply = userFacingRecoverableRuntimeError(error);
        endedWithFinalAnswer = true;
        break;
      }
      reply = '';
      continue;
    }

    ensureActive();
    consecutiveAiRequestFailures = 0;
    const browserChatReply = actionResult.endedWithText ? textFromUnknown(actionResult.text).trim() : '';
    if (!actionResult.traces.length) {
      const runningIndex = steps.findIndex((step) => step.index === stepIndex && step.status === 'running');
      if (runningIndex >= 0) steps.splice(runningIndex, 1);
      const hasRequiredToolEvidence = requiredTool ? browserChatTurnHasToolEvidence(newSteps, requiredTool) : false;
      const unsupportedActionClaim = browserChatReplyClaimsBrowserAction(browserChatReply)
        && !browserChatTurnHasToolEvidence(newSteps, 'action');
      const rejectDirectAnswer = Boolean(browserChatReply && (
        (requiredTool && !hasRequiredToolEvidence)
        || unsupportedActionClaim
      ));
      if (rejectDirectAnswer) {
        rejectedDirectAnswerCount += 1;
        await input.onDebug?.({
          phase: 'chat:direct-answer-rejected',
          stepIndex,
          message: `Rejected text-only browser completion claim ${rejectedDirectAnswerCount}; required tool evidence was missing.`,
          details: {
            requiredTool,
            unsupportedActionClaim,
            reply: browserChatReply,
          },
        });
        if (rejectedDirectAnswerCount <= 2) continue;
        reply = '本轮没有执行所请求的浏览器操作：模型连续返回了缺少工具证据的完成声明，系统已拒绝将其记为成功。请重试本条指令。';
        finalStatus = 'failed';
        endedWithFinalAnswer = true;
        break;
      }
      await input.onDebug?.({
        phase: browserChatReply ? 'chat:direct-answer' : 'chat:no-tool-response',
        stepIndex,
        message: browserChatReply
          ? 'Browser chat completed with an explicit Markdown answer and no browser tool.'
          : 'Browser chat returned no browser tool and no explicit final answer; continuing until the AI explicitly answers, blocks, or is stopped.',
      });
      if (browserChatReply) {
        reply = browserChatReply;
        finalStatus = 'passed';
        endedWithFinalAnswer = true;
        break;
      }
      continue;
    }

    const afterScreenshotPath = await takeStepScreenshot('after', stepIndex);
    const decision = deriveBrowserChatStepDecision(actionResult.text, actionResult.traces, requirementOf(runtimeRecord));
    const completedStep: StepExecutionResult = {
      index: stepIndex,
      action: decision.action,
      expected: decision.expected,
      actual: decision.actual,
      status: decision.status,
      note: decision.note,
      taskFrame: decision.taskFrame || actionResult.workingMemory.taskFrame,
      ledgerItems: mergeLedgerItems(decision.ledgerItems || [], actionResult.workingMemory.ledgerItems || [], ledgerMemoryLimit())
        .map((item) => ({ ...item, sourceStep: item.sourceStep ?? stepIndex })),
      aiRequest: actionResult.aiRequest,
      beforeScreenshotPath,
      afterScreenshotPath,
      screenshotPath: afterScreenshotPath,
      tools: summarizeToolTraces(actionResult.traces),
      visualContext: actionResult.visualContext,
      workingMemory: actionResult.workingMemory,
    };
    upsertStep(steps, completedStep);
    newSteps.push(completedStep);
    ensureActive();
    await input.onProgress?.(completedStep);
    ensureActive();
    const completedTurnHasRequiredTool = requiredTool ? browserChatTurnHasToolEvidence(newSteps, requiredTool) : false;
    const completedTurnUnsupportedActionClaim = browserChatReplyClaimsBrowserAction(browserChatReply)
      && !browserChatTurnHasToolEvidence(newSteps, 'action');
    const rejectCompletedTurnReply = Boolean(browserChatReply && (
      (requiredTool && !completedTurnHasRequiredTool)
      || completedTurnUnsupportedActionClaim
    ));
    if (rejectCompletedTurnReply) {
      rejectedDirectAnswerCount += 1;
      await input.onDebug?.({
        phase: 'chat:direct-answer-rejected',
        stepIndex,
        message: `Rejected browser completion claim ${rejectedDirectAnswerCount}; the executed tools did not satisfy the required ${requiredTool || 'action'} evidence.`,
        details: {
          requiredTool,
          unsupportedActionClaim: completedTurnUnsupportedActionClaim,
          reply: browserChatReply,
          tools: completedStep.tools,
        },
      });
      if (rejectedDirectAnswerCount <= 2) {
        reply = '';
        continue;
      }
      reply = '本轮没有执行所请求的浏览器操作：模型连续返回了与工具证据不一致的完成声明，系统已拒绝将其记为成功。请重试本条指令。';
      finalStatus = 'failed';
      endedWithFinalAnswer = true;
      break;
    }
    if (browserChatReply) reply = browserChatReply;

    const lastToolName = actionResult.traces.at(-1)?.name;
    if (browserChatReply) {
      finalStatus = decision.status === 'failed' || decision.status === 'blocked' ? decision.status : 'passed';
      endedWithFinalAnswer = true;
      break;
    }
    if (lastToolName === 'waitForHumanVerification') {
      finalStatus = 'blocked';
      if (!reply) reply = browserChatReplyFromDecision(decision, lastToolName);
      endedWithFinalAnswer = true;
      break;
    }
    if (decision.done || lastToolName === 'reportState') {
      finalStatus = decision.status === 'failed' || decision.status === 'blocked' ? decision.status : 'passed';
      if (!reply) reply = browserChatReplyFromDecision(decision, lastToolName);
      endedWithFinalAnswer = true;
      break;
    }
  }

  if (!endedWithFinalAnswer) reply = '';

  ensureActive();
  return {
    status: finalStatus,
    reply,
    steps,
    newSteps,
    consoleErrors: input.session.getConsoleErrors(),
    networkErrors: input.session.getNetworkErrors(),
  };
}

function errorRecordSources(error: unknown) {
  if (!error || typeof error !== 'object') return [];
  const root = error as Record<string, unknown>;
  const sources: Record<string, unknown>[] = [root];
  if (root.data && typeof root.data === 'object' && !Array.isArray(root.data)) {
    sources.push(root.data as Record<string, unknown>);
  }
  if (root.cause && typeof root.cause === 'object' && !Array.isArray(root.cause)) {
    const cause = root.cause as Record<string, unknown>;
    sources.push(cause);
    if (cause.data && typeof cause.data === 'object' && !Array.isArray(cause.data)) {
      sources.push(cause.data as Record<string, unknown>);
    }
  }
  return sources;
}

function firstErrorString(error: unknown, key: string) {
  for (const source of errorRecordSources(error)) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function firstErrorValue(error: unknown, key: string) {
  for (const source of errorRecordSources(error)) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    return value;
  }
  return undefined;
}

function firstErrorDisplay(error: unknown, key: string, max = 900) {
  return diagnosticValueText(firstErrorValue(error, key), max);
}

function firstErrorNumber(error: unknown, key: string) {
  for (const source of errorRecordSources(error)) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function errorCauseMessage(error: unknown) {
  if (!error || typeof error !== 'object') return undefined;
  const cause = (error as Record<string, unknown>).cause;
  if (cause instanceof Error) return cause.message;
  if (cause && typeof cause === 'object' && !Array.isArray(cause)) {
    const message = (cause as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return undefined;
}

function errorDetailText(error: unknown) {
  const exitCode = firstErrorNumber(error, 'exitCode');
  const code = firstErrorString(error, 'code');
  const status = firstErrorValue(error, 'status') ?? firstErrorValue(error, 'statusCode');
  const stderr = firstErrorString(error, 'stderr');
  const responseBody = firstErrorDisplay(error, 'responseBody', 1200) || firstErrorDisplay(error, 'body', 1200);
  const promptExcerpt = firstErrorString(error, 'promptExcerpt');
  return [
    typeof exitCode === 'number' ? `exitCode=${exitCode}` : '',
    code ? `code=${code}` : '',
    status !== undefined ? `status=${diagnosticValueText(status, 120)}` : '',
    stderr ? `stderr=${trimDebugText(stderr, 1200)}` : '',
    responseBody ? `responseBody=${responseBody}` : '',
    promptExcerpt ? `promptExcerpt=${trimDebugText(promptExcerpt, 600)}` : '',
  ].filter(Boolean).join('\n');
}

function infrastructureError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || 'Unknown execution error');
  const details = errorDetailText(error);
  return details ? `${message}\n${details}` : message;
}

function isUpstreamAiDisconnectError(error: unknown) {
  return Boolean(upstreamApiDisconnectReason(infrastructureError(error)));
}

function userFacingRecoverableRuntimeError(error: unknown) {
  return userFacingInfrastructureError(infrastructureError(error), {
    error,
    aiRequest: aiRequestFromError(error),
  });
}

function serializeError(error: unknown) {
  if (!(error instanceof Error)) return { message: String(error) };
  return {
    name: error.name,
    message: error.message,
    exitCode: firstErrorNumber(error, 'exitCode'),
    code: firstErrorString(error, 'code'),
    status: firstErrorValue(error, 'status'),
    statusCode: firstErrorValue(error, 'statusCode'),
    stderr: firstErrorString(error, 'stderr'),
    responseBody: firstErrorDisplay(error, 'responseBody', 2000),
    body: firstErrorDisplay(error, 'body', 2000),
    causeMessage: errorCauseMessage(error),
    promptExcerpt: firstErrorString(error, 'promptExcerpt'),
    stack: error.stack,
  };
}

async function createRecoverableRuntimeErrorStep(input: {
  session: BrowserSession;
  runId: string;
  stepIndex: number;
  mode?: BrowserSessionMode;
  beforeScreenshotPath?: string;
  error: unknown;
  tools?: StepToolCall[];
  aiRequest?: AiRequestSnapshot;
  recoveredState?: Partial<StepExecutionResult>;
}): Promise<StepExecutionResult> {
  const { session, runId, stepIndex, mode, beforeScreenshotPath, error, tools, aiRequest, recoveredState } = input;
  const afterScreenshotPath = mode === 'dom'
    ? undefined
    : await session.takeScreenshot(runId, stepIndex, 'after').catch(() => undefined);
  const upstreamDisconnected = isUpstreamAiDisconnectError(error);

  return {
    index: stepIndex,
    action: upstreamDisconnected
      ? 'Upstream AI connection was interrupted; stopping this browser-chat turn'
      : 'AI request or response handling failed; continuing automatically',
    expected: upstreamDisconnected
      ? 'The assistant should stop this turn and show the upstream disconnect reason to the user.'
      : mode === 'dom'
        ? 'A single AI request/tool/parse failure should not stop the flow; the next round will continue from the latest page context.'
        : 'A single AI request/tool/parse failure should not stop the flow; the next round will continue from the latest screenshot.',
    actual: userFacingRecoverableRuntimeError(error),
    status: 'failed',
    beforeScreenshotPath,
    afterScreenshotPath,
    screenshotPath: afterScreenshotPath,
    taskFrame: recoveredState?.taskFrame,
    ledgerItems: recoveredState?.ledgerItems,
    workingMemory: recoveredState?.workingMemory,
    visualContext: recoveredState?.visualContext,
    tools,
    aiRequest,
  };
}

function flowInput(input: unknown) {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

async function runRecordedTool(
  session: BrowserSession,
  flow: RecordedFlowStep,
  runId?: string,
  abortSignal?: AbortSignal,
  credentialBindings?: BrowserCodeCredentialBinding[],
): Promise<BrowserActionResult> {
  const input = flowInput(flow.input);
  const reason = flow.reason ? ` Recorded reason: ${flow.reason}` : '';

  switch (flow.name) {
    case 'browserCode':
      return session.executeBrowserCode({
        code: typeof input.code === 'string' ? input.code : '',
        maxOutputChars: typeof input.maxOutputChars === 'number' ? input.maxOutputChars : undefined,
        credentials: credentialBindings,
        runId: runId || 'browser-code',
        stepIndex: flow.index,
        abortSignal,
      });
    case 'clickByUid':
      return session.mouse({
        action: 'click',
        uid: typeof input.uid === 'string' ? input.uid : '',
        abortSignal,
      });
    case 'waitForHumanVerification':
      return session.waitForManualVerification(typeof input.maxMs === 'number' ? input.maxMs : undefined);
    case 'downloadFile':
      return downloadFileArtifact({
        runId,
        url: typeof input.url === 'string' ? input.url : undefined,
        path: typeof input.path === 'string' ? input.path : undefined,
        urlOrPath: typeof input.urlOrPath === 'string' ? input.urlOrPath : undefined,
        sourcePageUrl: session.currentUrl(),
        fileName: typeof input.fileName === 'string' ? input.fileName : undefined,
      });
    case 'generateMarkdownFile':
      return generateMarkdownArtifact({
        runId,
        fileName: typeof input.fileName === 'string' ? input.fileName : undefined,
        title: typeof input.title === 'string' ? input.title : undefined,
        content: typeof input.content === 'string' ? input.content : typeof input.text === 'string' ? input.text : undefined,
      });
    case 'reportState':
      return { ok: true, actual: `Reported state without browser action: ${String(input.actual || input.reason || '')}` };
    default:
      return { ok: false, actual: `Unsupported recorded tool: ${flow.name}.${reason}` };
  }
}

async function executeCodexRuntimeObject(input: {
  session: BrowserSession;
  runId: string;
  stepIndex: number;
  mode: BrowserSessionMode;
  type: string;
  message?: string;
  params: Record<string, unknown>;
  allowedTypes: string[];
  traces: ToolTrace[];
  aiRequest?: AiRequestSnapshot;
  visualContext?: VisualContextManager;
  abortSignal?: AbortSignal;
  shouldContinue?: () => boolean;
  requestToolConfirmation?: (request: BrowserToolConfirmationRequest) => Promise<BrowserToolConfirmationDecision>;
  runSubagents?: BrowserChatSubagentRunner;
  readSubagent?: BrowserChatSubagentReader;
  readFile?: (input: { attachmentId?: string; artifactId?: string; limit?: number; offset?: number }) => Promise<BrowserActionResult>;
  credentialBindings?: BrowserCodeCredentialBinding[];
  ensureBrowserStarted?: () => Promise<void>;
  onVisualContextChange?: (snapshot: ReturnType<VisualContextManager['snapshot']>) => void | Promise<void>;
  onToolTrace?: (trace: ToolTrace, progress?: ToolTraceProgress) => void | Promise<void>;
  onDebug?: ExecutionDebug;
  onReferenceImage?: (path: string) => void;
}) {
  const { session, runId, stepIndex, type, message, params, allowedTypes, traces, aiRequest, visualContext, abortSignal, shouldContinue, requestToolConfirmation, runSubagents, readSubagent, readFile, credentialBindings, ensureBrowserStarted, onVisualContextChange, onToolTrace, onDebug, onReferenceImage } = input;
  throwIfStopped(abortSignal, shouldContinue);
  if (!allowedTypes.includes(type)) {
    return {
      text: `Codex returned unsupported action type: ${type}. Allowed types: ${allowedTypes.join(', ')}.`,
      executed: false,
    };
  }

  if (type === 'answer') {
    const answerText = [
      message,
      typeof params.text === 'string' ? params.text : '',
      typeof params.content === 'string' ? params.content : '',
      typeof params.actual === 'string' ? params.actual : '',
    ].map((item) => (item || '').trim()).find(Boolean) || '';
    return {
      text: readableActionFromRawText(answerText) || answerText,
      executed: false,
    };
  }

  let normalizedParams = { ...params };
  if (type === 'browserCode') normalizedParams = browserCodeInputWithRisk(normalizedParams, Boolean(requestToolConfirmation));
  if (type === 'readFile') normalizedParams.limit = normalizeBrowserChatFileReadLimit(normalizedParams.limit);
  const flow: RecordedFlowStep = {
    index: stepIndex,
    name: type,
    input: normalizedParams,
    reason: typeof normalizedParams.reason === 'string' ? normalizedParams.reason : undefined,
  };
  const pendingConfirmation = requestToolConfirmation ? toolConfirmationFromInput(type, normalizedParams) : undefined;
  const runTool = async (toolCallId?: string) => {
    if (type === 'spawnSubagents') {
      if (!runSubagents) return { ok: false, actual: 'spawnSubagents is unavailable in this runtime.' };
      const tasks = Array.isArray(normalizedParams.tasks) ? normalizedParams.tasks.flatMap((raw): BrowserChatSubagentTask[] => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
        const item = raw as Record<string, unknown>;
        const title = typeof item.title === 'string' ? item.title.trim() : '';
        const instruction = typeof item.instruction === 'string' ? item.instruction.trim() : '';
        if (!title || !instruction) return [];
        return [{ title, instruction, url: typeof item.url === 'string' ? item.url : undefined }];
      }).slice(0, 6) : [];
      if (!tasks.length) return { ok: false, actual: 'spawnSubagents requires at least one valid task.' };
      return runSubagents(tasks, abortSignal, toolCallId);
    }
    if (type === 'readSubagent') {
      if (!readSubagent) return { ok: false, actual: 'readSubagent is unavailable in this runtime.' };
      const uuid = typeof normalizedParams.uuid === 'string' ? normalizedParams.uuid.trim() : '';
      if (!uuid) return { ok: false, actual: 'readSubagent requires one UUID.' };
      return readSubagent(uuid);
    }
    if (type === 'readFile') {
      if (!readFile) return { ok: false, actual: 'readFile is unavailable in this runtime.' };
      const attachmentId = typeof normalizedParams.attachmentId === 'string' ? normalizedParams.attachmentId.trim() : undefined;
      const artifactId = typeof normalizedParams.artifactId === 'string' ? normalizedParams.artifactId.trim() : undefined;
      if (Boolean(attachmentId) === Boolean(artifactId)) return { ok: false, actual: 'readFile requires exactly one attachmentId or artifactId.' };
      return readFile({
        attachmentId,
        artifactId,
        limit: typeof normalizedParams.limit === 'number' ? normalizedParams.limit : undefined,
        offset: typeof normalizedParams.offset === 'number' ? normalizedParams.offset : undefined,
      });
    }
    return runRecordedTool(session, flow, runId, abortSignal, credentialBindings);
  };

  const result = await executeTracedBrowserAction({
    session,
    traces,
    name: type,
    toolInput: normalizedParams,
    aiRequest,
    runId,
    stepIndex,
    visualContext,
    abortSignal,
    shouldContinue,
    onDebug,
    onToolTrace,
    onVisualContextChange,
    action: async (_actionSignal, trace) => {
      if (pendingConfirmation && requestToolConfirmation) {
        const decision = await requestToolConfirmation({
          toolName: type,
          input: normalizedParams,
          reason: pendingConfirmation.reason,
          prompt: pendingConfirmation.prompt,
          stepIndex,
        });
        throwIfStopped(abortSignal, shouldContinue);
        if (decision !== 'confirmed') {
          return {
            ok: true,
            actual: 'Skipped before execution because the user cancelled this confirmed tool call. Do not retry the same operation in this turn unless the user explicitly asks again.',
          } satisfies BrowserActionResult;
        }
        if (toolRequiresBrowserSession(type)) await ensureBrowserStarted?.();
        const result = await runTool(trace?.id);
        return {
          ...result,
          actual: `用户已确认本次工具调用，现已执行。\n${result.actual}`,
        } satisfies BrowserActionResult;
      }
      if (toolRequiresBrowserSession(type)) await ensureBrowserStarted?.();
      return runTool(trace?.id);
    },
  });
  const imagePaths = result.referenceImagePaths?.length
    ? result.referenceImagePaths
    : result.referenceImagePath ? [result.referenceImagePath] : [];
  for (const imagePath of new Set(imagePaths)) onReferenceImage?.(imagePath);
  const fileResult = result.ok ? formatFileArtifactResult(type, result.actual) : undefined;
  return { text: fileResult || toolConsistentAssistantText(message, type), executed: true };
}
