import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { generateText, hasToolCall, tool, type ModelMessage } from 'ai';
import sharp from 'sharp';
import { z } from 'zod';
import type { AiDomContextSnapshot, AiRequestSnapshot, AiToolContextSnapshot, DesktopActionEvidence, RecordedFlowStep, RuntimeWorkingMemory, StepExecutionResult, StepToolCall, TaskFrame, TaskLedgerItem, TestCaseRecord, VisualFrameRecord } from '@/server/ai/schemas/test-case.schema';
import { getModel, getModelSettings } from '@/server/ai/model';
import { buildCodexObjectPrompt, buildCompletionPromptLines, buildVerificationPromptLines, customRuntimePromptFromEnv } from '@/server/ai/prompts/runtime-agent.prompt';
import { BrowserSession, type BrowserActionResult, type BrowserSessionMode, type ScreenshotCaptureMode } from '@/server/browser/browser-session';
import { normalizeDomNodeIdParam, normalizeDomNodeIdString } from '@/lib/dom-path';
import { richTextToPlainText } from '@/lib/rich-text';
import { downloadFileArtifact, formatFileArtifactResult, generateMarkdownArtifact } from './file-artifact-tools';
import {
  compactStaleReadObservationMessages,
  observationPreviewLimit,
  readRuntimeObservation,
  restoreRuntimeObservationStore,
  runtimeObservationAvailableTypes,
  runtimeObservationCount,
  runtimeObservationToolNames,
  storeRuntimeObservation,
  type RuntimeObservationRecord,
  type RuntimeObservationStore,
} from './runtime-observation';
import { domCurrentContextLine, domModeActionRules, domNoScreenshotRule, domObservationHardRules } from './runtime-prompt-rules';
import { summarizeRuntimeLogTimings } from './runtime-log-timings';
import { cloneRuntimeRetryState, type RuntimeRetryState as RuntimeRetryStateBase } from './runtime-retry-state';
import { runtimeAllowedToolTypes } from './runtime-tool-selection';
import { notifyRuntimeToolTrace, runtimeToolTraceId } from './runtime-tool-trace';
import { processDomObservationInNode, type ProcessedDomObservation } from './dom-observation-processor';

type ExecutionDebug = (event: { phase: string; message: string; stepIndex?: number; details?: unknown }) => void | Promise<void>;
type RuntimeModelMessage = ModelMessage;
type RuntimeRetryState = RuntimeRetryStateBase<RuntimeModelMessage>;

type ToolTrace = {
  id?: string;
  name: string;
  input: unknown;
  result?: BrowserActionResult;
  startedAt?: number;
  completedAt?: number;
  elapsedMs?: number;
  actionElapsedMs?: number;
  postprocessTimings?: Record<string, number>;
  desktopEvidence?: DesktopActionEvidence;
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

const BATCH_FILL_FIELD_LIMIT = 80;

type BrowserChatSafetyMode = 'strict' | 'full';

export type BrowserToolConfirmationDecision = 'confirmed' | 'cancelled';

export type BrowserToolConfirmationRequest = {
  toolName: string;
  input: unknown;
  reason?: string;
  prompt: string;
  stepIndex?: number;
};

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

type ScreenshotReference = {
  id: string;
  path: string;
  stepIndex: number;
  phase: 'before' | 'after' | 'screenshot';
  sameInterfaceGroup?: string;
  description: string;
};

type SelectedScreenshotReference = ScreenshotReference & {
  selectionReason?: string;
};

const codexRuntimeObjectSchema = z.object({
  type: z.string().min(1).describe('Tool type to execute. Use reportState when the requirement is complete, blocked, impossible, or only needs a no-op status update.'),
  message: z.string().nullable().optional().describe('Optional short Chinese user-facing progress text that accompanies this tool call.'),
  params: z.object({
    reason: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    urlOrPath: z.string().nullable().optional(),
    id: z.string().nullable().optional(),
    areaId: z.string().nullable().optional(),
    text: z.string().nullable().optional(),
    content: z.string().nullable().optional(),
    fileName: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    type: z.enum(['text', 'interactive']).nullable().optional(),
    key: z.string().nullable().optional(),
    path: z.string().nullable().optional(),
    domPath: z.string().nullable().optional(),
    scopeId: z.string().nullable().optional(),
    locatorId: z.string().nullable().optional(),
    fromId: z.string().nullable().optional(),
    toId: z.string().nullable().optional(),
    index: z.number().nullable().optional(),
    ms: z.number().nullable().optional(),
    maxMs: z.number().nullable().optional(),
    deltaX: z.number().nullable().optional(),
    deltaY: z.number().nullable().optional(),
    action: z.string().nullable().optional(),
    expected: z.string().nullable().optional(),
    actual: z.string().nullable().optional(),
    status: z.enum(['passed', 'failed', 'blocked']).nullable().optional(),
    done: z.boolean().nullable().optional(),
    targetVisual: z.string().nullable().optional(),
    targetText: z.string().nullable().optional(),
    ids: z.array(z.string()).nullable().optional(),
    fields: z.array(z.object({
      id: z.string().min(1),
      text: z.string().nullable().optional(),
      clear: z.boolean().nullable().optional(),
      targetVisual: z.string().nullable().optional(),
    })).nullable().optional(),
    selectionReason: z.string().nullable().optional(),
    sameInterfaceGroup: z.string().nullable().optional(),
    requiresConfirmation: z.boolean().nullable().optional(),
    confirmationMessage: z.string().nullable().optional(),
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

function browserModeOf(testCase: TestCaseRecord): BrowserSessionMode {
  void testCase;
  return browserModeFromEnv();
}

function isVisualMode(mode: BrowserSessionMode) {
  void mode;
  return false;
}

function runtimePageContextOptions(mode: BrowserSessionMode, options: { includeDomTree?: boolean } = {}) {
  void mode;
  const includeDomTree = options.includeDomTree === true;
  return {
    domScope: 'full' as const,
    includeDomTree,
    includeText: false,
    includeManualVerification: false,
    includeInteractiveCandidates: false,
    textMaxChars: 0,
    useCachedInteractiveCandidates: false,
  };
}

type RuntimePageContext = Awaited<ReturnType<BrowserSession['getPageContext']>>;

function domTreePromptLimit() {
  const raw = String(process.env.DOM_TREE_PROMPT_MAX_CHARS || '').trim();
  if (!raw || /^(0|false|none|off|unlimited)$/i.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function domTreeForPrompt(rawTree: string) {
  const limit = domTreePromptLimit();
  return limit ? trimDebugText(rawTree, limit) : rawTree;
}

function domPageTextPromptLimit() {
  const raw = String(process.env.DOM_PAGE_TEXT_PROMPT_MAX_CHARS || process.env.PAGE_TEXT_PROMPT_MAX_CHARS || '').trim();
  if (!raw || /^(0|false|none|off|unlimited)$/i.test(raw)) return 0;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function pageTextForPrompt(rawText: string) {
  const limit = domPageTextPromptLimit();
  return limit ? trimDebugText(rawText, limit) : rawText;
}

function createDomContextSnapshot(mode: BrowserSessionMode, pageContext: RuntimePageContext): AiDomContextSnapshot | undefined {
  void mode;
  const rawTree = pageContext.domTree || '[empty DOM tree]';
  const promptCharLimit = domTreePromptLimit();
  const tree = domTreeForPrompt(rawTree);
  return {
    mode: 'dom',
    source: 'runtime-page-context',
    generatedAt: new Date().toISOString(),
    url: pageContext.url,
    title: pageContext.title,
    tree,
    treeCharLength: rawTree.length,
    promptCharLimit,
    truncated: Boolean(promptCharLimit && rawTree.length > promptCharLimit),
    focusedElement: pageContext.focusedElement,
    pageScrollState: pageContext.pageScrollState,
    scrollableAreas: pageContext.scrollableAreas,
    interactiveCandidates: pageContext.interactiveCandidates,
  };
}

function toolContextFromAiRequest(aiRequest?: AiRequestSnapshot): AiToolContextSnapshot | undefined {
  if (!aiRequest?.id && !aiRequest?.domContext) return undefined;
  return {
    requestId: aiRequest.id,
    requestCreatedAt: aiRequest.createdAt,
    domContext: aiRequest.domContext,
  };
}

// 是否启用视觉候选标识。关闭时仍发送截图，但候选元素只以文本摘要进入 prompt。
function visualMarkersEnabledFor(testCase: TestCaseRecord) {
  if (typeof testCase.content.isMarked === 'boolean') return testCase.content.isMarked;
  if (process.env.VISUAL_MARKERS_IS_MARKED === 'false' || process.env.SCREENSHOT_IS_MARKED === 'false') return false;
  return true;
}

// Default to inline marker labels so visual mode screenshots show interactive targets.
function usesSeparateMarkerMap() {
  return !/^(false|0|no|off)$/i.test(String(process.env.VISUAL_MARKER_SEPARATE_MAP || 'false'));
}

// 只有视觉点击模式才允许把截图作为 AI 输入；DOM 模式即使模型支持图片也不会发送。
function shouldSendScreenshotToAi(mode: BrowserSessionMode) {
  void mode;
  return false;
}

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
async function readMarkerScreenshotForAi(filePath: string, referenceScreenshot: Buffer) {
  const markerBuffer = await readFile(filePath);
  const [referenceMetadata, markerMetadata] = await Promise.all([
    sharp(referenceScreenshot, { failOn: 'none' }).metadata(),
    sharp(markerBuffer, { failOn: 'none' }).metadata(),
  ]);
  const width = referenceMetadata.width;
  const height = referenceMetadata.height;
  if (!width || !height || (markerMetadata.width === width && markerMetadata.height === height)) return markerBuffer;

  return sharp(markerBuffer, { failOn: 'none' })
    .resize({ width, height, fit: 'fill' })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function trimDebugText(value: string, max = 4000) {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function looksLikeDomSnapshot(value?: string) {
  const text = (value || '').trim();
  if (!text || !/\bnode_id=\d+\b/.test(text)) return false;
  return /<\s*(?:a|button|input|select|textarea|option|summary|details|label|form|iframe)\b/i.test(text);
}

function providerToolSchemaError(value?: string) {
  return /Failed to deserialize the JSON body|unknown variant `?custom`?|invalid_request_error|AnthropicException|litellm\.BadRequestError/i.test(value || '');
}

const untrimmedToolResultNames = new Set(['fillCandidates']);

function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  const numberValue = typeof value === 'number' ? value : Number(value);
  const normalized = Number.isFinite(numberValue) ? Math.floor(numberValue) : fallback;
  return Math.min(Math.max(normalized, min), max);
}

function runtimeRequestConsecutiveFailureLimit(browserChatMode: boolean) {
  const retryEnabled = browserChatMode || process.env.AI_RUNTIME_RETRY_ON_PURE_FAILURE === 'true';
  if (!retryEnabled) return 1;
  return boundedInteger(process.env.AI_RUNTIME_REQUEST_RETRY_ATTEMPTS, browserChatMode ? 3 : 2, 1, 10);
}

function domSnapshotDebug(pageContext: RuntimePageContext, domContext?: AiDomContextSnapshot) {
  if (!pageContext.domTree) return undefined;
  const rawTree = pageContext.domTree || '[empty DOM tree]';
  return {
    fullDomSnapshot: rawTree,
    fullDomSnapshotCharLength: rawTree.length,
    domSnapshotPromptCharLimit: domContext?.promptCharLimit,
    domSnapshotTruncatedForModel: domContext?.truncated,
  };
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

function userFacingToolResult(name: string, result?: BrowserActionResult, max = 360) {
  if (!result) return undefined;
  const resultMax = untrimmedToolResultNames.has(name) ? Number.MAX_SAFE_INTEGER : max;
  if (!result.ok && providerToolSchemaError(result.actual)) return userFacingInfrastructureError(result.actual);
  if (!result.ok) return trimDebugText(result.actual, resultMax);
  if (looksLikeDomSnapshot(result.actual)) return '已读取当前可见 DOM 快照。';
  if (name === 'getInteractiveCandidates') return '已读取当前可见可交互元素。';
  if (name === 'getHttpRequests') return '已读取当前标签页的网络请求记录。';
  if (name === 'listTabs') return '已读取浏览器标签页列表。';
  if (name === 'downloadFile' || name === 'generateMarkdownFile') return formatFileArtifactResult(name, result.actual);
  return trimDebugText(result.actual, resultMax);
}

function modelToolResultLimit(name: string) {
  const observationTool = name === 'getPageState' || name === 'readObservation';
  const raw = Number(
    observationTool
      ? process.env.AI_OBSERVATION_TOOL_RESULT_MAX_CHARS || process.env.AI_TOOL_RESULT_MAX_CHARS || 10000
      : process.env.AI_TOOL_RESULT_MAX_CHARS || 6000,
  );
  const fallback = observationTool ? 10000 : 6000;
  const min = observationTool ? 10000 : 1200;
  const value = Math.floor(Number.isFinite(raw) ? raw : fallback);
  return Math.min(Math.max(value, min), 30000);
}

function compactToolResultForModel(
  name: string,
  result: BrowserActionResult,
  observationStore?: RuntimeObservationStore,
  runId?: string,
): BrowserActionResult {
  const { debug: _debug, observationViews, ...modelResult } = result;
  void _debug;
  if (!modelResult.actual) return modelResult;
  if (runtimeObservationToolNames.has(name)) return modelResult;
  const limit = modelToolResultLimit(name);
  if (modelResult.actual.length <= limit) return modelResult;
  const previewLimit = observationStore ? Math.min(limit, observationPreviewLimit(name)) : limit;
  const omitted = modelResult.actual.length - previewLimit;
  const observation = observationStore && name === 'getPageState'
    ? storeRuntimeObservation(observationStore, runId, name, modelResult.actual, observationViews)
    : undefined;
  const availableTypes = observation
    ? runtimeObservationAvailableTypes(observation)
    : '';
  return {
    ...modelResult,
    actual: [
      modelResult.actual.slice(0, previewLimit),
      '',
      observation
        ? `[Current getPageState observation refreshed for this run: tool=${name}, defaultType=${observation.defaultType}, availableTypes=${availableTypes}, totalChars=${observation.totalChars}, previewChars=${previewLimit}, omittedChars=${omitted}. Use readObservation(type="text"|"interactive", offset, maxChars>=10000) to inspect the current observation.]`
        : `[Tool result truncated for model context: ${omitted} characters omitted from ${name}. Use a narrower text query, HTTP filter, or another observation tool call if more detail is required.]`,
    ].join('\n'),
  };
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
  const nativeToolLoop = typeof (options as { prepareStep?: unknown }).prepareStep === 'function';
  const raw = Number(
    nativeToolLoop
      ? process.env.AI_AGENT_LOOP_TIMEOUT_MS || process.env.AI_TEST_REQUEST_TIMEOUT_MS || 120000
      : process.env.AI_TEST_REQUEST_TIMEOUT_MS || 30000,
  );
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : nativeToolLoop ? 120000 : 30000;
}

async function generateTextWithTimeout(options: Parameters<typeof generateText>[0]) {
  throwIfAborted(options.abortSignal);
  const timeoutMs = generateTextTimeoutMs(options);
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new Error(`AI request timed out after ${timeoutMs}ms`)), timeoutMs);
  const upstream = options.abortSignal;
  const abortSignal = upstream ? AbortSignal.any([upstream, timeoutController.signal]) : timeoutController.signal;
  try {
    return await generateText({ ...options, abortSignal });
  } catch (error) {
    if (isBrowserChatAbortError(error, upstream)) throw browserChatAbortError(upstream);
    if (timeoutController.signal.aborted && !upstream?.aborted) {
      const timeoutError = new Error(`AI request timed out after ${timeoutMs}ms`);
      (timeoutError as { cause?: unknown }).cause = error;
      throw timeoutError;
    }
    throw error;
  } finally {
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

function requirementOf(testCase: TestCaseRecord) {
  return richTextToPlainText(testCase.content.userRequirement || testCase.description) || testCase.description || testCase.title;
}

// 读取测试用例上的额外系统提示词，例如级联选择器必须选到叶子节点。
function systemPromptOf(testCase: TestCaseRecord) {
  return richTextToPlainText(testCase.content.systemPrompt || '').trim();
}

function isBrowserChatTestCase(testCase: TestCaseRecord) {
  return testCase.id.startsWith('chat_') || testCase.title === 'Browser chat operation';
}

// 将浏览器工具调用轨迹压缩为步骤证据，保存到运行历史中。
const browserChatDefaultSystemPrompt = 'This is an interactive browser chat. Do not assume a fixed test-case script; operate from the live page and answer the latest user message in Chinese.';

function browserChatSystemPromptForRuntime(value: string) {
  return value.replace(browserChatDefaultSystemPrompt, '').trim();
}

function summarizeToolTraces(traces: ToolTrace[]): StepToolCall[] {
  return traces.map((trace) => {
    const { input, reason } = splitToolInputAndReason(trace.input);
    return {
      name: trace.name,
      input,
      reason,
      ok: trace.result?.ok,
      result: userFacingToolResult(trace.name, trace.result, 360),
      debug: trace.result?.debug,
      desktopEvidence: trace.desktopEvidence,
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

function screenshotPhaseLabel(phase: ScreenshotReference['phase']) {
  if (phase === 'before') return 'before action';
  if (phase === 'after') return 'after action';
  return 'step screenshot';
}

function screenshotReferenceGroupOf(step: StepExecutionResult) {
  const scrollTool = (step.tools || []).find((toolCall) => toolCall.name === 'scrollArea');
  if (!scrollTool) return undefined;
  const input = scrollTool.input && typeof scrollTool.input === 'object' && !Array.isArray(scrollTool.input)
    ? scrollTool.input as Record<string, unknown>
    : {};
  const area = typeof input.areaId === 'string' ? input.areaId : 'page';
  return `scroll-step-${step.index}-${area}`;
}

function buildAvailableScreenshotReferences(steps: StepExecutionResult[], limit = Number(process.env.AI_PROMPT_SCREENSHOT_REFERENCE_LIMIT || 2)): ScreenshotReference[] {
  const refs: ScreenshotReference[] = [];
  for (const step of steps) {
    const entries: Array<{ phase: ScreenshotReference['phase']; path?: string }> = [
      { phase: 'after', path: step.afterScreenshotPath },
      { phase: 'screenshot', path: step.screenshotPath },
      { phase: 'before', path: step.beforeScreenshotPath },
    ];
    const seenPaths = new Set<string>();
    for (const entry of entries) {
      if (!entry.path || seenPaths.has(entry.path)) continue;
      seenPaths.add(entry.path);
      const group = screenshotReferenceGroupOf(step);
      refs.push({
        id: `step-${step.index}-${entry.phase}`,
        path: entry.path,
        stepIndex: step.index,
        phase: entry.phase,
        sameInterfaceGroup: group,
        description: `Step ${step.index} ${screenshotPhaseLabel(entry.phase)}`,
      });
    }
  }
  return refs.slice(-limit);
}

function formatScreenshotReferences(refs: ScreenshotReference[]) {
  if (!refs.length) return '[none]';
  return refs.map((ref) => [
    `- ${ref.id}`,
    `step ${ref.stepIndex}`,
    ref.phase,
  ].filter(Boolean).join(' | ')).join('\n');
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
    const desktop = trace.desktopEvidence ? `; desktop=${sanitizeHistoricalToolText(trace.desktopEvidence.summary, 180)}` : '';
    const why = reason ? `; reason=${sanitizeHistoricalToolText(reason, 140)}` : '';
    return `${index + 1}. ${trace.name}: ${status}${why}${desktop}${shots}`;
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

function agentLoopSummaryInputCharLimit() {
  const raw = Number(process.env.AI_AGENT_LOOP_SUMMARY_INPUT_MAX_CHARS || 60000);
  return Number.isFinite(raw) && raw > 1000 ? Math.floor(raw) : 60000;
}

function buildContinuationSummaryPrompt(input: {
  goal: string;
  browserMode: BrowserSessionMode;
  stepIndex: number;
  agentStep: number;
  estimatedTokens: number;
  thresholdTokens: number;
  modelMessages: unknown;
}) {
  const serializedMessages = trimDebugText(
    JSON.stringify(input.modelMessages, null, 2),
    agentLoopSummaryInputCharLimit(),
  );
  return [
    'You are compressing a WebPilot browser-agent loop so the SAME user request can continue in a fresh model context.',
    'Return concise JSON only. Do not use markdown.',
    '',
    'Required JSON shape:',
    '{ "goal": string, "completed": string[], "currentPage": string, "importantEvidence": string[], "openObservations": string[], "remaining": string[], "nextStep": string }',
    '',
    'Rules:',
    '- Preserve that readObservation always reads only the latest getPageState observation; old readObservation output may be stale.',
    '- Preserve tool results that materially affect the next action.',
    '- Preserve current URL/page state, blockers, manual verification state, and user constraints.',
    '- Do not include raw screenshots, candidate coordinates, full DOM dumps, long logs, or old tool parameter JSON unless essential.',
    '- Write Chinese for user-facing summaries when possible.',
    '',
    `Goal: ${input.goal}`,
    `Executor step: ${input.stepIndex}`,
    `Agent step before compression: ${input.agentStep}`,
    `Browser mode: ${input.browserMode}`,
    `Estimated model-context tokens: ${input.estimatedTokens}/${input.thresholdTokens}`,
    '',
    `Sanitized model messages JSON:\n${serializedMessages}`,
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

function isUsefulHistoryStep(step: StepExecutionResult) {
  const text = `${step.action}\n${step.actual}\n${step.note || ''}`;
  if (isInfrastructureNoise(text)) return false;
  return Boolean(
    step.status === 'passed'
    || step.observation
    || step.findings?.length
    || step.memoryItems?.length
    || step.tools?.length,
  );
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

function summarizeStepToolCallForPrompt(toolCall: StepToolCall) {
  const reason = sanitizeHistoricalToolText(toolCall.reason, 140);
  const result = sanitizeHistoricalToolText(toolCall.result, 140);
  return `${toolCall.name}${toolCall.ok === false ? ' failed' : ''}${reason ? `: ${reason}` : result ? `: ${result}` : ''}`;
}

function buildCompactRunContext(steps: StepExecutionResult[], activeMemory?: RuntimeWorkingMemory) {
  const usefulSteps = steps.filter(isUsefulHistoryStep);
  const latestStep = usefulSteps.at(-1);
  const latestTool = latestStep?.tools?.at(-1);
  const persistedWorkingMemory = steps.map((step) => step.workingMemory).filter(Boolean).at(-1);
  const latestWorkingMemory = activeMemory || persistedWorkingMemory;
  const latestNextGoal = sanitizeNextGoal(activeMemory?.nextStep || persistedWorkingMemory?.nextStep || steps.map((step) => step.workingMemory?.nextStep).filter(Boolean).at(-1));
  const currentState = sanitizeCurrentState(latestWorkingMemory?.currentState || latestWorkingMemory?.pageUnderstanding || latestStep?.observation || latestStep?.note || '');
  const nextObjective = latestNextGoal || '根据当前截图和ledgerDigest完成下一个未完成目标';
  const lastAction = activeMemory?.lastAction
    ? concise([activeMemory.lastAction, activeMemory.lastResult].filter(Boolean).join(' -> '), 180)
    : latestTool
    ? summarizeStepToolCallForPrompt(latestTool)
    : latestStep ? `Step ${latestStep.index}: ${concise(latestStep.observation || latestStep.note || latestStep.action, 140)}` : '[none]';
  const taskFrame = latestWorkingMemory?.taskFrame || collectTaskFrameFromSteps(steps);
  const durableLedgerItems = mergeLedgerItems([], [
    ...collectLedgerItemsFromSteps(steps),
    ...(activeMemory?.ledgerItems || []),
  ], ledgerMemoryLimit());
  const runState = {
    currentState: currentState || null,
    nextObjective,
    lastActionOrResult: lastAction,
    taskFrame: taskFrame || null,
    ledgerDigest: formatLedgerDigest(durableLedgerItems),
    derivedSignals: {
      completedSteps: steps.length,
      ledgerItemCount: durableLedgerItems.length,
    },
    stateRule: 'Preserve currentState and ledgerDigest as authoritative compact memory. Do not discard or overwrite prior ledger conclusions unless current evidence truly contradicts them.',
  };

  return [
    'RunState JSON (authoritative compact state):',
    JSON.stringify(runState, null, 2),
  ].join('\n');
}

function buildCompactBrowserChatContext(steps: StepExecutionResult[], activeMemory?: RuntimeWorkingMemory) {
  const usefulSteps = steps.filter(isUsefulHistoryStep);
  const latestStep = usefulSteps.at(-1);
  const latestTool = latestStep?.tools?.at(-1);
  const persistedWorkingMemory = steps.map((step) => step.workingMemory).filter(Boolean).at(-1);
  const latestWorkingMemory = activeMemory || persistedWorkingMemory;
  const latestNextGoal = sanitizeNextGoal(activeMemory?.nextStep || persistedWorkingMemory?.nextStep || steps.map((step) => step.workingMemory?.nextStep).filter(Boolean).at(-1));
  const currentState = sanitizeCurrentState(latestWorkingMemory?.currentState || latestWorkingMemory?.pageUnderstanding || latestStep?.observation || latestStep?.note || '');
  const lastAction = activeMemory?.lastAction
    ? concise([activeMemory.lastAction, activeMemory.lastResult].filter(Boolean).join(' -> '), 180)
    : latestTool
    ? summarizeStepToolCallForPrompt(latestTool)
    : latestStep ? `Step ${latestStep.index}: ${concise(latestStep.observation || latestStep.note || latestStep.action, 140)}` : '[none]';
  const runState = {
    currentState: currentState || null,
    nextObjective: latestNextGoal || 'Satisfy the latest browser-chat user message.',
    lastActionOrResult: lastAction,
    completedSteps: steps.length,
  };

  return [
    'BrowserChat RunState JSON (compact context):',
    JSON.stringify(runState, null, 2),
  ].join('\n');
}

function formatLedgerDigest(items: TaskLedgerItem[], limit = Number(process.env.AI_LEDGER_DIGEST_LIMIT || 1000)) {
  if (!items.length) return [];
  return items.slice(-Math.max(1, limit)).map((item) => {
    const step = item.sourceStep ? `S${item.sourceStep}` : 'S?';
    const dimension = item.dimensionId || 'general';
    const status = item.status || 'finding';
    const severity = item.severity || 'info';
    const summary = item.summary || item.actual || item.expected || item.evidence?.[0] || '';
    return `[${step}/${dimension}/${status}/${severity}] ${concise([item.title, summary].filter(Boolean).join(': '), 180)}`;
  });
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function candidateExternalAppState(candidate: Record<string, unknown>) {
  if (candidate.opensExternalApp !== true) return '';
  const protocol = typeof candidate.externalAppProtocol === 'string' && candidate.externalAppProtocol.trim()
    ? candidate.externalAppProtocol.trim()
    : 'custom-protocol';
  return `external-app=${protocol}`;
}

function formatVisualInteractiveElements(candidates: unknown) {
  if (!Array.isArray(candidates) || !candidates.length) return '[no visible interactive elements detected]';
  return candidates.map((item, index) => {
    const candidate = item as Record<string, unknown>;
    const label = [
      candidate.name,
      candidate.text,
      candidate.ariaLabel,
      candidate.placeholder,
      candidate.title,
      candidate.nearbyText,
    ]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .find(Boolean) || '[unlabeled]';
    const role = [candidate.tag, candidate.role, candidate.type].filter(Boolean).join('/');
    const rect = candidate.rect ? ` rect=${JSON.stringify(candidate.rect)}` : '';
    const state = [
      candidate.input ? 'input' : '',
      candidate.disabled ? 'disabled' : '',
      candidateExternalAppState(candidate),
      candidate.href ? `href=${candidate.href}` : '',
      candidate.framePath ? `frame=${candidate.framePath}` : '',
    ].filter(Boolean).join(', ');
    return `${index + 1}. id=${candidate.id} ${role || 'element'} "${String(label).slice(0, 120)}"${state ? ` (${state})` : ''}${rect}`;
  }).join('\n');
}

function formatExternalAppInteractiveElements(candidates: unknown) {
  if (!Array.isArray(candidates) || !candidates.length) return '';
  const lines = candidates
    .map((item) => item as Record<string, unknown>)
    .filter((candidate) => candidate.opensExternalApp === true)
    .map((candidate) => {
      const label = [
        candidate.name,
        candidate.text,
        candidate.ariaLabel,
        candidate.placeholder,
        candidate.title,
        candidate.nearbyText,
      ]
        .map((value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''))
        .find(Boolean) || '[unlabeled]';
      const href = typeof candidate.href === 'string' && candidate.href ? ` href=${candidate.href}` : '';
      return `- id=${candidate.id} ${candidateExternalAppState(candidate)} "${String(label).slice(0, 120)}"${href}`;
    });
  return lines.join('\n');
}

function formatDomInteractiveElements(candidates: unknown) {
  if (!Array.isArray(candidates) || !candidates.length) return '[no visible interactive elements detected]';
  return candidates.map((item) => {
    const candidate = item as Record<string, unknown>;
    const label = [
      candidate.name,
      candidate.text,
      candidate.ariaLabel,
      candidate.placeholder,
      candidate.title,
      candidate.nearbyText,
    ]
      .map((value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''))
      .find(Boolean) || '[unlabeled]';
    const pathDepth = typeof candidate.path === 'string'
      ? Math.max(0, candidate.path.split('.').filter(Boolean).length - 1)
      : 0;
    const indent = '  '.repeat(Math.min(pathDepth, 10));
    const className = typeof candidate.className === 'string' && candidate.className.trim()
      ? `.${candidate.className.trim().split(/\s+/).slice(0, 3).join('.')}`
      : '';
    const role = [candidate.role, candidate.type].filter(Boolean).join('/');
    const descriptor = `${candidate.tag || 'element'}${className}${role ? `[${role}]` : ''}`;
    const signals = Array.isArray(candidate.signals)
      ? candidate.signals.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).join('|')
      : '';
    const state = [
      candidate.clickable ? 'clickable' : '',
      candidate.input ? 'input' : '',
      candidate.disabled ? 'disabled' : '',
      signals ? `signals=${signals}` : '',
      candidateExternalAppState(candidate),
      candidate.href ? `href=${candidate.href}` : '',
      candidate.framePath ? `frame=${candidate.framePath}` : '',
      candidate.shadow ? 'shadow' : '',
    ].filter(Boolean).join(', ');
    const id = typeof candidate.id === 'string' || typeof candidate.id === 'number' ? `#${candidate.id} ` : '';
    return `${indent}- ${id}${descriptor}: "${String(label).slice(0, 160)}"${state ? ` (${state})` : ''}`;
  }).join('\n');
}

function formatScrollableAreaSummary(areas: unknown, limit = 10) {
  if (!Array.isArray(areas) || !areas.length) return '[no scrollable areas detected]';
  return areas.slice(0, limit).map((item) => {
    const area = item as Record<string, unknown>;
    const scroll = area.scroll && typeof area.scroll === 'object' && !Array.isArray(area.scroll)
      ? area.scroll as Record<string, unknown>
      : {};
    const label = [area.name, area.text, area.role, area.tag]
      .map((value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''))
      .find(Boolean);
    const directions = [
      scroll.canScrollUp ? 'up' : '',
      scroll.canScrollDown ? 'down' : '',
      scroll.canScrollLeft ? 'left' : '',
      scroll.canScrollRight ? 'right' : '',
    ].filter(Boolean).join('/');
    const top = Number(scroll.top);
    const left = Number(scroll.left);
    const height = Number(scroll.height);
    const width = Number(scroll.width);
    const clientHeight = Number(scroll.clientHeight);
    const clientWidth = Number(scroll.clientWidth);
    const configuredMaxTop = Number(scroll.maxTop);
    const configuredMaxLeft = Number(scroll.maxLeft);
    const maxTop = Number.isFinite(configuredMaxTop)
      ? configuredMaxTop
      : Number.isFinite(height) && Number.isFinite(clientHeight) ? Math.max(0, height - clientHeight) : undefined;
    const maxLeft = Number.isFinite(configuredMaxLeft)
      ? configuredMaxLeft
      : Number.isFinite(width) && Number.isFinite(clientWidth) ? Math.max(0, width - clientWidth) : undefined;
    const configuredRemainingDown = Number(scroll.remainingDown);
    const configuredRemainingUp = Number(scroll.remainingUp);
    const configuredRemainingRight = Number(scroll.remainingRight);
    const configuredRemainingLeft = Number(scroll.remainingLeft);
    const remainingDown = Number.isFinite(configuredRemainingDown)
      ? configuredRemainingDown
      : Number.isFinite(top) && maxTop !== undefined ? Math.max(0, maxTop - top) : undefined;
    const remainingUp = Number.isFinite(configuredRemainingUp)
      ? configuredRemainingUp
      : Number.isFinite(top) ? Math.max(0, top) : undefined;
    const remainingRight = Number.isFinite(configuredRemainingRight)
      ? configuredRemainingRight
      : Number.isFinite(left) && maxLeft !== undefined ? Math.max(0, maxLeft - left) : undefined;
    const remainingLeft = Number.isFinite(configuredRemainingLeft)
      ? configuredRemainingLeft
      : Number.isFinite(left) ? Math.max(0, left) : undefined;
    const yState = Number.isFinite(top) && maxTop !== undefined
      ? ` y=${Math.round(top)}/${Math.round(maxTop)} ${remainingDown && remainingDown > 1 ? `remainingDown=${Math.round(remainingDown)}` : 'atBottom'} ${remainingUp && remainingUp > 1 ? `remainingUp=${Math.round(remainingUp)}` : 'atTop'}`
      : '';
    const xState = Number.isFinite(left) && maxLeft !== undefined && maxLeft > 0
      ? ` x=${Math.round(left)}/${Math.round(maxLeft)} ${remainingRight && remainingRight > 1 ? `remainingRight=${Math.round(remainingRight)}` : 'atRight'} ${remainingLeft && remainingLeft > 1 ? `remainingLeft=${Math.round(remainingLeft)}` : 'atLeft'}`
      : '';
    return `${area.id || '?'}${directions ? ` can=${directions}` : ' can=none'}${yState}${xState}${label ? ` "${String(label).slice(0, 60)}"` : ''}`;
  }).join('\n');
}

function defaultVisualAfterForTool(name: string): VisualAfterPolicy {
  void name;
  return { capture: 'auto', retention: 'replace' };
}

function sanitizeVisualAfterRetention(retention: unknown, fallback: VisualAfterPolicy['retention']) {
  if (typeof retention !== 'string') return fallback;
  if (retention === 'auto' || retention === 'replace' || retention === 'append') return retention;
  return fallback;
}

function sanitizeNextGoal(value: unknown) {
  if (typeof value !== 'string') return '';
  return sanitizeHistoricalToolText(
    value
      .replace(/继续\s*(?:点击|双击|右键|拖拽|悬停|输入|按下|滚动|选择)/g, '继续完成')
      .replace(/(?:点击|双击|右键|拖拽|悬停|输入|按下|滚动|选择)\s*[“"']?([^，。；;]*)[”"']?/g, '完成$1')
      .replace(/候选(?:ID|id|编号)\s*[:：]?\s*\d+/gi, '当前截图中的对应候选')
      .replace(/(?:候选|编号|id)\s*\d+/gi, '当前截图中的对应目标')
      .replace(/\b(?:clickCandidate|fillCandidates|doubleClickCandidate|rightClickCandidate|hoverCandidate|dragCandidate|scrollArea|pressKey|typeText)\s*\([^)]*\)/gi, '根据当前页面选择合适工具'),
    220,
  );
}

function sanitizeCurrentState(value: unknown) {
  if (typeof value !== 'string') return '';
  return sanitizeHistoricalToolText(
    value
      .replace(/\b(?:clickCandidate|fillCandidates|doubleClickCandidate|rightClickCandidate|hoverCandidate|dragCandidate|scrollArea|pressKey|typeText)\s*\([^)]*\)/gi, '已执行页面操作')
      .replace(/(?:候选|编号|id)\s*\d+/gi, '当前截图中的目标'),
    260,
  );
}

function validateCandidateActionBeforeExecution(name: string, input: unknown, traces: ToolTrace[]) {
  void traces;
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const targetVisual = typeof raw.targetVisual === 'string' ? raw.targetVisual.trim() : '';
  if (!targetVisual) {
    return {
      ok: false,
      actual: `${name} rejected before execution: targetVisual is required for candidate actions so the chosen id is tied to visible/current candidate evidence.`,
    };
  }
  return undefined;
}

const candidateActionToolNames = new Set(['clickCandidate', 'hoverCandidate', 'doubleClickCandidate', 'rightClickCandidate', 'dragCandidate']);
const domNodeIdToolNames = new Set(['getDomNodeText', 'clickDomNode', 'fillDomNodes', 'hoverDomNode', 'doubleClickDomNode', 'dragDomNode']);
const noVisualAfterCaptureToolNames = new Set<string>();
const noDomAfterContextToolNames = new Set([
  ...noVisualAfterCaptureToolNames,
  'listTabs',
  'waitForPage',
]);

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
  if (visualAfter.capture === 'viewport' || visualAfter.capture === 'fullPage') return true;
  return !noVisualAfterCaptureToolNames.has(name);
}

function shouldCollectDomContextAfter(trace: ToolTrace) {
  void trace;
  return false;
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
  if (trace.result && !trace.result.ok) next.blockers = Array.from(new Set([...next.blockers, concise(trace.result.actual, 220)])).slice(-8);
  if (trace.name === 'scrollArea') {
    next.phase = '正在查看滚动区域或长页面内容';
    next.scrollSummary = concise([next.scrollSummary, resultText || trace.result?.actual].filter(Boolean).join('；'), 600);
  } else if (trace.name === 'reportState') {
    next.phase = '正在汇报当前状态或最终结论';
  } else {
    next.phase = '正在执行网页操作并等待页面反馈';
  }
  next.nextStep = trace.name === 'reportState' ? '根据报告状态决定是否结束' : '根据当前截图继续完成任务';
  return next;
}

function formatWorkingMemory(memory: RuntimeWorkingMemory) {
  const blockers = memory.blockers.slice(-2).map((item) => concise(item, 120));
  const constraints = memory.userConstraints.slice(-2).map((item) => concise(item, 120));
  return [
    'Loop Memory (non-authoritative; durable facts are in RunState.ledgerDigest):',
    `- Last action/result: ${concise([memory.lastAction, memory.lastResult].filter(Boolean).join(' -> '), 220) || 'none'}`,
    blockers.length ? `- Recent blockers: ${blockers.join('; ')}` : '',
    constraints.length ? `- User constraints: ${constraints.join('; ')}` : '',
  ].join('\n');
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
  pushBeforeFrameScreenshots(screenshots, name, visualContext?.current());
  const visualAfter = visualAfterFromInput(name, toolInput);
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

  if (shouldCollectDomContextAfter(trace)) {
    throwIfStopped(abortSignal, shouldContinue);
    const afterPageContext = await session.getPageContext({
      includeDomTree: true,
      includeText: false,
      includeManualVerification: false,
      includeInteractiveCandidates: false,
    }).catch(() => undefined);
    throwIfStopped(abortSignal, shouldContinue);
    const domContext = afterPageContext ? createDomContextSnapshot('dom', afterPageContext) : undefined;
    if (domContext) {
      trace.contextAfter = {
        requestId: trace.contextBefore?.requestId,
        requestCreatedAt: trace.contextBefore?.requestCreatedAt,
        domContext,
      };
    }
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
  action: () => Promise<BrowserActionResult>;
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
    result = await action();
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
  targetUrl: string,
  mode: BrowserSessionMode,
  traces: ToolTrace[],
  aiRequest?: AiRequestSnapshot,
  onToolTrace?: (trace: ToolTrace) => void | Promise<void>,
  referenceOptions?: {
    availableReferenceIds?: Set<string>;
    onSelectReferenceScreenshots?: (input: {
      ids: string[];
      selectionReason: string;
      sameInterfaceGroup?: string;
    }) => void | Promise<void>;
    runId?: string;
    stepIndex?: number;
    allowedToolTypes?: string[];
    visualContext?: VisualContextManager;
    observationStore?: RuntimeObservationStore;
    toolExecutionGate?: { stepNumber: number; executed: boolean };
    getAiRequest?: () => AiRequestSnapshot | undefined;
    abortSignal?: AbortSignal;
    shouldContinue?: () => boolean;
    onDebug?: ExecutionDebug;
    onVisualContextChange?: (snapshot: ReturnType<VisualContextManager['snapshot']>) => void | Promise<void>;
    observePageState?: () => Promise<BrowserActionResult>;
    observeCurrentScreenshot?: (input?: { capture?: ScreenshotCaptureMode }) => Promise<BrowserActionResult>;
    requestToolConfirmation?: (request: BrowserToolConfirmationRequest) => Promise<BrowserToolConfirmationDecision>;
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
    visualAfter: z.object({
      capture: z.enum(['auto', 'viewport', 'fullPage']).optional().describe('Use auto normally. Use viewport/fullPage only when the next model request truly needs that screenshot size.'),
      retention: z.enum(['auto', 'replace', 'append']).optional().describe('Use replace by default. Use append only when the next decision must compare with, continue from, or analyze together with the previous screenshot.'),
      reason: z.string().optional().describe(`Short Chinese reason for append/capture choice. ${toolTextRule}`),
    }).optional(),
  };
  const browserToolInput = <T extends z.ZodRawShape>(shape: T) => z.object({ ...toolContextShape, ...shape });
  const batchFillFieldsInput = z.array(z.object({
    id: z.string().min(1).describe('Fresh DOM node_id or visual candidate id from the CURRENT snapshot.'),
    text: z.string().optional().describe('Optional text to fill after clicking this field. Omit for click-only actions.'),
    clear: z.boolean().optional().describe('Defaults to true when text is provided. Set false only when appending is intended.'),
    targetVisual: z.string().optional().describe('Visible label/placeholder/target description for this field.'),
  })).min(1).max(BATCH_FILL_FIELD_LIMIT);

  async function record(name: string, input: unknown, action: () => Promise<BrowserActionResult>) {
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
    const actionWithConfirmation = async () => {
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
      }
      return action();
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
    }).then((result) => compactToolResultForModel(name, result, referenceOptions?.observationStore, referenceOptions?.runId));
  }

  const sharedTools = {
    getPageState: tool({
      description: 'Read-only observation tool: inspect the current active page state. It collects the browser DOM tree into the Node backend, where worker threads generate stored text and interactive node_id views for readObservation. Call this after any browser-changing action before choosing another DOM action.',
      inputSchema: browserToolInput({}),
      execute: (input) => record('getPageState', input, async () => (
        referenceOptions?.observePageState
          ? referenceOptions.observePageState()
          : { ok: false, actual: 'getPageState is unavailable in this runtime.' }
      )),
    }),
    ...(modelSupportsScreenshotInput() ? {
      getCurrentScreenshot: tool({
        description: 'Read-only visual observation tool: capture the current browser viewport screenshot and attach it to the NEXT model request. Use only when visual evidence is needed; use DOM tools for clicking/filling.',
        inputSchema: browserToolInput({
          capture: z.enum(['viewport', 'fullPage']).optional().describe('Screenshot size. Defaults to viewport; use fullPage only when the visual evidence is outside the current viewport.'),
        }),
        execute: (input) => record('getCurrentScreenshot', input, async () => (
          referenceOptions?.observeCurrentScreenshot
            ? referenceOptions.observeCurrentScreenshot({ capture: input.capture })
            : { ok: false, actual: 'getCurrentScreenshot is unavailable in this runtime.' }
        )),
      }),
    } : {}),
    openPage: tool({
      description: 'Open or navigate to a URL in the browser.',
      inputSchema: browserToolInput({
        url: z.string().optional().describe('The URL to open. Defaults to the test target URL.'),
      }),
      execute: (input) => record('openPage', input, () => session.open(input.url || targetUrl)),
    }),
    scrollArea: tool({
      description: 'Scroll a visible scrollable area by its current area id. In DOM mode, do not use this to read normal DOM text; use it only for lazy-loaded/virtualized content or viewport-only UI. Check the latest summary/result first: do not scroll down atBottom/remainingDown=0 or up atTop/remainingUp=0. One call should scroll about one visible viewport/container height only. Area ids are volatile per turn; never reuse historical ids.',
      inputSchema: browserToolInput({
        areaId: z.string().describe('Scrollable area id from the CURRENT page context, such as S1 or S2. Do not invent or reuse an old id.'),
        deltaY: z.number().describe('Vertical scroll delta. Positive scrolls down, negative scrolls up. Use roughly one viewport/container height per call; do not request multiple screens of scrolling in one tool call.'),
        deltaX: z.number().optional().describe('Horizontal scroll delta. Positive scrolls right, negative scrolls left.'),
      }),
      execute: (input) => record('scrollArea', input, () => session.scrollArea(input.areaId, input.deltaY, input.deltaX || 0)),
    }),
    typeText: tool({
      description: 'Type text into the currently focused element. In DOM mode prefer clickDomNode(id,text) or fillDomNodes(fields) when a fresh node_id is known; use this only after a prior click/focus already focused the field.',
      inputSchema: browserToolInput({
        text: z.string().describe('Text to enter.'),
      }),
      execute: (input) => record('typeText', input, () => session.typeText(input.text)),
    }),
    pressKey: tool({
      description: 'Press a keyboard key on the currently focused element or page.',
      inputSchema: browserToolInput({
        key: z.string().describe('Keyboard key, for example Enter, Escape, Tab.'),
      }),
      execute: (input) => record('pressKey', input, () => session.press(input.key)),
    }),
    waitForPage: tool({
      description: 'Wait for the page to settle after navigation or UI changes.',
      inputSchema: browserToolInput({
        ms: z.number().optional().describe('Optional wait time in milliseconds.'),
      }),
      execute: (input) => record('waitForPage', input, () => (input.ms ? session.wait(input.ms) : session.waitForPage())),
    }),
    waitForHumanVerification: tool({
      description: 'Wait while the user completes a visible CAPTCHA, login verification, or security check in the non-headless browser.',
      inputSchema: browserToolInput({
        maxMs: z.number().optional().describe('Maximum wait time in milliseconds. Defaults to MANUAL_VERIFICATION_TIMEOUT_MS or 180000.'),
      }),
      execute: (input) => record('waitForHumanVerification', input, () => session.waitForManualVerification(input.maxMs)),
    }),
    listTabs: tool({
      description: 'List all currently open browser tabs with their index and URL.',
      inputSchema: browserToolInput({}),
      execute: (input) => record('listTabs', input, () => session.listTabs()),
    }),
    getHttpRequests: tool({
      description: 'Read-only diagnostic tool: return recent HTTP requests for the current active tab, including method, URL, resource type, status, ok/failed, and error text. Use when a page looks broken, data is missing, an API may have failed, or you need evidence for a network-related issue.',
      inputSchema: browserToolInput({}),
      execute: (input) => record('getHttpRequests', input, () => session.getCurrentTabHttpRequests()),
    }),
    readObservation: tool({
      description: 'Read-only context tool: read a typed range from the current getPageState observation for this run. In DOM mode, type="text" returns Node-processed plain page text and type="interactive" returns actionable DOM node_id entries generated from the DOM tree on the Node backend.',
      inputSchema: browserToolInput({
        type: z.enum(['text', 'interactive']).optional().describe('Which observation view to read. Defaults to text. Use interactive for actionable DOM node_id entries. Raw HTML is not exposed through readObservation.'),
        offset: z.number().int().nonnegative().optional().describe('Character offset to start reading from. Defaults to 0.'),
        maxChars: z.number().int().positive().optional().describe('Maximum characters to return. Defaults to 10000; values below 10000 are raised to 10000. No upper cap is applied.'),
      }),
      execute: (input) => record('readObservation', input, async () => readRuntimeObservation(referenceOptions?.observationStore, referenceOptions?.runId, input.type, input.offset, input.maxChars)),
    }),
    downloadFile: tool({
      description: 'Download a file into the configured local output directory or this run artifacts. Pass an absolute URL, an origin-relative path starting with / resolved against the current page origin, or a page-relative path resolved against the current page directory. Use this when the user asks to download/save a file; return the saved URL or local path in the final answer.',
      inputSchema: browserToolInput({
        url: z.string().optional().describe('Absolute download URL. If omitted, path or urlOrPath is used.'),
        path: z.string().optional().describe('Download path. /files/a.pdf resolves against current page origin; report/a.pdf resolves against current page directory.'),
        urlOrPath: z.string().optional().describe('Absolute URL, origin-relative path, or page-relative path to download.'),
        fileName: z.string().optional().describe('Optional saved file name, including extension when known.'),
      }),
      execute: (input) => record('downloadFile', input, () => downloadFileArtifact({ ...input, runId: referenceOptions?.runId, sourcePageUrl: session.currentUrl() })),
    }),
    generateMarkdownFile: tool({
      description: 'Create a Markdown .md file in the configured local output directory or this run artifacts from complete Markdown content written by the AI. Use this when the user asks to generate/export/save a Markdown file, then include the saved URL or local path in the final answer.',
      inputSchema: browserToolInput({
        fileName: z.string().optional().describe('Optional Markdown file name. The .md extension is added when missing.'),
        title: z.string().optional().describe('Optional title used as fallback file name.'),
        content: z.string().min(1).describe('Complete Markdown file content to save.'),
      }),
      execute: (input) => record('generateMarkdownFile', input, () => generateMarkdownArtifact({ ...input, runId: referenceOptions?.runId })),
    }),
    switchTab: tool({
      description: 'Switch to a browser tab by index when the workflow opened a new tab.',
      inputSchema: browserToolInput({
        index: z.number().describe('The tab index from listTabs.'),
      }),
      execute: (input) => record('switchTab', input, () => session.switchTab(input.index)),
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
    selectReferenceScreenshots: tool({
      description: 'No-op context tool. Select previous screenshot reference ids from Available previous screenshot references so those images will be attached to the NEXT AI request. The tool output is text only; it does not include image content and does not change the browser.',
      inputSchema: browserToolInput({
        ids: z.array(z.string().min(1)).max(6).describe('Reference ids to attach next request, such as step-3-before or step-4-after. Use an empty array to clear selected references.'),
        selectionReason: z.string().min(1).max(800).describe('Chinese explanation of why these previous screenshots are useful, especially whether they are the same interface at different scroll positions.'),
        sameInterfaceGroup: z.string().optional().describe('Optional group label when the selected screenshots are believed to be the same interface with different scroll offsets.'),
      }),
      execute: (input) => record('selectReferenceScreenshots', input, async () => {
        const allowed = referenceOptions?.availableReferenceIds;
        const validIds = allowed
          ? input.ids.filter((id) => allowed.has(id))
          : input.ids;
        await referenceOptions?.onSelectReferenceScreenshots?.({
          ids: validIds,
          selectionReason: input.selectionReason,
          sameInterfaceGroup: input.sameInterfaceGroup,
        });
        const skipped = input.ids.filter((id) => !validIds.includes(id));
        return {
          ok: true,
          actual: [
            validIds.length
              ? `Selected screenshot references for the next request: ${validIds.join(', ')}.`
              : 'Cleared selected screenshot references for the next request.',
            skipped.length ? ` Ignored unavailable ids: ${skipped.join(', ')}.` : '',
            ` Reason: ${input.selectionReason}`,
          ].join(''),
        };
      }),
    }),
    manageVisualContext: tool({
      description: 'Manage Visual Context Manager without changing the browser. Use rarely to clear history, keep only latest current screenshot, pin current as evidence, or compress a long scroll sequence.',
      inputSchema: browserToolInput({
        action: z.enum(['clearHistory', 'keepLatestOnly', 'pinCurrent', 'compressScrollSequence']).describe('Visual context maintenance action.'),
        manageReason: z.string().min(1).max(500).describe('Chinese reason for this visual context maintenance action.'),
      }),
      execute: (input) => record('manageVisualContext', input, async () => {
        referenceOptions?.visualContext?.manage(input.action, input.manageReason);
        await referenceOptions?.onVisualContextChange?.(referenceOptions.visualContext?.snapshot() || { current: undefined, history: [] });
        return {
          ok: true,
          actual: `Visual context managed: ${input.action}. ${input.manageReason}`,
        };
      }),
    }),
  };

  const domTools = {
    getDomNodeText: tool({
      description: 'DOM mode read-only helper: read expanded text for a fresh DOM node_id from the current DOM snapshot.',
      inputSchema: browserToolInput({
        id: z.string().min(1).describe('Fresh DOM node_id from readObservation(type="interactive") or the current DOM snapshot.'),
      }),
      execute: (input) => record('getDomNodeText', input, () => session.getDomNodeText(normalizeDomNodeIdString(input.id))),
    }),
    clickDomNode: tool({
      description: 'DOM mode click/focus: click a fresh DOM node_id from readObservation(type="interactive"). If text is provided, type it immediately after clicking.',
      inputSchema: browserToolInput({
        id: z.string().min(1).describe('Fresh DOM node_id from readObservation(type="interactive").'),
        text: z.string().optional().describe('Optional text to type immediately after clicking/focusing this DOM node.'),
      }),
      execute: (input) => record('clickDomNode', input, () => session.clickDomNode(normalizeDomNodeIdString(input.id), input.text)),
    }),
    fillDomNodes: tool({
      description: `DOM mode form helper: click and optionally fill up to ${BATCH_FILL_FIELD_LIMIT} fresh DOM node_id targets from readObservation(type="interactive") in one browser action. Use for stable forms where all fields are present in the current DOM snapshot.`,
      inputSchema: browserToolInput({
        fields: batchFillFieldsInput.describe('Ordered DOM node_id fields to click/fill. Each id must come from the current readObservation(type="interactive") result.'),
      }),
      execute: (input) => record('fillDomNodes', input, () => session.fillDomNodes(input.fields.map((field) => ({
        id: normalizeDomNodeIdString(field.id),
        text: field.text,
        clear: field.clear,
      })))),
    }),
    hoverDomNode: tool({
      description: 'DOM mode hover: move the mouse over a fresh DOM node_id from readObservation(type="interactive") to reveal menus, tooltips, or hover-only controls.',
      inputSchema: browserToolInput({
        id: z.string().min(1).describe('Fresh DOM node_id from readObservation(type="interactive").'),
      }),
      execute: (input) => record('hoverDomNode', input, () => session.hoverDomNode(normalizeDomNodeIdString(input.id))),
    }),
    doubleClickDomNode: tool({
      description: 'DOM mode double-click: double-click a fresh DOM node_id from readObservation(type="interactive").',
      inputSchema: browserToolInput({
        id: z.string().min(1).describe('Fresh DOM node_id from readObservation(type="interactive").'),
      }),
      execute: (input) => record('doubleClickDomNode', input, () => session.doubleClickDomNode(normalizeDomNodeIdString(input.id))),
    }),
    dragDomNode: tool({
      description: 'DOM mode drag: drag from one fresh DOM node_id to another fresh DOM node_id from the current DOM snapshot.',
      inputSchema: browserToolInput({
        fromId: z.string().min(1).describe('Fresh source DOM node_id from readObservation(type="interactive").'),
        toId: z.string().min(1).describe('Fresh target DOM node_id from readObservation(type="interactive").'),
      }),
      execute: (input) => record('dragDomNode', input, () => session.dragDomNode(normalizeDomNodeIdString(input.fromId), normalizeDomNodeIdString(input.toId))),
    }),
    findByText: tool({
      description: 'DOM mode recovery, read-only: find visible interactive locators whose text/accessibility label/title/placeholder/href matches targetText. This does not click. Use only when a fresh DOM id is unavailable or unreliable, then choose one returned locatorId in a later clickLocator call.',
      inputSchema: browserToolInput({
        targetText: z.string().min(1).max(300).describe('Exact visible or accessible text to search for from the CURRENT DOM/page context. Prefer short unique labels over long surrounding snippets.'),
        scopeId: z.string().optional().describe('Optional numeric DOM id that scopes the search to a subtree, such as 12 or [12].'),
      }),
      execute: (input) => record('findByText', input, () => session.findByText(input.targetText, normalizeDomNodeIdParam({ id: input.scopeId }))),
    }),
    clickLocator: tool({
      description: 'DOM mode recovery click: click one locatorId returned by the immediately preceding findByText result. Do not invent locatorIds and do not use visual candidate ids. If the locator/candidate is marked external-app=<protocol>, the click may open a native/system application and leave the browser page unchanged; ok=true means the click was delivered, not that the native launch is server-verifiable.',
      inputSchema: browserToolInput({
        locatorId: z.string().min(1).max(20).describe('A locatorId such as T1 from the latest findByText result.'),
        text: z.string().optional().describe('Optional text to type immediately after clicking/focusing this locator.'),
      }),
      execute: (input) => record('clickLocator', input, () => session.clickLocator(input.locatorId, input.text)),
    }),
  };

  const tools = { ...sharedTools, ...domTools };
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

// 根据当前模式生成验证码/安全校验规则；DOM 模式不要要求 AI 读取截图。
function formatDomPageStateObservation(pageContext: RuntimePageContext, observationViews?: BrowserActionResult['observationViews']) {
  const text = observationViews?.text || '[empty page text]';
  const interactive = observationViews?.interactive || '[no interactive DOM nodes detected]';
  return [
    'Current DOM page state observation:',
    '- getPageState collected the browser DOM tree into the Node backend.',
    '- Node worker threads processed that DOM tree into stored readObservation views: text and interactive.',
    '- Interactive entries expose DOM node_id values. Use DOM node tools such as clickDomNode/fillDomNodes/hoverDomNode with fresh node_id values from readObservation(type="interactive").',
    `Current URL: ${pageContext.url}`,
    `Current title: ${pageContext.title}`,
    `Open tabs JSON: ${JSON.stringify(pageContext.tabs)}`,
    `Focused element JSON: ${JSON.stringify(pageContext.focusedElement)}`,
    `Page scroll state JSON: ${JSON.stringify(pageContext.pageScrollState)}`,
    `Scrollable areas summary:\n${formatScrollableAreaSummary(pageContext.scrollableAreas)}`,
    `DOM tree snapshot chars: ${(pageContext.domTree || '').length}`,
    `Node-processed page text (${text.length} chars):\n${pageTextForPrompt(text)}`,
    `Node-processed interactive DOM nodes:\n${interactive}`,
  ].filter(Boolean).join('\n');
}

function domPageStateObservationViews(processed: ProcessedDomObservation): BrowserActionResult['observationViews'] {
  return {
    defaultType: 'text',
    text: processed.text,
    interactive: processed.interactive,
  };
}

function formatDomPageStateSummary(
  pageContext: RuntimePageContext,
  observation: RuntimeObservationRecord,
  processed?: ProcessedDomObservation,
  timings?: Record<string, unknown>,
) {
  const textChars = observation.viewCharLengths.text || 0;
  const interactiveChars = observation.viewCharLengths.interactive || 0;
  return [
    'Current DOM page state summary:',
    '- getPageState refreshed the current observation for this run and replaced the previous one.',
    '- The browser DOM tree was collected into Node; Node worker threads generated and stored text/interactive views.',
    '- Read them with readObservation(type="text", offset=0, maxChars=10000) or readObservation(type="interactive", offset=0, maxChars=10000).',
    `Current URL: ${pageContext.url}`,
    `Current title: ${pageContext.title}`,
    `Open tabs JSON: ${JSON.stringify(pageContext.tabs)}`,
    `Focused element JSON: ${JSON.stringify(pageContext.focusedElement)}`,
    `Page scroll state JSON: ${JSON.stringify(pageContext.pageScrollState)}`,
    `Scrollable areas summary:\n${formatScrollableAreaSummary(pageContext.scrollableAreas)}`,
    `Page context timings JSON: ${JSON.stringify(pageContext.timings || {})}`,
    processed ? `Node DOM processing JSON: ${JSON.stringify({ domNodeCount: processed.domNodeCount, interactiveNodeCount: processed.interactiveNodeCount, usedWorkers: processed.usedWorkers, timings: processed.timings, errors: processed.errors })}` : '',
    timings ? `GetPageState timings JSON: ${JSON.stringify(timings)}` : '',
    `Observation generation: ${observation.generation}. Views: text(${textChars}), interactive(${interactiveChars}); DOM tree chars=${(pageContext.domTree || '').length}.`,
  ].filter(Boolean).join('\n');
}

function formatVisualPageStateObservation(input: {
  pageContext: RuntimePageContext;
  visualContext: ReturnType<VisualContextManager['snapshot']>;
  screenshotInputEnabled: boolean;
  markerEnabled: boolean;
  markerOverlayInScreenshot: boolean;
  separateMarkerMap: boolean;
}) {
  const { pageContext, visualContext, screenshotInputEnabled, markerEnabled, markerOverlayInScreenshot, separateMarkerMap } = input;
  const shouldIncludeCandidates = !screenshotInputEnabled || !markerEnabled;
  const externalAppCandidates = formatExternalAppInteractiveElements(pageContext.interactiveCandidates);
  const imageRule = screenshotInputEnabled
    ? separateMarkerMap
      ? 'Screenshot images are attached: clean viewport first, pixel-aligned marker map second.'
      : markerOverlayInScreenshot
        ? 'A current viewport screenshot with marker labels overlaid is attached.'
        : 'A current clean viewport screenshot is attached.'
    : 'No screenshot image is attached; use the visible interactive elements list as the screenshot-derived candidate map.';
  const frameSummary = (frame: VisualFrameRecord) => (
    `${frame.id} ${concise(frame.reason, 80)} image=${basenameOfPath(frame.path)}${frame.originalPath ? ` original=${basenameOfPath(frame.originalPath)}` : ''}${frame.markerPath ? ` marker=${basenameOfPath(frame.markerPath)}` : ''}${frame.capture ? ` capture=${frame.capture}` : ''}`
  );
  return [
    'Current visual page state observation:',
    imageRule,
    '- Candidate ids and scroll area ids are volatile. Use them only until the next browser-changing action.',
    `Current URL: ${pageContext.url}`,
    `Current title: ${pageContext.title}`,
    `Open tabs JSON: ${JSON.stringify(pageContext.tabs)}`,
    `Page scroll state JSON: ${JSON.stringify(pageContext.pageScrollState)}`,
    `Scrollable areas summary:\n${formatScrollableAreaSummary(pageContext.scrollableAreas)}`,
    shouldIncludeCandidates
      ? `Visible interactive elements:\n${formatVisualInteractiveElements(pageContext.interactiveCandidates)}`
      : '',
    !shouldIncludeCandidates && externalAppCandidates
      ? `External application candidates in the current marker map:\n${externalAppCandidates}`
      : '',
    'Visual Context Manager:',
    `current: ${visualContext.current ? frameSummary(visualContext.current) : '[none]'}`,
    visualContext.history.length
      ? `history is context only, never use its ids for current actions:\n${visualContext.history.map((frame) => `- ${frameSummary(frame)} role=${frame.role} group=${frame.group || '-'}`).join('\n')}`
      : 'history: [none]',
  ].filter(Boolean).join('\n');
}

function runtimePrompt(input: {
  testCase: TestCaseRecord;
  pageContext: Awaited<ReturnType<BrowserSession['getPageContext']>>;
  completedSteps: StepExecutionResult[];
  workingMemory?: RuntimeWorkingMemory;
  stepIndex: number;
  beforeScreenshotPath: string;
  hasMarkerScreenshot?: boolean;
  markerOverlayInScreenshot?: boolean;
  availableScreenshotReferences?: ScreenshotReference[];
  selectedScreenshotReferences?: SelectedScreenshotReference[];
  repairContext?: string;
}) {
  const { testCase, pageContext, completedSteps } = input;
  const targetHost = hostOf(testCase.targetUrl) || '[unknown target host]';
  const mode = browserModeOf(testCase);
  const visualMode = false;
  const attachScreenshot = false;
  const markerEnabled = false;
  const visualMarkersWithoutOverlay = false;
  const visualTextCandidateFallback = false;
  const markerOverlayInScreenshot = false;
  const separateMarkerScreenshot = false;
  void input.markerOverlayInScreenshot;
  void input.hasMarkerScreenshot;
  const rawCaseSystemPrompt = systemPromptOf(testCase);
  const requirement = requirementOf(testCase);
  const browserChatMode = isBrowserChatTestCase(testCase);
  const caseSystemPrompt = browserChatMode ? browserChatSystemPromptForRuntime(rawCaseSystemPrompt) : rawCaseSystemPrompt;
  const compactRunContext = browserChatMode
    ? buildCompactBrowserChatContext(completedSteps, input.workingMemory)
    : buildCompactRunContext(completedSteps, input.workingMemory);
  const customPrompt = customRuntimePromptFromEnv(browserChatMode ? 'browser-chat' : 'target', {
    requirement,
    targetUrl: testCase.targetUrl,
    currentUrl: pageContext.url,
    currentTitle: pageContext.title,
    browserMode: mode,
    stepIndex: input.stepIndex,
    runState: compactRunContext,
    workingMemory: input.workingMemory ? formatWorkingMemory(input.workingMemory) : '',
    openTabs: pageContext.tabs,
    pageScrollState: pageContext.pageScrollState,
    testCaseTitle: testCase.title,
    testCaseDescription: testCase.description,
    systemPrompt: caseSystemPrompt,
    currentDate: new Date().toISOString(),
  });
  const availableScreenshotReferences = input.availableScreenshotReferences || [];
  const selectedScreenshotReferences = input.selectedScreenshotReferences || [];
  const strategyMemory = (testCase.strategyMemory || [])
    .filter((hint) => !isInfrastructureNoise(hint))
    .map((hint) => concise(hint, 220))
    .slice(-4);
  const candidateContext = '[disabled because DOM mode uses fresh DOM tree ids]';
  const externalAppCandidateContext = '';
  const evidence = 'the latest explicit getPageState DOM summary plus Node-processed readObservation text/interactive node_id views, URL, tabs, scroll state, and focused element';
  const markerTargetRules: string[] = [];
  const modeActionRules = domModeActionRules();
  return [
    browserChatMode
      ? 'You are an AI browser chat agent.'
      : 'You are an AI browser testing agent. Call exactly ONE tool. Use reportState only when no browser action is needed.',
    `Requirement: ${requirement}`,
    `Target URL: ${testCase.targetUrl}`,
    `Target host: ${targetHost}`,
    `Current URL: ${pageContext.url}`,
    '',
    'Hard rules:',
    browserChatMode
      ? '- Browser chat may either answer with Chinese Markdown and no tool, or call at most one browser tool when action/inspection is needed.'
      : '- One tool only. You may include a short ordinary Chinese progress sentence alongside the tool call.',
    browserChatMode
      ? '- Keep browser action tool params minimal: reason, exact tool arguments, optional visualAfter, and optional requiresConfirmation/confirmationMessage only when strict safety requires a button confirmation. If no browser action is needed, answer directly in Markdown without calling a tool.'
      : '- Keep tool params minimal: reason, exact tool arguments, and optional visualAfter. Do not add separate state summaries, memory notes, finding lists, task frames, or ledger JSON.',
    '- Treat RunState JSON and Working Memory as compact context only. Do not copy them into tool params.',
    '- Historical actions are semantic summaries only. Do not reuse historical candidate ids, area ids, coordinates, deltas, screenshot ids, or old tool input JSON.',
    '- In reason/message/action/expected/actual, do not output candidate ids as business meaning, area ids, coordinates, deltas, screenshot file ids, or tool input JSON.',
    '- When a candidate or locator is marked external-app=<protocol>, clicking it is an external application launch attempt. The browser page may remain unchanged, and native app launch success is not server-verifiable.',
    browserChatMode ? '' : '- If ledgerDigest already covers a requirement area, do not restart that area by habit; continue only with missing or contradicted work.',
    browserChatMode ? '' : '- This is a testing workflow, not a generic browser assistant. In every step, actively look for product defects, requirement mismatches, broken navigation, unexpected page states, visible loading stalls, validation problems, and reliability risks.',
    browserChatMode ? '' : '- When a problem is observed or strongly indicated by tool/page feedback, describe it in ordinary assistant text or reportState actual; do not create extra structured memory fields.',
    browserChatMode ? '' : '- If the page looks broken, data is missing, a request may have failed, or an issue may be caused by an API/static-resource failure, call getHttpRequests before finalizing that issue when possible.',
    '- If the user asks to download/save a file, use downloadFile. It accepts an absolute URL, an origin-relative path like /files/a.pdf, or a page-relative path like report/a.pdf resolved against the current page URL.',
    browserChatMode ? '- Strict safety confirmations must use tool params requiresConfirmation=true and confirmationMessage; never ask the user to type a confirmation message for that purpose.' : '',
    '- If the user asks to generate/export/save a Markdown file, use generateMarkdownFile with the complete Markdown content. Include the returned URL or local path in the final answer.',
    ...domObservationHardRules(),
    input.repairContext ? `Replay repair mode:\n${input.repairContext}` : '',
    visualMode
      ? '- Candidate action reason must describe the visible text/icon/position/role from the CURRENT screenshot before choosing id.'
      : '- DOM action reason must cite the current text/interactive evidence or the fresh locator/node_id used for the action.',
    `- Use ${evidence} as the current page state. When this state is stale, call getPageState.`,
    '- If no progress or target mismatch, choose a different evidence-based path; do not repeat the same visible target by habit.',
    '- If loading/transitioning, call waitForPage once. Block only for manual captcha/OTP/security/user input.',
    ...modeActionRules,
    '- After a click may open a tab/window, call listTabs; switchTab if the relevant page is in another tab.',
    '- Block only for empty captcha/OTP/security/manual verification. If captchaAppearsFilled=true, submit/login and continue.',
    '- If the current page requires user-side captcha/OTP/security/manual verification, call waitForHumanVerification. It pauses the run for user intervention and no further AI tool should be requested from that screenshot.',
    browserChatMode
      ? ''
      : '- Finish only when EVERY requirement clause is satisfied; use reportState with done=true/status=passed. Otherwise call one more useful browser tool or reportState with done=false when only reporting status.',
    `${domNoScreenshotRule} If visual evidence is needed and the model supports image input, call getCurrentScreenshot; continue to use DOM node tools for actions.`,
    ...markerTargetRules,
    caseSystemPrompt ? `${browserChatMode ? 'Browser-chat loaded instructions and Skills' : 'Test-case-specific instructions'}:
${caseSystemPrompt}` : '',
    customPrompt,
    !browserChatMode && strategyMemory.length ? `Historical failure strategy memory:
${strategyMemory.map((hint, index) => `${index + 1}. ${hint}`).join('\n')}` : '',
    '',
    ...(browserChatMode ? [] : buildVerificationPromptLines(pageContext, attachScreenshot)),
    ...(browserChatMode ? [] : buildCompletionPromptLines(attachScreenshot)),
    '',
    'Response:',
    browserChatMode
      ? '- Either return normal Chinese Markdown text with no tool, or call one browser tool if action/inspection is needed. Tool params are only for the selected tool.'
      : '- Call one tool. Use ordinary assistant text for progress/explanation, and tool params only for the selected tool.',
    visualMode
      ? '- Candidate action reason must mention the current-screenshot visual feature, not just an id.'
      : '- DOM action reason must mention the current text/interactive evidence or the fresh locator/node_id used for the action.',
    browserChatMode
      ? '- To finish/block/fail/clarify in browser chat, return normal Chinese Markdown text with no tool call. Do not return JSON.'
      : '- To finish/block/fail or only report status, call reportState. Do not return standalone JSON.',
    '- When a file tool succeeds, mention the saved file name and include its returned URL or local path.',
    '',
    'Current context:',
    browserChatMode
      ? domCurrentContextLine(true)
      : visualMode ? `Open tabs JSON: ${JSON.stringify(pageContext.tabs)}` : domCurrentContextLine(false),
    visualMode ? `Page scroll state JSON: ${JSON.stringify(pageContext.pageScrollState)}` : '',
    visualMode ? `Scrollable areas summary (green S labels in screenshot are authoritative):\n${formatScrollableAreaSummary(pageContext.scrollableAreas)}` : '',
    visualMode && visualTextCandidateFallback ? `Focused element JSON: ${JSON.stringify(pageContext.focusedElement)}` : '',
    visualMode && externalAppCandidateContext ? `External application candidates in the current candidate map:
${externalAppCandidateContext}` : '',
    visualMarkersWithoutOverlay || visualTextCandidateFallback ? `Visible interactive elements:
${candidateContext}` : '',
    browserChatMode ? '' : compactRunContext,
    availableScreenshotReferences.length ? `Available previous screenshot references:
${formatScreenshotReferences(availableScreenshotReferences)}` : '',
    selectedScreenshotReferences.length ? `Selected reference screenshots:
${formatScreenshotReferences(selectedScreenshotReferences)}` : '',
    selectedScreenshotReferences.length
      ? 'Reference screenshot rule: selected reference images help connect scroll continuity or compare earlier page state. They may show the same interface at different scroll offsets when sameInterfaceGroup matches, but their candidate ids are historical and must never be used for the current action.'
      : '',
    'Screenshot image/path is not attached automatically. getCurrentScreenshot attaches explicit visual evidence to the next model request when available.',
  ].filter(Boolean).join('\n');
}

function runtimeToolNames(mode: BrowserSessionMode) {
  void mode;
  const sharedTools = [
    'getPageState',
    ...(modelSupportsScreenshotInput() ? ['getCurrentScreenshot'] : []),
    'openPage',
    'waitForPage',
    'waitForHumanVerification',
    'listTabs',
    'getHttpRequests',
    'readObservation',
    'downloadFile',
    'generateMarkdownFile',
    'switchTab',
    'typeText',
    'pressKey',
    'reportState',
    'scrollArea',
  ];
  const domTools = [
    ...sharedTools,
    ...(modelSupportsScreenshotInput() ? ['selectReferenceScreenshots', 'manageVisualContext'] : []),
    'getDomNodeText',
    'clickDomNode',
    'fillDomNodes',
    'hoverDomNode',
    'doubleClickDomNode',
    'dragDomNode',
    'findByText',
    'clickLocator',
  ];
  return domTools;
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
  domContext?: AiDomContextSnapshot;
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
    domContext: input.domContext,
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
  void system;
  return sanitizeModelLogValue(Array.isArray(messages) ? messages : [], imagePaths, { imageIndex: 0 });
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
      messages: modelMessages || aiRequest?.messages || [],
    },
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

function collectTaskFrameFromSteps(steps: StepExecutionResult[]) {
  return steps.map((step) => step.taskFrame || step.workingMemory?.taskFrame).filter(Boolean).at(-1);
}

function collectLedgerItemsFromSteps(steps: StepExecutionResult[]) {
  return mergeLedgerItems([], [
    ...steps.flatMap((step) => step.ledgerItems || []),
    ...steps.flatMap((step) => step.workingMemory?.ledgerItems || []),
  ], ledgerMemoryLimit());
}

function extractAssistantStepInfoFromToolInputs(traces: ToolTrace[], goal = ''): Pick<RuntimeDecision, 'taskFrame' | 'ledgerItems'> {
  void traces;
  void goal;
  return {};
}

function deriveBrowserChatStepDecision(text: string, traces: ToolTrace[], goal = ''): RuntimeDecision {
  const executed = traces.filter((trace) => trace.name && trace.result);
  const last = executed.at(-1);
  const failed = executed.find((trace) => trace.result && !trace.result.ok);
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
  testCase: TestCaseRecord;
  runId: string;
  stepIndex: number;
  beforeScreenshotPath: string;
  instruction?: string;
  conversation?: InteractiveBrowserTurnMessage[];
  completedSteps: StepExecutionResult[];
  runtimeObservationStore?: RuntimeObservationStore;
  selectedScreenshotReferences?: SelectedScreenshotReference[];
  referenceImagePaths?: string[];
  onSelectReferenceScreenshots?: (selection: {
    ids: string[];
    selectionReason: string;
    sameInterfaceGroup?: string;
    availableReferences: ScreenshotReference[];
  }) => void | Promise<void>;
  abortSignal?: AbortSignal;
  shouldContinue?: () => boolean;
  onDebug?: ExecutionDebug;
  onToolTrace?: (trace: ToolTrace, progress?: ToolTraceProgress) => void | Promise<void>;
  repairContext?: string;
  requestToolConfirmation?: (request: BrowserToolConfirmationRequest) => Promise<BrowserToolConfirmationDecision>;
}) {
  const {
    session,
    testCase,
    stepIndex,
    beforeScreenshotPath,
    completedSteps,
    selectedScreenshotReferences = [],
    referenceImagePaths = [],
    onSelectReferenceScreenshots,
    abortSignal,
    onDebug,
    onToolTrace,
  } = input;
  const mode = browserModeOf(testCase);
  const browserChatMode = isBrowserChatTestCase(testCase);
  const screenshotInputEnabled = false;
  const markerEnabled = false;
  const separateMarkerMap = false;
  const markerOverlayInScreenshot = false;
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
  const contextStartedAt = Date.now();
  const pageContext = await session.getPageContext(runtimePageContextOptions(mode));
  ensureActive();
  let currentDomContext = createDomContextSnapshot(mode, pageContext);
  const contextMs = elapsedSince(contextStartedAt);
  const screenshotReadStartedAt = Date.now();
  const screenshot = undefined;
  ensureActive();
  const markerScreenshot = undefined;
  ensureActive();
  const userReferenceImagePaths = Array.from(new Set(referenceImagePaths.filter(Boolean))).slice(0, 4);
  const userReferenceImages = modelSupportsScreenshotInput()
    ? await Promise.all(userReferenceImagePaths.map(async (imagePath) => ({
        imagePath,
        image: await readScreenshotForAi(imagePath).catch(() => undefined),
      })))
    : [];
  ensureActive();
  let runtimeSelectedScreenshotReferences = [...selectedScreenshotReferences];
  const loadSelectedReferenceScreenshots = async () => modelSupportsScreenshotInput()
    ? Promise.all(runtimeSelectedScreenshotReferences.map(async (ref) => ({
        ref,
        image: await readScreenshotForAi(ref.path).catch(() => undefined),
      })))
    : [];
  let runtimeSelectedReferenceScreenshots = await loadSelectedReferenceScreenshots();
  ensureActive();
  const screenshotReadMs = elapsedSince(screenshotReadStartedAt);
  const availableScreenshotReferences = buildAvailableScreenshotReferences(completedSteps);
  const availableReferenceIds = new Set(availableScreenshotReferences.map((ref) => ref.id));
  const applySelectedReferenceScreenshots = async (selection: {
    ids: string[];
    selectionReason: string;
    sameInterfaceGroup?: string;
  }) => {
    const validIds = selection.ids.filter((id) => availableReferenceIds.has(id));
    runtimeSelectedScreenshotReferences = validIds
      .map((id) => availableScreenshotReferences.find((ref) => ref.id === id))
      .filter((ref): ref is ScreenshotReference => Boolean(ref))
      .map((ref) => ({
        ...ref,
        selectionReason: selection.selectionReason,
        sameInterfaceGroup: selection.sameInterfaceGroup || ref.sameInterfaceGroup,
      }));
    runtimeSelectedReferenceScreenshots = await loadSelectedReferenceScreenshots();
    await onSelectReferenceScreenshots?.({
      ...selection,
      ids: validIds,
      availableReferences: availableScreenshotReferences,
    });
    return validIds;
  };
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
    testCase,
    pageContext,
    completedSteps,
    stepIndex,
    beforeScreenshotPath,
    hasMarkerScreenshot: Boolean(markerScreenshot),
    markerOverlayInScreenshot,
    availableScreenshotReferences,
    selectedScreenshotReferences: runtimeSelectedScreenshotReferences,
    repairContext: input.repairContext,
  })}${userReferenceImagePrompt}`;
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
      selectedReferenceScreenshotCount: runtimeSelectedReferenceScreenshots.filter((item) => item.image).length,
      userReferenceImageCount: userReferenceImages.filter((item) => item.image).length,
      browserMode: mode,
    },
  });
  let lastAiRequest: AiRequestSnapshot | undefined;
  let lastRetryState: RuntimeRetryState | undefined;
  let consecutiveRequestFailures = 0;

  function rememberRetryState(state: RuntimeRetryState) {
    lastRetryState = cloneRuntimeRetryState(state);
  }

  async function runAgent(includeImage: boolean, retryState?: RuntimeRetryState) {
    const traces: ToolTrace[] = [];
    const codexMode = isCodexProvider();
    const retryAgentStepOffset = retryState?.agentStepOffset || 0;
    const observationStore: RuntimeObservationStore = input.runtimeObservationStore || new Map();
    if (retryState?.observationStore) restoreRuntimeObservationStore(observationStore, retryState.observationStore);
    const allowedToolTypes = runtimeAllowedToolTypes({
      browserChatMode,
      codexMode,
      nativeToolNames: runtimeToolNames(mode),
      observationToolNames: runtimeObservationToolNames,
    });
    const nativeToolsRef: { current?: RuntimeToolDefinitions } = {};
    const visualContext = new VisualContextManager();
    visualContext.init({ path: beforeScreenshotPath, originalPath: originalScreenshotPath, markerPath: markerScreenshotPath, stepIndex, capture: 'viewport', reason: 'Initial current screenshot for this agent loop' });
    const initialRequestPrompt = prompt;
    const requestPrompt = codexMode ? buildCodexObjectPrompt(initialRequestPrompt, allowedToolTypes) : initialRequestPrompt;
    const requestSystemPrompt: string | undefined = browserChatMode ? requestPrompt : undefined;
    let workingMemory: RuntimeWorkingMemory = {
      taskGoal: requirementOf(testCase),
      phase: browserChatMode
        ? 'Browser chat turn; answer directly when current evidence is enough, otherwise use one browser tool.'
        : 'Entering DOM Agent Loop; choose one DOM/text tool or report state.',
      completed: [],
      findings: [],
      blockers: [],
      pageUnderstanding: '',
      currentState: browserChatMode
        ? 'No page observation is preloaded; call getPageState when browser evidence is needed.'
        : 'No DOM observation is preloaded; call getPageState, then readObservation when page evidence is needed.',
      scrollSummary: '',
      userConstraints: systemPromptOf(testCase) ? [systemPromptOf(testCase)] : [],
      nextStep: browserChatMode
        ? 'Satisfy the latest user message; do not use a tool when a Markdown answer is already supported by evidence.'
        : 'Use the latest getPageState Node-processed text/interactive node_id views for the next missing goal; scroll only when content is lazy-loaded or viewport-dependent.',
      taskFrame: testCase.content.taskFrame,
    };
    let latestText = '';
    const initialVisualPaths: string[] = [];
    const initialSelectedReferenceImagePaths = browserChatMode ? [] : runtimeSelectedReferenceScreenshots.filter((item) => item.image).map((item) => item.ref.path);
    const initialUserReferenceImagePaths = userReferenceImages.filter((item) => item.image).map((item) => item.imagePath);
    type PendingObservationMessage = {
      text: string;
      imagePaths: string[];
      domContext?: AiDomContextSnapshot;
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
    const initialImagePaths = [...initialVisualPaths, ...initialSelectedReferenceImagePaths, ...initialUserReferenceImagePaths];
    const initialImages: Buffer[] = [];
    for (const imagePath of initialImagePaths) {
      const image = await readScreenshotForAi(imagePath).catch(() => undefined);
      if (image) initialImages.push(image);
    }
    let initialMessages = [...historyMessages] as RuntimeModelMessage[];
    if (browserChatMode) {
      const latestInstruction = (
        textFromUnknown(input.instruction)
        || textFromUnknown(testCase.description)
        || textFromUnknown(testCase.content?.description)
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
    } else {
      const initialContent: Array<{ type: 'text'; text: string } | { type: 'image'; image: Buffer }> = [{ type: 'text', text: requestPrompt }];
      for (const image of initialImages) initialContent.push({ type: 'image', image });
      initialMessages = [...historyMessages, { role: 'user' as const, content: initialContent }] as RuntimeModelMessage[];
    }
    if (retryState?.messages.length) {
      initialMessages = [...retryState.messages];
    }
    let messageImagePaths = retryState?.messages.length ? [...retryState.imagePaths] : [...initialImagePaths];
    rememberRetryState({
      messages: initialMessages,
      imagePaths: messageImagePaths,
      agentStepOffset: retryAgentStepOffset,
      observationStore,
    });
    let aiRequest = createAiRequestSnapshot({
      kind: 'runtime',
      stepIndex,
      prompt: browserChatMode ? '[system prompt]' : requestPrompt,
      systemPrompt: requestSystemPrompt,
      screenshotPath: undefined,
      imagePaths: messageImagePaths,
      imageAttached: Boolean(messageImagePaths.length),
      tools: allowedToolTypes,
      domContext: currentDomContext,
      options: { agentLoop: true, explicitPageState: true, visualContext: visualContext.snapshot(), workingMemory, imageCount: messageImagePaths.length, markerScreenshotPath, isMarked: false, markerOverlayInScreenshot: false, separateMarkerMap: false, modelSupportsScreenshotInput: modelSupportsScreenshotInput(), screenshotInputEnabled: false, screenshotToolEnabled: modelSupportsScreenshotInput(), browserMode: mode, visualClickMode: false, codexObjectMode: codexMode, selectedReferenceScreenshotCount: initialSelectedReferenceImagePaths.length, userReferenceImageCount: initialUserReferenceImagePaths.length, observationCount: runtimeObservationCount(observationStore, input.runId) },
    });
    lastAiRequest = aiRequest;
    const toolExecutionGate = { stepNumber: 0, executed: false };
    const stepTraceStarts = new Map<number, number>();
    const stepStartedAt = new Map<number, number>();
    const stepModelMessagesForLog = new Map<number, unknown>();
    let contextSegmentationTurns = 0;
    let pageStateObservationIndex = 0;
    const continuationSummaryMarker = '[WebPilot continuation summary]';

    async function observePageState(): Promise<BrowserActionResult> {
      ensureActive();
      const getPageStateStartedAt = Date.now();
      const pageContextStartedAt = Date.now();
      const currentPageContext = await session.getPageContext(runtimePageContextOptions(mode, { includeDomTree: true }));
      const pageContextMs = elapsedSince(pageContextStartedAt);
      ensureActive();
      const domContextStartedAt = Date.now();
      currentDomContext = createDomContextSnapshot(mode, currentPageContext);
      const domContextSnapshotMs = elapsedSince(domContextStartedAt);

      const nodeProcessingStartedAt = Date.now();
      const processedObservation = await processDomObservationInNode(currentPageContext.domTree || '');
      const nodeProcessingMs = elapsedSince(nodeProcessingStartedAt);
      ensureActive();
      const storeStartedAt = Date.now();
      const observationViews = domPageStateObservationViews(processedObservation);
      const observation = storeRuntimeObservation(
        observationStore,
        input.runId,
        'getPageState',
        formatDomPageStateObservation(currentPageContext, observationViews),
        observationViews,
      );
      const storeObservationMs = elapsedSince(storeStartedAt);
      const getPageStateTimings = {
        totalMs: elapsedSince(getPageStateStartedAt),
        getPageContextMs: pageContextMs,
        domContextSnapshotMs,
        nodeProcessingMs,
        storeObservationMs,
        pageContextTimings: currentPageContext.timings || {},
        nodeProcessingTimings: processedObservation.timings,
        domTreeChars: (currentPageContext.domTree || '').length,
        textChars: processedObservation.textCharLength,
        interactiveChars: processedObservation.interactiveCharLength,
        domNodeCount: processedObservation.domNodeCount,
        interactiveNodeCount: processedObservation.interactiveNodeCount,
      };
      await onDebug?.({
        phase: 'browser:get-page-state:dom-timings',
        stepIndex,
        message: `DOM getPageState timings: total=${getPageStateTimings.totalMs}ms, getPageContext=${pageContextMs}ms, readSimplifiedDomTree=${Number((currentPageContext.timings || {}).readSimplifiedDomTreeMs || 0)}ms, nodeProcessing=${nodeProcessingMs}ms, store=${storeObservationMs}ms.`,
        details: getPageStateTimings,
      });
      return {
        ok: true,
        actual: formatDomPageStateSummary(currentPageContext, observation, processedObservation, getPageStateTimings),
        observationViews,
        debug: domSnapshotDebug(currentPageContext, currentDomContext),
      };
    }

    async function observeCurrentScreenshot(options: { capture?: ScreenshotCaptureMode } = {}): Promise<BrowserActionResult> {
      ensureActive();
      if (!modelSupportsScreenshotInput()) {
        return { ok: false, actual: 'getCurrentScreenshot is unavailable because the configured model does not support image input.' };
      }
      pageStateObservationIndex += 1;
      const capture = options.capture === 'fullPage' ? 'fullPage' : 'viewport';
      const visualIndex = traces.length + pageStateObservationIndex + 1;
      const screenshotStartedAt = Date.now();
      const screenshotPath = await session.takeScreenshot(input.runId, stepIndex, `visual-${visualIndex}`, { capture });
      ensureActive();
      const timingSummary = session.formatLastScreenshotTiming();
      await onDebug?.({
        phase: 'browser:screenshot:current',
        stepIndex,
        message: `getCurrentScreenshot captured in ${elapsedSince(screenshotStartedAt)}ms${timingSummary ? ` ${timingSummary}` : ''}`,
        details: {
          elapsedMs: elapsedSince(screenshotStartedAt),
          path: screenshotPath,
          capture,
          toolName: 'getCurrentScreenshot',
          timings: session.getLastScreenshotTiming(),
        },
      });
      const frame = visualContext.apply({
        path: screenshotPath,
        originalPath: session.getLastOriginalScreenshotPath(),
        markerPath: undefined,
        stepIndex,
        toolName: 'getCurrentScreenshot',
        capture,
        reason: 'Explicit screenshot observation',
      }, { capture, retention: 'replace', reason: 'Explicit screenshot observation' });
      const observationText = [
        'Current screenshot observation:',
        `- ${capture} screenshot captured and attached to the next model request.`,
        '- Screenshot is visual evidence only. Use getPageState/readObservation and DOM node tools for actionable ids.',
        `Current URL: ${session.currentUrl()}`,
        `Image: ${basenameOfPath(frame.path)}`,
      ].join('\n');
      pendingObservationMessages.push({
        text: `[WebPilot explicit screenshot observation]\n${observationText}`,
        imagePaths: [frame.path],
        domContext: currentDomContext,
      });
      await onDebug?.({ phase: 'ai:visual-context', stepIndex, message: 'Visual Context Manager updated by getCurrentScreenshot.', details: visualContext.snapshot() });
      return {
        ok: true,
        actual: `${observationText}\n\n[The screenshot image will be attached to the next model request.]`,
      };
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
              goal: requirementOf(testCase),
              browserMode: mode,
              stepIndex,
              agentStep: agentStepIndex,
              estimatedTokens: messageStats.estimatedTotalTokens,
              thresholdTokens,
              modelMessages: modelMessagesForLog,
            }),
          }],
          temperature: 0.1,
          maxRetries: 0,
          abortSignal,
        });
        ensureActive();
        return trimDebugText(result.text || '', 12000) || fallbackContinuationSummary({
          goal: requirementOf(testCase),
          browserMode: mode,
          stepIndex,
          agentStep: agentStepIndex,
          traces,
          workingMemory,
        });
      } catch (error) {
        if (isBrowserChatAbortError(error, abortSignal)) throw browserChatAbortError(abortSignal);
        return fallbackContinuationSummary({
          goal: requirementOf(testCase),
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
      const agentStepIndex = retryAgentStepOffset + turnIndex + 1;
      const windowTokens = contextWindowTokens();
      const thresholdRatio = contextCompressionThresholdRatio();
      const thresholdTokens = Math.floor(windowTokens * thresholdRatio);
      const appendedMessages: RuntimeModelMessage[] = [];
      const appendedImagePaths: string[] = [];
      while (pendingObservationMessages.length) {
        const observation = pendingObservationMessages.shift();
        if (!observation) break;
        if (observation.domContext) currentDomContext = observation.domContext;
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

      let messagesToSend = previousMessages?.length ? [...previousMessages] : [...initialMessages];
      if (appendedMessages.length) {
        messagesToSend = [...messagesToSend, ...appendedMessages];
        messageImagePaths = [...messageImagePaths, ...appendedImagePaths];
      }
      messagesToSend = compactStaleReadObservationMessages(messagesToSend);

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
            : [{ role: 'user' as const, content: 'Continue from the continuation summary. If fresh page state is needed before acting, call getPageState.' }]),
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
      rememberRetryState({
        messages: [...messagesToSend],
        imagePaths: [...attachedImagePaths],
        agentStepOffset: agentStepIndex - 1,
        observationStore,
      });
      aiRequest = createAiRequestSnapshot({ kind: 'runtime', stepIndex, prompt: '[modelMessages logged separately]', systemPrompt: requestSystemPrompt, screenshotPath: undefined, imagePaths: attachedImagePaths, imageAttached: attachedImagePaths.length > 0, tools: allowedToolTypes, domContext: currentDomContext, options: { agentLoop: true, agentStepIndex, visualContext: visualContext.snapshot(), workingMemory, imageCount: attachedImagePaths.length, observationCount: runtimeObservationCount(observationStore, input.runId), explicitPageState: true, screenshotToolEnabled: modelSupportsScreenshotInput(), modelContextStats: { ...finalStats, windowTokens, thresholdRatio, thresholdTokens }, modelContextSegmentation } });
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
      const object = codexRuntimeObjectFromText(result.text, allowedToolTypes.includes('answer') ? 'answer' : 'reportState');
      const execution = await executeCodexRuntimeObject({
        session,
        targetUrl: testCase.targetUrl,
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
        onDebug,
        onVisualContextChange: async (snapshot) => { ensureActive(); await onDebug?.({ phase: 'ai:visual-context', stepIndex, message: 'Visual Context Manager updated.', details: snapshot }); },
        onToolTrace: async (trace) => {
          ensureActive();
          workingMemory = updateWorkingMemoryFromTrace(workingMemory, trace, stepIndex);
          await onToolTrace?.(trace, { workingMemory, visualContext: visualContext.snapshot() });
          ensureActive();
          await onDebug?.({ phase: 'ai:tool', stepIndex, message: trace.name + (trace.result ? ' -> ' + (trace.result.ok ? 'ok' : 'failed') : ' started'), details: { trace, visualContext: visualContext.snapshot(), workingMemory } });
        },
        onSelectReferenceScreenshots: async (selection) => { ensureActive(); await applySelectedReferenceScreenshots(selection); },
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
        endedWithText: browserChatMode && !execution.executed && Boolean(textFromUnknown(execution.text).trim()),
      };
    }

    const stopWhen = [hasToolCall('reportState'), hasToolCall('waitForHumanVerification')];
    nativeToolsRef.current = makeBrowserTools(session, testCase.targetUrl, mode, traces, aiRequest, async (trace) => {
      ensureActive();
      workingMemory = updateWorkingMemoryFromTrace(workingMemory, trace, stepIndex);
      await onToolTrace?.(trace, { workingMemory, visualContext: visualContext.snapshot() });
      ensureActive();
      await onDebug?.({
        phase: 'ai:tool',
        stepIndex,
        message: trace.name + (trace.result ? ' -> ' + (trace.result.ok ? 'ok' : 'failed') : ' started'),
        details: { trace, visualContext: visualContext.snapshot(), workingMemory },
      });
    }, {
      availableReferenceIds,
      allowedToolTypes,
      runId: input.runId,
      stepIndex,
      visualContext,
      observationStore,
      toolExecutionGate,
      getAiRequest: () => aiRequest,
      abortSignal,
      shouldContinue: input.shouldContinue,
      requestToolConfirmation: input.requestToolConfirmation,
      onDebug,
      observePageState,
      observeCurrentScreenshot,
      onVisualContextChange: async (snapshot) => {
        ensureActive();
        await onDebug?.({ phase: 'ai:visual-context', stepIndex, message: 'Visual Context Manager updated.', details: snapshot });
      },
      onSelectReferenceScreenshots: async (selection) => {
        ensureActive();
        await applySelectedReferenceScreenshots(selection);
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
      });
      ensureActive();
      latestText = result.text || latestText;
      return {
        text: latestText,
        traces,
        aiRequest,
        visualContext: visualContext.snapshot(),
        workingMemory,
        endedWithText: browserChatMode && Boolean(textFromUnknown(latestText).trim()) && traces.at(-1)?.name !== 'waitForHumanVerification',
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
  const consecutiveFailureLimit = runtimeRequestConsecutiveFailureLimit(browserChatMode);
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
      }
      return await runAgent(includeImage, retryState);
    } catch (error) {
      if (isBrowserChatAbortError(error, abortSignal) || (input.shouldContinue && !input.shouldContinue())) throw browserChatAbortError(abortSignal);
      lastError = error;
      consecutiveRequestFailures += 1;
      if (consecutiveRequestFailures >= consecutiveFailureLimit) break;
      retryingAfterFailure = true;
    }
  }

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

function browserChatRequirement(input: {
  targetUrl: string;
  instruction: string;
}) {
  return [
    'Browser chat mode: live conversation, not a fixed test case.',
    `Latest user message: ${input.instruction}`,
    `Fallback target URL: ${input.targetUrl || 'about:blank'}`,
    '',
    'Browser-chat behavior:',
    '- Follow the latest user message first; use earlier model messages only as conversation context.',
    '- Use browser tools only for live action or page inspection. If current evidence is enough, answer directly.',
    '- Stop this turn when the latest user message is satisfied, blocked by manual input, or needs clarification.',
    '- Final visible answer must be Chinese Markdown. Do not include JSON, tool parameters, candidate ids, coordinates, or screenshot paths.',
  ].filter(Boolean).join('\n');
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

function createInteractiveBrowserTestCase(input: {
  id: string;
  mode?: BrowserSessionMode;
  safetyMode?: BrowserChatSafetyMode;
  targetUrl: string;
  instruction: string;
  skillContext?: string;
}): TestCaseRecord {
  const now = new Date().toISOString();
  const targetUrl = input.targetUrl || 'about:blank';
  const requirement = browserChatRequirement({
    targetUrl,
    instruction: input.instruction,
  });
  const systemPrompt = [
    browserChatSafetyInstructions(input.safetyMode),
    input.skillContext,
  ].filter(Boolean).join('\n\n');
  return {
    id: input.id,
    title: 'Browser chat operation',
    description: input.instruction,
    targetUrl,
    status: 'running',
    priority: 'medium',
    content: {
      title: 'Browser chat operation',
      description: input.instruction,
      targetUrl,
      priority: 'medium',
      browserMode: 'dom',
      isMarked: false,
      userRequirement: requirement,
      systemPrompt,
      preconditions: [],
      testData: {},
      steps: [],
      expectedResults: ['Satisfy the latest user message or clearly report the blocker.'],
      risks: ['The user may continue the task with another chat message after this turn.'],
    },
    imageNames: [],
    createdAt: now,
    updatedAt: now,
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
  targetUrl: string;
  instruction: string;
  modelInstruction?: string;
  conversation?: InteractiveBrowserTurnMessage[];
  completedSteps?: StepExecutionResult[];
  mode?: BrowserSessionMode;
  safetyMode?: BrowserChatSafetyMode;
  referenceImagePaths?: string[];
  skillContext?: string;
  onProgress?: (step: StepExecutionResult) => void | Promise<void>;
  onDebug?: ExecutionDebug;
  abortSignal?: AbortSignal;
  shouldContinue?: () => boolean;
  requestToolConfirmation?: (request: BrowserToolConfirmationRequest) => Promise<BrowserToolConfirmationDecision>;
}): Promise<InteractiveBrowserTurnResult> {
  const ensureActive = () => throwIfStopped(input.abortSignal, input.shouldContinue);
  const steps = [...(input.completedSteps || [])];
  const newSteps: StepExecutionResult[] = [];
  const testCase = createInteractiveBrowserTestCase({
    id: `chat_${input.runId}`,
    mode: input.mode,
    safetyMode: input.safetyMode,
    targetUrl: input.targetUrl,
    instruction: input.instruction,
    skillContext: input.skillContext,
  });
  const runtimeMode = browserModeOf(testCase);
  let selectedScreenshotReferences: SelectedScreenshotReference[] = [];
  const runtimeObservationStore: RuntimeObservationStore = new Map();
  let finalStatus: InteractiveBrowserTurnResult['status'] = 'passed';
  let reply = '';
  let endedWithFinalAnswer = false;
  const maxConsecutiveAiRequestFailures = browserChatMaxConsecutiveAiRequestFailures();
  let consecutiveAiRequestFailures = 0;

  async function takeStepScreenshot(phase: 'before' | 'after', stepIndex: number) {
    if (runtimeMode === 'dom') {
      await input.onDebug?.({
        phase: `browser:screenshot:${phase}:skipped`,
        stepIndex,
        message: `DOM mode skipped ${phase} screenshot; using DOM page context instead.`,
        details: { browserMode: runtimeMode },
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
    const stepIndex = Math.max(0, ...steps.map((step) => step.index)) + 1;
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
        testCase,
        runId: input.runId,
        stepIndex,
        beforeScreenshotPath: beforeScreenshotPath || '',
        instruction: input.modelInstruction || input.instruction,
        conversation: input.conversation || [],
        completedSteps: steps.filter((step) => step.index !== stepIndex),
        runtimeObservationStore,
        selectedScreenshotReferences,
        referenceImagePaths: input.referenceImagePaths,
        onSelectReferenceScreenshots: async (selection) => {
          selectedScreenshotReferences = selection.ids
            .map((id) => selection.availableReferences.find((ref) => ref.id === id))
            .filter((ref): ref is ScreenshotReference => Boolean(ref))
            .map((ref) => ({
              ...ref,
              selectionReason: selection.selectionReason,
              sameInterfaceGroup: selection.sameInterfaceGroup || ref.sameInterfaceGroup,
            }));
        },
        abortSignal: input.abortSignal,
        shouldContinue: input.shouldContinue,
        requestToolConfirmation: input.requestToolConfirmation,
        onDebug: input.onDebug,
        onToolTrace: async (trace, progress) => {
          ensureActive();
          upsertToolTrace(liveToolTraces, trace);
          latestToolProgress = progress || latestToolProgress;
          await input.onProgress?.({
            ...runningStep,
            actual: 'AI called a browser tool; waiting for page feedback.',
            tools: summarizeToolTraces(liveToolTraces),
            ...progressFieldsFromToolTraces(liveToolTraces, requirementOf(testCase), stepIndex, latestToolProgress),
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
      const recoveredState = progressFieldsFromToolTraces(liveToolTraces, requirementOf(testCase), stepIndex, latestToolProgress);
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
    const decision = deriveBrowserChatStepDecision(actionResult.text, actionResult.traces, requirementOf(testCase));
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

function batchFillFieldsFromInput(input: Record<string, unknown>) {
  const rawFields = Array.isArray(input.fields) ? input.fields : [];
  return rawFields
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    .map((item) => ({
      id: String(item.id || ''),
      text: typeof item.text === 'string' ? item.text : undefined,
      clear: typeof item.clear === 'boolean' ? item.clear : undefined,
    }))
    .filter((item) => item.id.trim())
    .slice(0, BATCH_FILL_FIELD_LIMIT);
}

function normalizeBrowserUrl(url: string) {
  const trimmed = url.trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /^(about|data|file|blob):/i.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(trimmed)) return `http://${trimmed}`;
  return `https://${trimmed}`;
}

async function runRecordedTool(session: BrowserSession, targetUrl: string, flow: RecordedFlowStep, runId?: string): Promise<BrowserActionResult> {
  const input = flowInput(flow.input);
  const text = typeof input.text === 'string' ? input.text : undefined;
  const reason = flow.reason ? ` Recorded reason: ${flow.reason}` : '';

  switch (flow.name) {
    case 'openPage':
      {
        const rawUrl = typeof input.url === 'string' && input.url.trim() ? input.url : targetUrl;
        const url = normalizeBrowserUrl(rawUrl);
        if (!url) return { ok: false, actual: 'Recorded openPage failed because the target URL is empty.' };
        return session.open(url);
      }
    case 'scrollArea':
      {
        const areaId = typeof input.areaId === 'string' && input.areaId.trim()
          ? input.areaId.trim()
          : typeof input.id === 'string' && /^S\d+$/i.test(input.id.trim())
            ? input.id.trim()
            : '';
        return session.scrollArea(
          areaId,
          typeof input.deltaY === 'number' ? input.deltaY : 0,
          typeof input.deltaX === 'number' ? input.deltaX : 0,
        );
      }
    case 'getDomNodeText':
      return session.getDomNodeText(normalizeDomNodeIdParam(input));
    case 'clickDomNode':
      return session.clickDomNode(normalizeDomNodeIdParam(input), text);
    case 'focusDomNode':
      return session.focusDomNode(normalizeDomNodeIdParam(input));
    case 'fillDomNodes':
      return session.fillDomNodes(batchFillFieldsFromInput(input).map((field) => ({
        ...field,
        id: normalizeDomNodeIdString(field.id),
      })));
    case 'hoverDomNode':
      return session.hoverDomNode(normalizeDomNodeIdParam(input));
    case 'doubleClickDomNode':
      return session.doubleClickDomNode(normalizeDomNodeIdParam(input));
    case 'dragDomNode':
      return session.dragDomNode(
        normalizeDomNodeIdString(input.fromId) || normalizeDomNodeIdString(input.fromNodeId),
        normalizeDomNodeIdString(input.toId) || normalizeDomNodeIdString(input.toNodeId),
      );
    case 'clickCandidate':
      return session.clickCandidate(String(input.id || ''), text);
    case 'fillCandidates':
      return session.fillCandidates(batchFillFieldsFromInput(input));
    case 'focusCandidate':
      return session.clickCandidate(String(input.id || ''), text);
    case 'hoverCandidate':
      return session.hoverCandidate(String(input.id || ''));
    case 'doubleClickCandidate':
      return session.doubleClickCandidate(String(input.id || ''));
    case 'rightClickCandidate':
      return session.rightClickCandidate(String(input.id || ''));
    case 'dragCandidate':
      return session.dragCandidate(String(input.fromId || ''), String(input.toId || ''));
    case 'findByText':
      return session.findByText(String(input.targetText || input.targetVisual || ''), normalizeDomNodeIdParam({ id: input.scopeId }));
    case 'clickLocator':
      return session.clickLocator(String(input.locatorId || input.id || ''), text);
    case 'typeText':
      return session.typeText(String(input.text || ''));
    case 'pressKey':
      return session.press(String(input.key || ''));
    case 'waitForPage':
      return typeof input.ms === 'number' ? session.wait(input.ms) : session.waitForPage();
    case 'waitForHumanVerification':
      return session.waitForManualVerification(typeof input.maxMs === 'number' ? input.maxMs : undefined);
    case 'listTabs':
      return session.listTabs();
    case 'getHttpRequests':
      return session.getCurrentTabHttpRequests();
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
    case 'switchTab':
      return session.switchTab(typeof input.index === 'number' ? input.index : Number(input.index || 0));
    case 'reportState':
      return { ok: true, actual: `Reported state without browser action: ${String(input.actual || input.reason || '')}` };
    case 'selectReferenceScreenshots':
      return { ok: true, actual: `Selected screenshot references for context only: ${(Array.isArray(input.ids) ? input.ids : []).join(', ') || '[none]'}.` };
    case 'getInteractiveCandidates':
      return session.getInteractiveCandidates();
    default:
      return { ok: false, actual: `Unsupported recorded tool: ${flow.name}.${reason}` };
  }
}

async function executeCodexRuntimeObject(input: {
  session: BrowserSession;
  targetUrl: string;
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
  onVisualContextChange?: (snapshot: ReturnType<VisualContextManager['snapshot']>) => void | Promise<void>;
  onToolTrace?: (trace: ToolTrace, progress?: ToolTraceProgress) => void | Promise<void>;
  onDebug?: ExecutionDebug;
  onSelectReferenceScreenshots?: (selection: {
    ids: string[];
    selectionReason: string;
    sameInterfaceGroup?: string;
  }) => void | Promise<void>;
}) {
  const { session, targetUrl, runId, stepIndex, mode, type, message, params, allowedTypes, traces, aiRequest, visualContext, abortSignal, shouldContinue, requestToolConfirmation, onVisualContextChange, onToolTrace, onDebug, onSelectReferenceScreenshots } = input;
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

  if (type === 'selectReferenceScreenshots') {
    throwIfStopped(abortSignal, shouldContinue);
    await onSelectReferenceScreenshots?.({
      ids: Array.isArray(params.ids) ? params.ids.filter((id): id is string => typeof id === 'string') : [],
      selectionReason: typeof params.selectionReason === 'string' ? params.selectionReason : String(params.reason || ''),
      sameInterfaceGroup: typeof params.sameInterfaceGroup === 'string' ? params.sameInterfaceGroup : undefined,
    });
  }

  const normalizedParams = { ...params };
  if (type === 'fillDomNodes' && Array.isArray(normalizedParams.fields)) {
    normalizedParams.fields = normalizedParams.fields.map((field) => (
      field && typeof field === 'object' && !Array.isArray(field)
        ? { ...field, id: normalizeDomNodeIdString((field as Record<string, unknown>).id) || (field as Record<string, unknown>).id }
        : field
    ));
  } else if (type === 'dragDomNode') {
    normalizedParams.fromId = normalizeDomNodeIdString(normalizedParams.fromId) || normalizeDomNodeIdString(normalizedParams.fromNodeId) || normalizedParams.fromId;
    normalizedParams.toId = normalizeDomNodeIdString(normalizedParams.toId) || normalizeDomNodeIdString(normalizedParams.toNodeId) || normalizedParams.toId;
  } else if (domNodeIdToolNames.has(type)) {
    const nodeId = normalizeDomNodeIdParam(normalizedParams);
    if (nodeId) normalizedParams.id = nodeId;
  }
  if (type === 'scrollArea') {
    const areaId = typeof normalizedParams.areaId === 'string' && normalizedParams.areaId.trim()
      ? normalizedParams.areaId.trim()
      : typeof normalizedParams.id === 'string' && /^S\d+$/i.test(normalizedParams.id.trim())
        ? normalizedParams.id.trim()
        : '';
    normalizedParams.areaId = areaId || normalizedParams.areaId;
  }
  const flow: RecordedFlowStep = {
    index: stepIndex,
    name: type,
    input: normalizedParams,
    reason: typeof normalizedParams.reason === 'string' ? normalizedParams.reason : undefined,
  };
  const pendingConfirmation = requestToolConfirmation ? toolConfirmationFromInput(type, normalizedParams) : undefined;

  await executeTracedBrowserAction({
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
    action: async () => {
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
      }
      return candidateActionToolNames.has(type)
        ? validateCandidateActionBeforeExecution(type, normalizedParams, traces) || await runRecordedTool(session, targetUrl, flow, runId)
        : await runRecordedTool(session, targetUrl, flow, runId);
    },
  });
  return { text: readableActionFromRawText(message) || '', executed: true };
}
