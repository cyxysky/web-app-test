import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { generateText, hasToolCall, tool, type ModelMessage } from 'ai';
import sharp from 'sharp';
import { z } from 'zod';
import type { AiRequestSnapshot, AiToolContextSnapshot, RecordedFlowStep, RuntimeWorkingMemory, StepExecutionResult, StepToolCall, TaskFrame, TaskLedgerItem, TestCaseRecord, VisualFrameRecord } from '@/server/ai/schemas/test-case.schema';
import { getModel, getModelSettings } from '@/server/ai/model';
import { buildCodexObjectPrompt, buildCompletionPromptLines, buildCompletionVerificationPrompt, customRuntimePromptFromEnv } from '@/server/ai/prompts/runtime-agent.prompt';
import { clearStepAbortController, registerStepAbortController } from '@/server/ai/run-control.registry';
import { BrowserSession, type BrowserActionResult, type BrowserSessionMode, type BrowserSnapshotViews, type ScreenshotCaptureMode } from '@/server/browser/browser-session';
import { richTextToPlainText } from '@/lib/rich-text';
import { downloadFileArtifact, formatFileArtifactResult, generateMarkdownArtifact } from './file-artifact-tools';
import {
  browserInteractToolDescription,
  browserInteractToolShape,
} from './browser-input-tool-schema';
import {
  compactStaleSnapshotMessages,
  invalidateRuntimeObservation,
  restoreRuntimeObservationStore,
  runtimeObservationCount,
  runtimeObservationInvalidatingToolNames,
  runtimeObservationToolNames,
  storeRuntimeObservation,
  type RuntimeObservationReadOptions,
  type RuntimeObservationStore,
} from './runtime-observation';
import { browserActionRules, currentSnapshotContextLine, screenshotObservationRule, snapshotHardRules } from './runtime-prompt-rules';
import { summarizeRuntimeLogTimings } from './runtime-log-timings';
import { cloneRuntimeRetryState, type RuntimeRetryState as RuntimeRetryStateBase } from './runtime-retry-state';
import { runtimeAllowedToolTypes } from './runtime-tool-selection';
import { notifyRuntimeToolTrace, runtimeToolTraceId } from './runtime-tool-trace';

type ExecutionProgress = (step: StepExecutionResult) => void | Promise<void>;
type ExecutionDebug = (event: { phase: string; message: string; stepIndex?: number; details?: unknown }) => void | Promise<void>;
type ManualIntervention = { stepIndex: number; reason: string; screenshotPath?: string };
type RuntimeModelMessage = ModelMessage;
type RuntimeRetryState = RuntimeRetryStateBase<RuntimeModelMessage>;
type ExecutionOptions = {
  onProgress?: ExecutionProgress;
  onDebug?: ExecutionDebug;
  initialSteps?: StepExecutionResult[];
  shouldSkipStep?: (stepIndex: number) => boolean | Promise<boolean>;
  shouldPauseRun?: (stepIndex: number) => boolean | Promise<boolean>;
  shouldResumeStep?: (stepIndex: number) => boolean | Promise<boolean>;
  onPaused?: (stepIndex: number) => void | Promise<void>;
  onResumed?: (stepIndex: number) => void | Promise<void>;
  onManualIntervention?: (manualIntervention: ManualIntervention) => void | Promise<void>;
  onManualInterventionCleared?: (stepIndex: number) => void | Promise<void>;
  recordedFlow?: RecordedFlowStep[];
};

type TestExecutionResult = {
  status: 'passed' | 'failed' | 'blocked';
  result: {
    steps: StepExecutionResult[];
    consoleErrors: string[];
    networkErrors: string[];
    tracePath?: string;
  };
};

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
  contextBefore?: AiToolContextSnapshot;
  contextAfter?: AiToolContextSnapshot;
  visualAfter?: VisualAfterPolicy;
  screenshots?: Array<{
    title: string;
    path: string;
    kind?: 'current' | 'history' | 'pinned' | 'after' | 'marker' | 'original' | 'other';
  }>;
};

function cloneRuntimeMessageState(state?: RuntimeRetryState): RuntimeRetryState | undefined {
  if (!state?.messages.length) return undefined;
  return cloneRuntimeRetryState(state);
}

function responseMessagesFromGenerateTextResult(result: unknown): RuntimeModelMessage[] {
  const response = recordFromUnknown(recordFromUnknown(result).response);
  const messages = response.messages;
  return Array.isArray(messages) ? messages as RuntimeModelMessage[] : [];
}

function appendRuntimeResponseMessages(
  state: RuntimeRetryState | undefined,
  responseMessages: RuntimeModelMessage[],
) {
  const base = cloneRuntimeMessageState(state);
  if (!base) return undefined;
  return {
    ...base,
    agentStepOffset: base.agentStepOffset + 1,
    messages: responseMessages.length ? [...base.messages, ...responseMessages] : base.messages,
  };
}

type ToolTraceProgress = {
  workingMemory: RuntimeWorkingMemory;
  visualContext: ReturnType<VisualContextManager['snapshot']>;
};

type VisualAfterPolicy = {
  capture?: 'auto' | 'viewport' | 'fullPage';
  retention?: 'auto' | 'replace' | 'append';
  reason?: string;
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
  message: z.string().nullable().optional().describe('Optional short Chinese progress text that must match the selected tool: takeScreenshot reads pixels; inspect reads the accessibility tree.'),
  params: z.object({
    reason: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    urlOrPath: z.string().nullable().optional(),
    uid: z.string().nullable().optional(),
    text: z.string().nullable().optional(),
    content: z.string().nullable().optional(),
    fileName: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    capture: z.enum(['viewport', 'fullPage']).nullable().optional(),
    markers: z.boolean().nullable().optional(),
    key: z.string().nullable().optional(),
    keys: z.array(z.string()).nullable().optional(),
    path: z.string().nullable().optional(),
    toUid: z.string().nullable().optional(),
    x_thousandth: z.number().nullable().optional(),
    y_thousandth: z.number().nullable().optional(),
    toX_thousandth: z.number().nullable().optional(),
    toY_thousandth: z.number().nullable().optional(),
    button: z.enum(['left', 'right', 'middle']).nullable().optional(),
    clickCount: z.number().nullable().optional(),
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
    mode: z.enum(['full', 'text', 'changes']).nullable().optional(),
    cursor: z.string().nullable().optional(),
    query: z.string().nullable().optional(),
    tag: z.string().nullable().optional(),
    roles: z.array(z.string()).nullable().optional(),
    limit: z.number().nullable().optional(),
    includeAx: z.boolean().nullable().optional(),
    includeShadow: z.boolean().nullable().optional(),
    value: z.string().nullable().optional(),
    label: z.string().nullable().optional(),
    replace: z.boolean().nullable().optional(),
    followByEnter: z.boolean().nullable().optional(),
    ids: z.array(z.string()).nullable().optional(),
    selectionReason: z.string().nullable().optional(),
    sameInterfaceGroup: z.string().nullable().optional(),
  }).describe('Parameters for the selected tool. Include only keys needed by that tool plus a concise reason.'),
});
type CodexRuntimeObject = z.infer<typeof codexRuntimeObjectSchema>;

const manualIssuePattern = new RegExp(
  [
    '\\u9a8c\\u8bc1\\u7801',
    '\\u5b89\\u5168\\u6821\\u9a8c',
    '\\u5b89\\u5168\\u9a8c\\u8bc1',
    '\\u4eba\\u673a\\u9a8c\\u8bc1',
    '\\u4eba\\u5de5',
    '\\u7528\\u6237\\u4ecb\\u5165',
    'captcha',
    'verification\\s*code',
    'security\\s*check',
    'human\\s*verification',
    'two[-\\s]?factor',
    '\\b2fa\\b',
    '\\botp\\b',
  ].join('|'),
  'i',
);

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

type RuntimePageContext = Awaited<ReturnType<BrowserSession['getPageContext']>>;

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
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (Buffer.isBuffer(item)) return `[Buffer ${item.length} bytes]`;
    return item;
  }));
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

function fileArtifactAction(name: string, input?: unknown) {
  if (name === 'downloadFile') return 'download';
  if (name === 'generateMarkdownFile') return 'writeMarkdown';
  if (name !== 'file' || !input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const action = (input as Record<string, unknown>).action;
  return action === 'download' || action === 'writeMarkdown' ? action : undefined;
}

function userFacingToolResult(name: string, result?: BrowserActionResult, _max = 360, input?: unknown) {
  void _max;
  if (!result) return undefined;
  const fileResult = formatFileArtifactResult(fileArtifactAction(name, input), result.actual);
  if (fileResult) return fileResult;
  return result.actual;
}

function compactToolResultForModel(
  name: string,
  result: BrowserActionResult,
  _observationStore?: RuntimeObservationStore,
  input?: unknown,
): BrowserActionResult {
  void _observationStore;
  const modelResult = result;
  if (!modelResult.actual) return modelResult;
  const fileResult = modelResult.ok ? formatFileArtifactResult(fileArtifactAction(name, input), modelResult.actual) : undefined;
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
  const { reason, ...rest } = safeInput as Record<string, unknown>;
  const compactInput = Object.keys(rest).length ? rest : undefined;
  return {
    input: compactInput,
    reason: typeof reason === 'string' && reason.trim() ? trimDebugText(reason.trim(), 300) : undefined,
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

// 为每次 AI 请求加超时保护，避免模型长时间无响应导致整次执行卡死。
function generateTextTimeoutMs(options: Parameters<typeof generateText>[0]) {
  void options;
  const raw = Number(process.env.AI_TEST_REQUEST_TIMEOUT_MS || 30000);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 30000;
}

async function generateTextWithTimeout(options: Parameters<typeof generateText>[0]) {
  if (typeof (options as { prepareStep?: unknown }).prepareStep === 'function') {
    return generateText(options);
  }
  const timeoutMs = generateTextTimeoutMs(options);
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new Error(`AI request timed out after ${timeoutMs}ms`)), timeoutMs);
  const upstream = options.abortSignal;
  const abortSignal = upstream ? AbortSignal.any([upstream, timeoutController.signal]) : timeoutController.signal;
  try {
    return await generateText({ ...options, abortSignal });
  } catch (error) {
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

function codexRuntimeObjectFromText(text: string, fallbackType: 'reportState' = 'reportState'): CodexRuntimeObject {
  let raw: Record<string, unknown> | undefined;
  try {
    raw = recordFromUnknown(extractJson(text));
  } catch {
    const fallbackText = trimDebugText((text || '').trim() || 'Codex did not return a valid action JSON.', 2000);
    return {
      type: fallbackType,
      message: fallbackText,
      params: {
        actual: fallbackText,
        status: 'blocked',
        done: true,
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
function summarizeToolTraces(traces: ToolTrace[]): StepToolCall[] {
  return traces.map((trace) => {
    const { input, reason } = splitToolInputAndReason(trace.input);
    return {
      name: trace.name,
      input,
      reason,
      ok: trace.result?.ok,
      result: userFacingToolResult(trace.name, trace.result, 360, trace.input),
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

function recentProgressNotes(steps: StepExecutionResult[], limit = 5) {
  return steps
    .filter((step) => step.note && step.note.trim())
    .slice(-limit)
    .map((step) => `Step ${step.index}: ${step.note}`);
}

function screenshotPhaseLabel(phase: ScreenshotReference['phase']) {
  if (phase === 'before') return 'before action';
  if (phase === 'after') return 'after action';
  return 'step screenshot';
}

function screenshotReferenceGroupOf(step: StepExecutionResult) {
  const scrollTool = (step.tools || []).find((toolCall) => {
    if (toolCall.name !== 'interact' && toolCall.name !== 'mouse') return false;
    const input = toolCall.input && typeof toolCall.input === 'object' && !Array.isArray(toolCall.input)
      ? toolCall.input as Record<string, unknown>
      : {};
    return input.action === 'scroll';
  });
  if (!scrollTool) return undefined;
  const input = scrollTool.input && typeof scrollTool.input === 'object' && !Array.isArray(scrollTool.input)
    ? scrollTool.input as Record<string, unknown>
    : {};
  const area = typeof input.uid === 'string' ? `uid-${input.uid}` : 'page';
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
    const fileResult = trace.result?.ok ? formatFileArtifactResult(fileArtifactAction(trace.name, trace.input), trace.result.actual) : undefined;
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
    '- Preserve that only UIDs from the latest inspect action=capture and coordinates from the latest viewport takeScreenshot are valid for interaction.',
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
  return /No capacity available|Request aborted|Active browser page has been closed|Execution context was destroyed|ECONNRESET|ETIMEDOUT|UND_ERR_SOCKET|other side closed|Cannot connect to API|timeout|rate limit|model .*server|Failed after \d+ attempts/i.test(value);
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






function defaultVisualAfterForTool(name: string): VisualAfterPolicy {
  void name;
  return { capture: 'auto', retention: 'replace' };
}

function domStepScreenshotsEnabled() {
  return process.env.TARGET_DOM_SCREENSHOTS === 'true' || process.env.BROWSER_CHAT_DOM_SCREENSHOTS === 'true';
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
      .replace(/\b(?:interact|mouse|keyboard)\s*\([^)]*\)/gi, '根据当前页面选择合适工具'),
    220,
  );
}

function sanitizeCurrentState(value: unknown) {
  if (typeof value !== 'string') return '';
  return sanitizeHistoricalToolText(
    value
      .replace(/\b(?:interact|mouse|keyboard)\s*\([^)]*\)/gi, '已执行页面操作')
      .replace(/(?:候选|编号|id)\s*\d+/gi, '当前截图中的目标'),
    260,
  );
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
  if (!domStepScreenshotsEnabled()) return false;
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
  const displayResult = userFacingToolResult(trace.name, trace.result, trace.result?.ok ? 160 : 180, trace.input);
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
  const displayResult = userFacingToolResult(trace.name, trace.result, 400, trace.input);
  const resultText = sanitizeHistoricalToolText(displayResult || '', 400);
  next.lastAction = summarizeTraceForMemory(trace);
  next.lastResult = concise(displayResult || trace.result?.actual || '工具调用已开始，正在等待页面反馈。', 240);
  if (resultText) {
    next.pageUnderstanding = resultText;
    next.currentState = concise(`${trace.name}: ${resultText}`, 260);
  }
  if (trace.result && !trace.result.ok) next.blockers = Array.from(new Set([...next.blockers, concise(trace.result.actual, 220)])).slice(-8);
  if ((trace.name === 'interact' || trace.name === 'mouse') && trace.input && typeof trace.input === 'object' && !Array.isArray(trace.input) && (trace.input as Record<string, unknown>).action === 'scroll') {
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
  if (domStepScreenshotsEnabled()) pushBeforeFrameScreenshots(screenshots, name, visualContext?.current());
  const visualAfter = domStepScreenshotsEnabled() ? visualAfterFromInput(name, toolInput) : undefined;
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
  onVisualContextChange?: (snapshot: ReturnType<VisualContextManager['snapshot']>) => void | Promise<void>;
}) {
  const { session, traces, trace, runId, stepIndex, visualContext, onVisualContextChange } = input;
  let result = input.result;
  const screenshots = trace.screenshots || [];
  const visualAfter = trace.visualAfter || defaultVisualAfterForTool(trace.name);

  if (result.ok && shouldCaptureVisualAfter(trace.name, visualAfter) && runId && stepIndex !== undefined && visualContext) {
    try {
      const visualIndex = traces.filter((item) => item.screenshots?.some((shot) => shot.kind === 'current')).length + 1;
      const screenshotOptions = screenshotOptionsFromVisualAfter(visualAfter);
      const screenshotPath = await session.takeScreenshot(runId, stepIndex, `visual-${visualIndex}`, screenshotOptions);
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
  action: () => Promise<BrowserActionResult>;
  aiRequest?: AiRequestSnapshot;
  runId?: string;
  stepIndex?: number;
  visualContext?: VisualContextManager;
  onToolTrace?: (trace: ToolTrace) => void | Promise<void>;
  onVisualContextChange?: (snapshot: ReturnType<VisualContextManager['snapshot']>) => void | Promise<void>;
}) {
  const { session, traces, name, toolInput, action, aiRequest, runId, stepIndex, visualContext, onToolTrace, onVisualContextChange } = input;
  const trace = createToolTrace({ traces, name, toolInput, aiRequest, runId, stepIndex, visualContext });
  const postprocessTimings: Record<string, number> = {};
  trace.postprocessTimings = postprocessTimings;
  let postprocessStartedAt = Date.now();
  await notifyRuntimeToolTrace(onToolTrace, trace);
  postprocessTimings.notifyStartMs = elapsedSince(postprocessStartedAt);

  let result: BrowserActionResult;
  const actionStartedAt = Date.now();
  try {
    result = await action();
  } catch (error) {
    result = {
      ok: false,
      actual: `Tool ${name} threw after execution started: ${infrastructureError(error)}`,
    };
  }
  trace.actionElapsedMs = elapsedSince(actionStartedAt);

  trace.result = result;
  postprocessStartedAt = Date.now();
  await notifyRuntimeToolTrace(onToolTrace, trace);
  postprocessTimings.notifyResultMs = elapsedSince(postprocessStartedAt);
  postprocessStartedAt = Date.now();
  result = await finalizeToolTraceVisuals({
    session,
    traces,
    trace,
    result,
    runId,
    stepIndex,
    visualContext,
    onVisualContextChange,
  });
  postprocessTimings.visualAfterMs = elapsedSince(postprocessStartedAt);
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
    onVisualContextChange?: (snapshot: ReturnType<VisualContextManager['snapshot']>) => void | Promise<void>;
    takeSnapshot?: (input?: RuntimeObservationReadOptions) => Promise<BrowserActionResult>;
    observeCurrentScreenshot?: (input?: { capture?: ScreenshotCaptureMode; markers?: boolean }) => Promise<BrowserActionResult>;
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
    visualAfter: z.object({
      capture: z.enum(['auto', 'viewport', 'fullPage']).optional().describe('Use auto normally. Use viewport/fullPage only when the next model request truly needs that screenshot size.'),
      retention: z.enum(['auto', 'replace', 'append']).optional().describe('Use replace by default. Use append only when the next decision must compare with, continue from, or analyze together with the previous screenshot.'),
      reason: z.string().optional().describe(`Short Chinese reason for append/capture choice. ${toolTextRule}`),
    }).optional(),
  };
  const browserToolInput = <T extends z.ZodRawShape>(shape: T) => z.object({ ...toolContextShape, ...shape });
  const inspectInput = browserToolInput({
    action: z.enum(['capture', 'search', 'httpRequests']).default('capture').describe('capture reads or pages the semantic DOM baseline; search queries the frozen baseline; httpRequests reads network requests.'),
    cursor: z.string().min(1).optional().describe('Opaque nextCursor returned by an earlier inspect action=capture page. When set, mode must match that page.'),
    mode: z.enum(['full', 'text', 'changes']).default('full').describe('For action=capture: full reads the complete loaded semantic DOM; text reads all text from that same complete full DOM, including offscreen content; changes reads the inter-action journal.'),
    query: z.string().min(1).max(500).optional().describe('For action=search, the text to find in the frozen DOM baseline.'),
    tag: z.string().min(1).max(80).optional().describe('For action=search, return matching HTML tags from the complete frozen DOM baseline.'),
    uid: z.string().min(1).max(80).optional().describe('For action=search, inspect one exact current dom-* UID. Required when includeShadow=true.'),
    roles: z.array(z.string().min(1)).max(20).optional().describe('For action=search, optionally restrict results to accessibility roles.'),
    limit: z.number().int().min(1).max(100).optional().describe('For action=search, maximum number of results.'),
    includeAx: z.boolean().optional().describe('For action=search, add bounded local AX semantics for one exact UID or a narrow result.'),
    includeShadow: z.boolean().optional().describe('For action=search with one exact uid, perform bounded local CDP shadow piercing plus local AX enrichment.'),
    ids: z.array(z.string().min(1)).min(1).max(20).optional().describe('For action=httpRequests, optional request IDs from action=capture mode=changes. Omit to list recent requests.'),
  }).superRefine((input, context) => {
    if (input.action === 'search' && !input.query && !input.tag && !input.uid) context.addIssue({ code: z.ZodIssueCode.custom, message: 'action=search requires query, tag, or uid.' });
    if (input.action === 'search' && input.includeShadow && !input.uid) context.addIssue({ code: z.ZodIssueCode.custom, message: 'includeShadow requires one exact uid.' });
  });
  const interactInput = browserToolInput(browserInteractToolShape).superRefine((input, context) => {
    if (input.action !== 'selectOption') return;
    if (!input.uid?.trim()) context.addIssue({ code: z.ZodIssueCode.custom, message: 'action=selectOption requires a fresh select uid.' });
    if (!input.value?.trim() && !input.label?.trim()) context.addIssue({ code: z.ZodIssueCode.custom, message: 'action=selectOption requires value or label.' });
  });

  async function record(name: string, input: unknown, action: () => Promise<BrowserActionResult>) {
    if (toolExecutionGate.executed) {
      // Do not execute or trace extra calls; just tell the model to stop. This keeps the recorded
      // step clean (one real action) and avoids any duplicate side effect.
      return {
        ok: false,
        actual: `Ignored: only one browser tool can execute in model step ${toolExecutionGate.stepNumber + 1}. Continue from the executed tool result in the next model step.`,
      } satisfies BrowserActionResult;
    }
    toolExecutionGate.executed = true;
    const traceVisualContext = referenceOptions?.visualContext;
    return executeTracedBrowserAction({
      session,
      traces,
      name,
      toolInput: input,
      runId: referenceOptions?.runId,
      stepIndex: referenceOptions?.stepIndex,
      visualContext: traceVisualContext,
      aiRequest: referenceOptions?.getAiRequest?.() || aiRequest,
      onToolTrace,
      onVisualContextChange: traceVisualContext ? referenceOptions?.onVisualContextChange : undefined,
      action,
    }).then((result) => {
      const inputRecord = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
      const readOnlyMergedAction = name === 'browser'
        && (inputRecord.action === 'wait' || inputRecord.action === 'listTabs');
      if (runtimeObservationInvalidatingToolNames.has(name) && !readOnlyMergedAction) {
        // Action results carry their authoritative incremental delta in
        // domChanges. Snapshots remain explicit, server-side observations;
        // never append or return a second text representation after an action.
        if (!result.ok || !result.domChanges) {
          invalidateRuntimeObservation(referenceOptions?.observationStore, referenceOptions?.runId, name);
        }
      }
      return compactToolResultForModel(name, result, referenceOptions?.observationStore, input);
    });
  }

  const sharedTools = {
    ...(modelSupportsScreenshotInput() ? {
      takeScreenshot: tool({
        description: 'Capture a visual screenshot and attach it to the next model request. Set markers=true to label visible interactive elements with the same dom-* UIDs returned by inspect. The latest viewport screenshot can be targeted with interact x_thousandth and y_thousandth coordinates; fullPage screenshots are read-only evidence.',
        inputSchema: browserToolInput({
          capture: z.enum(['viewport', 'fullPage']).optional().describe('Screenshot size. Defaults to viewport; use fullPage only when the visual evidence is outside the current viewport.'),
          markers: z.boolean().optional().describe('For viewport screenshots, overlay the current B-chain DOM UIDs on visible interactive elements.'),
        }),
        execute: (input) => record('takeScreenshot', input, async () => (
          referenceOptions?.observeCurrentScreenshot
            ? referenceOptions.observeCurrentScreenshot({ capture: input.capture, markers: input.markers })
            : { ok: false, actual: 'takeScreenshot is unavailable in this runtime.' }
        )),
      }),
    } : {}),
    browser: tool({
      description: 'Navigate and manage browser tabs. action=open opens a URL in the current or a new tab; action=wait waits for page stability or an exact duration; action=listTabs returns tabs; action=switchTab activates the supplied tab index.',
      inputSchema: browserToolInput({
        action: z.enum(['open', 'wait', 'listTabs', 'switchTab']),
        url: z.string().optional().describe('For action=open, the URL to open. Defaults to the test target URL.'),
        target: z.enum(['current', 'new']).optional().describe('For action=open, open in the current or a new tab. Defaults to current.'),
        ms: z.number().int().nonnegative().optional().describe('For action=wait, optional exact minimum wait duration.'),
        index: z.number().int().nonnegative().optional().describe('For action=switchTab, index returned by action=listTabs.'),
      }).superRefine((input, context) => {
        if (input.action === 'switchTab' && typeof input.index !== 'number') context.addIssue({ code: z.ZodIssueCode.custom, message: 'action=switchTab requires index.' });
      }),
      execute: (input) => record('browser', input, () => {
        if (input.action === 'wait') return typeof input.ms === 'number' ? session.wait(input.ms) : session.waitForPage();
        if (input.action === 'listTabs') return session.listTabs();
        if (input.action === 'switchTab') return session.switchTab(input.index ?? 0);
        return input.target === 'new' ? session.openInNewTab(input.url || targetUrl) : session.open(input.url || targetUrl);
      }),
    }),
    interact: tool({
      description: browserInteractToolDescription,
      inputSchema: interactInput,
      execute: (input) => record('interact', input, () => {
        if (input.action === 'click' || input.action === 'move' || input.action === 'drag' || input.action === 'scroll' || input.action === 'scrollIntoView') {
          return session.mouse({
            action: input.action,
            uid: input.uid,
            xThousandth: input.x_thousandth,
            yThousandth: input.y_thousandth,
            toUid: input.toUid,
            toXThousandth: input.toX_thousandth,
            toYThousandth: input.toY_thousandth,
            button: input.button,
            clickCount: input.clickCount,
            deltaX: input.deltaX,
            deltaY: input.deltaY,
          });
        }
        if (input.action === 'selectOption') return session.selectOption({ uid: input.uid || '', value: input.value, label: input.label });
        return session.keyboard({
          action: input.action,
          uid: input.uid,
          xThousandth: input.x_thousandth,
          yThousandth: input.y_thousandth,
          text: input.text,
          key: input.key,
          keys: input.keys,
          replace: input.replace,
          followByEnter: input.followByEnter,
        });
      }),
    }),
    waitForHumanVerification: tool({
      description: 'Wait while the user completes a visible CAPTCHA, login verification, or security check in the non-headless browser.',
      inputSchema: browserToolInput({
        maxMs: z.number().optional().describe('Maximum wait time in milliseconds. Defaults to MANUAL_VERIFICATION_TIMEOUT_MS or 180000.'),
      }),
      execute: (input) => record('waitForHumanVerification', input, () => session.waitForManualVerification(input.maxMs)),
    }),
    inspect: tool({
      description: 'Inspect the fast B-chain browser state. action=capture reads the page-local DOM, open shadow roots, and intercepted closed roots without full DOMSnapshot/full-page AX. action=search queries the frozen baseline; with one exact uid, includeAx adds local AX and includeShadow performs bounded local CDP shadow piercing plus local AX while preserving dom-* UIDs. action=httpRequests reads network requests.',
      inputSchema: inspectInput,
      execute: (input) => record('inspect', input, async () => {
        if (input.action === 'httpRequests') return session.getCurrentTabHttpRequests({ ids: input.ids });
        if (input.action === 'search') return session.searchSnapshot(input);
        return referenceOptions?.takeSnapshot
          ? referenceOptions.takeSnapshot({ cursor: input.cursor, mode: input.mode })
          : { ok: false, actual: 'inspect action=capture is unavailable in this runtime.' };
      }),
    }),
    file: tool({
      description: 'Manage saved files. action=download saves a URL or page-relative path as an artifact. action=writeMarkdown creates a Markdown artifact. Return saved-file links in the final answer.',
      inputSchema: browserToolInput({
        action: z.enum(['download', 'writeMarkdown']).describe('download saves a remote file; writeMarkdown creates a Markdown file.'),
        url: z.string().optional().describe('For action=download, an absolute URL. path or urlOrPath may be used instead.'),
        path: z.string().optional().describe('For action=download, an origin-relative or page-relative path.'),
        urlOrPath: z.string().optional().describe('For action=download, an absolute URL, origin-relative path, or page-relative path.'),
        fileName: z.string().optional().describe('Optional saved file name.'),
        title: z.string().optional().describe('For action=writeMarkdown, fallback file name.'),
        content: z.string().optional().describe('For action=writeMarkdown, complete Markdown document content.'),
      }).superRefine((input, context) => {
        if (input.action === 'download' && !input.url && !input.path && !input.urlOrPath) context.addIssue({ code: z.ZodIssueCode.custom, message: 'action=download requires url, path, or urlOrPath.' });
        if (input.action === 'writeMarkdown' && !input.content?.trim()) context.addIssue({ code: z.ZodIssueCode.custom, message: 'action=writeMarkdown requires content.' });
      }),
      execute: (input) => record('file', input, () => input.action === 'download'
        ? downloadFileArtifact({ ...input, runId: referenceOptions?.runId, sourcePageUrl: session.currentUrl() })
        : generateMarkdownArtifact({ ...input, runId: referenceOptions?.runId })),
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

// 构造完成判定规则；视觉模式用截图作证据，DOM 模式用文本化页面上下文作证据。
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

function completionVerifyEnabled() {
  const raw = process.env.AI_COMPLETION_VERIFY ?? 'true';
  return raw.toLowerCase() !== 'false';
}

/** Fix contradictory model output before branching on done/status. */
function normalizeRuntimeDecision(decision: RuntimeDecision): RuntimeDecision {
  if (decision.status === 'blocked') {
    if (decision.done) return { ...decision, done: false };
    return decision;
  }
  if (decision.done && decision.status !== 'passed' && decision.status !== 'failed') {
    return { ...decision, done: false };
  }
  return decision;
}

type CompletionVerification = {
  verified: boolean;
  status: 'passed' | 'failed' | 'blocked';
  summary: string;
  remainingWork: string;
};

// 当执行器声称完成时，用独立校验请求再判断一次，减少“只完成一半就结束”的误判。
async function verifyRuntimeCompletion(input: {
  testCase: TestCaseRecord;
  screenshotPath: string;
  proposed: RuntimeDecision;
  completedSteps: StepExecutionResult[];
  pageContext: Awaited<ReturnType<BrowserSession['getPageContext']>>;
  abortSignal?: AbortSignal;
}): Promise<CompletionVerification> {
  const { testCase, screenshotPath, proposed, completedSteps, pageContext, abortSignal } = input;
  const requirement = requirementOf(testCase);
  const attachScreenshot = false;
  const prompt = buildCompletionVerificationPrompt({
    requirement,
    attachScreenshot,
    proposedClaim: { action: proposed.action, expected: proposed.expected, actual: proposed.actual, status: proposed.status },
    currentUrl: pageContext.url,
    manualVerification: pageContext.manualVerification ?? null,
    recentProgressNotes: recentProgressNotes(completedSteps, 5),
  });

  const screenshot = attachScreenshot ? await readScreenshotForAi(screenshotPath) : undefined;
  const messageContent: Array<{ type: 'text'; text: string } | { type: 'image'; image: Buffer }> = [
    {
      type: 'text',
      text: attachScreenshot
        ? prompt
        : `${prompt}\n\nScreenshot image input is disabled for this request.`,
    },
  ];
  if (screenshot) messageContent.push({ type: 'image', image: screenshot });

  const result = await generateTextWithTimeout({
    model: getModel(),
    messages: [{ role: 'user', content: messageContent }],
    abortSignal,
  });

  try {
    const parsed = z
      .object({
        verified: z.boolean(),
        status: z.enum(['passed', 'failed', 'blocked']),
        summary: z.string().min(1),
        remainingWork: z.string(),
      })
      .parse(extractJson(result.text));
    return parsed;
  } catch {
    return {
      verified: false,
      status: 'passed',
      summary: 'Completion verification response could not be parsed; continue execution.',
      remainingWork: 'Continue from the latest screenshot until every requirement clause is satisfied.',
    };
  }
}

// 根据当前模式生成验证码/安全校验规则；DOM 模式不要要求 AI 读取截图。

function runtimePrompt(input: {
  testCase: TestCaseRecord;
  currentUrl: string;
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
  const { testCase, currentUrl, completedSteps } = input;
  const targetHost = hostOf(testCase.targetUrl) || '[unknown target host]';
  const visualMode = false;
  const attachScreenshot = false;
  void input.markerOverlayInScreenshot;
  void input.hasMarkerScreenshot;
  const caseSystemPrompt = systemPromptOf(testCase);
  const requirement = requirementOf(testCase);
  const browserChatMode = isBrowserChatTestCase(testCase);
  const compactRunContext = buildCompactRunContext(completedSteps, input.workingMemory);
  const customPrompt = customRuntimePromptFromEnv();
  const availableScreenshotReferences = input.availableScreenshotReferences || [];
  const selectedScreenshotReferences = input.selectedScreenshotReferences || [];
  const strategyMemory = (testCase.strategyMemory || [])
    .filter((hint) => !isInfrastructureNoise(hint))
    .map((hint) => concise(hint, 220))
    .slice(-4);
  const screenshotAvailable = modelSupportsScreenshotInput();
  const evidence = screenshotAvailable
    ? 'the latest semantic DOM snapshot across all attached frames plus an optional latest viewport screenshot'
    : 'the latest semantic DOM snapshot across all attached frames';
  const markerTargetRules: string[] = [];
  const modeActionRules = browserActionRules(screenshotAvailable);
  return [
    browserChatMode
      ? 'You are an AI browser chat agent. Call a browser tool only when live browser action or inspection is needed; otherwise answer directly in Chinese Markdown.'
      : 'You are an AI browser testing agent. Call exactly ONE tool. Use reportState only when no browser action is needed.',
    `Requirement: ${requirement}`,
    `Target URL: ${testCase.targetUrl}`,
    `Target host: ${targetHost}`,
    `Current URL: ${currentUrl}`,
    '',
    'Hard rules:',
    browserChatMode
      ? '- Browser chat may either answer with Chinese Markdown and no tool, or call at most one browser tool when action/inspection is needed.'
      : '- One tool only. You may include a short ordinary Chinese progress sentence alongside the tool call.',
    browserChatMode
      ? '- Keep browser action tool params minimal: reason, exact tool arguments, and optional visualAfter. If no browser action is needed, answer directly in Markdown without calling a tool.'
      : '- Keep tool params minimal: reason, exact tool arguments, and optional visualAfter. Do not add separate state summaries, memory notes, finding lists, task frames, or ledger JSON.',
    '- Treat RunState JSON and Working Memory as compact context only. Do not copy them into tool params.',
    '- Historical actions are semantic summaries only. Do not reuse historical candidate ids, area ids, coordinates, deltas, screenshot ids, or old tool input JSON.',
    '- In reason/message/action/expected/actual, do not output candidate ids as business meaning, area ids, coordinates, deltas, screenshot file ids, or tool input JSON.',
    '- When a candidate is marked external-app=<protocol>, clicking it is an external application launch attempt. The browser page may remain unchanged, and native app launch success is not server-verifiable.',
    '- If ledgerDigest already covers a requirement area, do not restart that area by habit; continue only with missing or contradicted work.',
    '- This is a testing workflow, not a generic browser assistant. In every step, actively look for product defects, requirement mismatches, broken navigation, unexpected page states, visible loading stalls, validation problems, and reliability risks.',
    '- When a problem is observed or strongly indicated by tool/page feedback, describe it in ordinary assistant text or reportState actual; do not create extra structured memory fields.',
    '- If the page looks broken, data is missing, a request may have failed, or an issue may be caused by an API/static-resource failure, call inspect with action="httpRequests" before finalizing that issue when possible.',
    '- If the user asks to download/save a file, use file with action="download". It accepts an absolute URL, an origin-relative path like /files/a.pdf, or a page-relative path like report/a.pdf resolved against the current page URL. When a usable link is already known, pass it directly to the file tool; do not call inspect action="httpRequests" merely to read or rediscover downloadable content.',
    '- If the user asks to generate/export/save a Markdown file, use file with action="writeMarkdown" and the complete Markdown content. In the final answer, include the returned Markdown download link exactly as a clickable Markdown link.',
    ...snapshotHardRules(screenshotAvailable),
    input.repairContext ? `Replay repair mode:\n${input.repairContext}` : '',
    visualMode
      ? '- Candidate action reason must describe the visible text/icon/position/role from the CURRENT screenshot before choosing id.'
      : screenshotAvailable
        ? '- Browser action reason must cite the current snapshot UID or latest screenshot target.'
        : '- Browser action reason must cite a fresh UID from the latest semantic DOM snapshot.',
    `- Use ${evidence} as the current page state. When semantic state is stale, call inspect({action:"capture",mode:"full"}).`,
    '- If no progress or target mismatch, choose a different evidence-based path; do not repeat the same visible target by habit.',
    '- If loading/transitioning, call browser with action="wait" once. Block only for manual captcha/OTP/security/user input.',
    ...modeActionRules,
    '- After a click may open a tab/window, call browser with action="listTabs"; use action="switchTab" if the relevant page is in another tab.',
    '- Block only for empty captcha/OTP/security/manual verification. If captchaAppearsFilled=true, submit/login and continue.',
    '- If the current page requires user-side captcha/OTP/security/manual verification, call waitForHumanVerification. It pauses the run for user intervention and no further AI tool should be requested from that screenshot.',
    browserChatMode
      ? '- Finish the chat turn by returning normal Chinese Markdown text with no tool call once the latest user message is satisfied, blocked, or needs clarification.'
      : '- Finish only when EVERY requirement clause is satisfied; use reportState with done=true/status=passed. Otherwise call one more useful browser tool or reportState with done=false when only reporting status.',
    screenshotObservationRule(screenshotAvailable),
    ...markerTargetRules,
    caseSystemPrompt ? `Test-case-specific instructions:
${caseSystemPrompt}` : '',
    customPrompt,
    strategyMemory.length ? `Historical failure strategy memory:
${strategyMemory.map((hint, index) => `${index + 1}. ${hint}`).join('\n')}` : '',
    '',
    ...buildCompletionPromptLines(attachScreenshot),
    '',
    'Response:',
    browserChatMode
      ? '- Either return normal Chinese Markdown text with no tool, or call one browser tool if action/inspection is needed. Tool params are only for the selected tool.'
      : '- Call one tool. Use ordinary assistant text for progress/explanation, and tool params only for the selected tool.',
    browserChatMode ? '- Browser chat: when the user can be answered from current evidence, output normal Chinese Markdown text and call no tool.' : '',
    visualMode
      ? '- Candidate action reason must mention the current-screenshot visual feature, not just an id.'
      : screenshotAvailable
        ? '- Browser action reason must mention the current UID or latest screenshot target.'
        : '- Browser action reason must mention the current snapshot UID.',
    browserChatMode
      ? '- To finish/block/fail/clarify in browser chat, return normal Chinese Markdown text with no tool call. Do not return JSON.'
      : '- To finish/block/fail or only report status, call reportState. Do not return standalone JSON.',
    '- When a file tool succeeds, mention the saved file name and include its returned download target as a clickable Markdown link.',
    '',
    'Current context:',
    currentSnapshotContextLine(browserChatMode),
    compactRunContext,
    availableScreenshotReferences.length ? `Available previous screenshot references:
${formatScreenshotReferences(availableScreenshotReferences)}` : '',
    selectedScreenshotReferences.length ? `Selected reference screenshots:
${formatScreenshotReferences(selectedScreenshotReferences)}` : '',
    selectedScreenshotReferences.length
      ? 'Reference screenshot rule: selected reference images help connect scroll continuity or compare earlier page state. They may show the same interface at different scroll offsets when sameInterfaceGroup matches, but their candidate ids are historical and must never be used for the current action.'
      : '',
    screenshotAvailable
      ? 'Screenshot image/path is not attached automatically. takeScreenshot attaches explicit visual evidence to the next model request when available.'
      : '',
  ].filter(Boolean).join('\n');
}

function runtimeToolNames(mode: BrowserSessionMode) {
  void mode;
  return [
    ...(modelSupportsScreenshotInput() ? ['takeScreenshot'] : []),
    'browser',
    'waitForHumanVerification',
    'inspect',
    'file',
    'interact',
    'reportState',
  ];
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

function binaryLogDescriptor(value: unknown, imagePath?: string) {
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

function aiRequestLogDetails(aiRequest: AiRequestSnapshot | undefined, extra: Record<string, unknown> = {}, modelMessages?: unknown) {
  const messages = modelMessages || aiRequest?.messages || [];
  return jsonSafe({
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
  return jsonSafe({
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

function deriveDecision(text: string, traces: ToolTrace[], goal = ''): RuntimeDecision {
  // When a tool actually executed this step, the step result is derived from the action itself. We
  // never trust JSON done/status in the same response as a tool call, so the model cannot accidentally
  // declare the requirement complete before seeing the next screenshot.
  if (traces.length > 0) {
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
          || 'AI reported current state',
        expected: typeof input.expected === 'string' ? input.expected : 'AI should report progress or conclusion based on current page state.',
        actual: typeof input.actual === 'string' ? input.actual : last.result.actual,
        status,
        done: typeof input.done === 'boolean' ? input.done : status === 'failed',
        note,
        ...assistantInfo,
      };
    }

    if (last?.name === 'waitForHumanVerification') {
      return {
        action: readableActionFromTrace(last) || toolReason || '等待人工完成验证',
        expected: '用户在可见浏览器中完成验证码、登录验证或安全校验后，回到运行报告点击“执行完毕”。',
        actual: `AI 已请求人工介入：${last.result?.actual || '请在浏览器中完成验证后继续。'}`,
        status: 'blocked',
        done: false,
        note,
        ...assistantInfo,
      };
    }

    return {
      action: note || readableActionFromTrace(last) || toolReason || `AI executed browser action: ${names || last?.name || 'browser action'}`,
      expected: 'This action should advance the user requirement; the next screenshot will verify the result.',
      actual: last ? userFacingToolResult(last.name, last.result, 500, last.input) || 'Tool call finished; waiting for next screenshot to confirm effect.' : 'Tool call finished; waiting for next screenshot to confirm effect.',
      status: failed ? 'failed' : 'passed',
      done: false,
      note,
      ...assistantInfo,
    };
  }

  return {
        action: 'AI did not call a tool',
        expected: 'Every AI response must call exactly one tool; pure description, completion, block, and failure must use reportState.',
        actual: text || 'AI did not call any tool.',
    status: 'failed',
    done: false,
  };
}

// 执行单个运行时步骤：采集页面上下文，调用 AI 选择一个动作，并记录请求快照。
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
  completedSteps: StepExecutionResult[];
  runtimeMessageState?: RuntimeRetryState;
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
  onDebug?: ExecutionDebug;
  onToolTrace?: (trace: ToolTrace, progress?: ToolTraceProgress) => void | Promise<void>;
  repairContext?: string;
}) {
  const {
    session,
    testCase,
    stepIndex,
    beforeScreenshotPath,
    completedSteps,
    runtimeMessageState,
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
  const markerOverlayInScreenshot = false;
  const markerScreenshotPath = undefined;
  const originalScreenshotPath = session.getLastOriginalScreenshotPath();
  await onDebug?.({
    phase: 'ai:runtime-input:start',
    stepIndex,
    message: `Preparing runtime input for ${mode} mode.`,
    details: { browserMode: mode, screenshotInputEnabled, markerEnabled },
  });
  const contextStartedAt = Date.now();
  const currentUrl = session.currentUrl();
  const contextMs = elapsedSince(contextStartedAt);
  const screenshotReadStartedAt = Date.now();
  const screenshot = undefined;
  const markerScreenshot = undefined;
  const userReferenceImagePaths = Array.from(new Set(referenceImagePaths.filter(Boolean))).slice(0, 4);
  const userReferenceImages = modelSupportsScreenshotInput()
    ? await Promise.all(userReferenceImagePaths.map(async (imagePath) => ({
        imagePath,
        image: await readScreenshotForAi(imagePath).catch(() => undefined),
      })))
    : [];
  let runtimeSelectedScreenshotReferences = [...selectedScreenshotReferences];
  const loadSelectedReferenceScreenshots = async () => modelSupportsScreenshotInput()
    ? Promise.all(runtimeSelectedScreenshotReferences.map(async (ref) => ({
        ref,
        image: await readScreenshotForAi(ref.path).catch(() => undefined),
      })))
    : [];
  let runtimeSelectedReferenceScreenshots = await loadSelectedReferenceScreenshots();
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
    currentUrl,
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
    const retryAgentStepOffset = retryState?.agentStepOffset ?? runtimeMessageState?.agentStepOffset ?? 0;
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
        ? 'No page snapshot is preloaded; call inspect({action:"capture",mode:"full"}) when browser evidence is needed.'
        : 'No page snapshot is preloaded; call inspect({action:"capture",mode:"full"}) before choosing a UID action.',
      scrollSummary: '',
      userConstraints: systemPromptOf(testCase) ? [systemPromptOf(testCase)] : [],
      nextStep: browserChatMode
        ? 'Satisfy the latest user message; do not use a tool when a Markdown answer is already supported by evidence.'
        : 'Use the latest complete inspect action=capture view for the next missing goal; scroll only when content is lazy-loaded or virtualized.',
      taskFrame: testCase.content.taskFrame,
    };
    let latestText = '';
    const initialVisualPaths: string[] = [];
    const initialSelectedReferenceImagePaths = browserChatMode ? [] : runtimeSelectedReferenceScreenshots.filter((item) => item.image).map((item) => item.ref.path);
    const initialUserReferenceImagePaths = userReferenceImages.filter((item) => item.image).map((item) => item.imagePath);
    type RuntimeModelMessage = ModelMessage;
    type PendingObservationMessage = {
      text: string;
      imagePaths: string[];
    };
    const pendingObservationMessages: PendingObservationMessage[] = [];
    const initialImagePaths = [...initialVisualPaths, ...initialSelectedReferenceImagePaths, ...initialUserReferenceImagePaths];
    const initialContent: Array<{ type: 'text'; text: string } | { type: 'image'; image: Buffer }> = [{ type: 'text', text: browserChatMode ? requirementOf(testCase) : requestPrompt }];
    for (const imagePath of initialImagePaths) {
      const image = await readScreenshotForAi(imagePath).catch(() => undefined);
      if (image) initialContent.push({ type: 'image', image });
    }
    let initialMessages = runtimeMessageState?.messages.length
      ? [...runtimeMessageState.messages]
      : [{ role: 'user' as const, content: initialContent }] as RuntimeModelMessage[];
    if (retryState?.messages.length) {
      initialMessages = [...retryState.messages];
    }
    let messageImagePaths = retryState?.messages.length
      ? [...retryState.imagePaths]
      : [...(runtimeMessageState?.imagePaths || []), ...initialImagePaths];
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
    let compactedModelContext: RuntimeModelMessage[] | undefined;
    let compactedSourceMessageCount = 0;

    function messagesAddedAfterCompactedContext(sourceMessages: RuntimeModelMessage[]) {
      if (!compactedModelContext?.length) return sourceMessages;
      const markerIndex = sourceMessages.findIndex((message) => (
        typeof message.content === 'string' && message.content.startsWith(continuationSummaryMarker)
      ));
      if (markerIndex >= 0) {
        return sourceMessages.slice(markerIndex + Math.min(
          compactedModelContext.length,
          sourceMessages.length - markerIndex,
        ));
      }
      return sourceMessages.slice(Math.min(compactedSourceMessageCount, sourceMessages.length));
    }

    async function takeSnapshot(options: RuntimeObservationReadOptions = {}): Promise<BrowserActionResult> {
      const snapshotView = options.mode === 'text' || options.mode === 'changes' ? options.mode : 'full';

      const readStartedAt = Date.now();
      const snapshot = await session.readDomObservationSnapshot({
        cursor: options.cursor,
        mode: options.cursor ? options.mode : snapshotView,
      });
      const snapshotActual = [
        snapshot.pageSummary,
        snapshot.content,
        snapshot.nextCursor ? `More pages remain. Continue with inspect({action:"capture",mode:"${snapshot.mode}",cursor:"${snapshot.nextCursor}"}).` : 'End of this snapshot.',
      ].join('\n');
      if (options.cursor || snapshotView === 'changes') return { ok: true, actual: snapshotActual, nextCursor: snapshot.nextCursor };
      const observationViews: BrowserSnapshotViews = {
        defaultType: snapshotView,
        [snapshotView]: snapshot.content,
      };
      const observation = storeRuntimeObservation(observationStore, input.runId, 'inspect', snapshot.content, observationViews);
      if (!observation) {
        return { ok: false, actual: 'Unable to store the current semantic DOM snapshot. Capture it again.' };
      }
      await onDebug?.({
        phase: 'browser:take-snapshot:dom-timings',
        stepIndex,
        message: `DOM-observation takeSnapshot timings: total=${elapsedSince(readStartedAt)}ms, runtime=${snapshot.timings.readDomObservationMs || 0}ms.`,
        details: { snapshot, totalMs: elapsedSince(readStartedAt) },
      });
      return {
        ok: true,
        actual: snapshotActual,
        nextCursor: snapshot.nextCursor,
      };
    }

    async function observeCurrentScreenshot(options: { capture?: ScreenshotCaptureMode; markers?: boolean } = {}): Promise<BrowserActionResult> {
      if (!modelSupportsScreenshotInput()) {
        return { ok: false, actual: 'takeScreenshot is unavailable because the configured model does not support image input.' };
      }
      pageStateObservationIndex += 1;
      const capture = options.capture === 'fullPage' ? 'fullPage' : 'viewport';
      const visualIndex = traces.length + pageStateObservationIndex + 1;
      const markers = options.markers === true && capture === 'viewport';
      const screenshotPath = await session.takeCurrentScreenshotOnly(input.runId, stepIndex, `visual-${visualIndex}`, { capture, markers });
      const observationText = [
        'Current screenshot observation:',
        `- ${capture} screenshot captured and attached to the next model request.`,
        markers ? '- Visible marker labels are current dom-* UIDs and can be passed directly to mouse/keyboard.' : '',
        capture === 'viewport'
          ? '- This is now the only screenshot whose thousandth coordinates may be used by interact.'
          : '- Full-page screenshots are read-only and cannot be targeted with viewport coordinates.',
        `Image: ${basenameOfPath(screenshotPath)}`,
      ].filter(Boolean).join('\n');
      pendingObservationMessages.push({
        text: `[WebPilot explicit screenshot observation]\n${observationText}`,
        imagePaths: [screenshotPath],
      });
      return {
        ok: true,
        actual: `${observationText}\n\n[The screenshot image will be attached to the next model request.]`,
      };
    }

    const summarizeContinuation = async (modelMessagesForLog: unknown, turnIndex: number, messageStats: ReturnType<typeof modelMessagesTextAndImageStats>, thresholdTokens: number) => {
      try {
        const result = await generateTextWithTimeout({
          model: getModel(),
          messages: [{
            role: 'user' as const,
            content: buildContinuationSummaryPrompt({
              goal: requirementOf(testCase),
              browserMode: mode,
              stepIndex,
              agentStep: retryAgentStepOffset + turnIndex + 1,
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
        return (result.text || '').trim() || fallbackContinuationSummary({
          goal: requirementOf(testCase),
          browserMode: mode,
          stepIndex,
          agentStep: retryAgentStepOffset + turnIndex + 1,
          traces,
          workingMemory,
        });
      } catch (error) {
        if (abortSignal?.aborted) throw error;
        return fallbackContinuationSummary({
          goal: requirementOf(testCase),
          browserMode: mode,
          stepIndex,
          agentStep: retryAgentStepOffset + turnIndex + 1,
          traces,
          workingMemory,
        });
      }
    };

    async function prepareStep(turnIndex: number, previousMessages?: RuntimeModelMessage[]) {
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
      messagesToSend = compactStaleSnapshotMessages(messagesToSend);

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
            : [{ role: 'user' as const, content: 'Continue from the continuation summary. Treat completed, confirmedFacts, negativeResults, and failedAttempts as durable facts: do not repeat a completed or known-empty search unless the user changed the query or fresh evidence contradicts it. If fresh page state is needed before acting, call inspect({action:"capture",mode:"full"}).' }]),
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
        observationStore,
      });
      aiRequest = createAiRequestSnapshot({ kind: 'runtime', stepIndex, prompt: '[modelMessages logged separately]', systemPrompt: requestSystemPrompt, screenshotPath: undefined, imagePaths: attachedImagePaths, imageAttached: attachedImagePaths.length > 0, tools: allowedToolTypes, options: { agentLoop: true, agentStepIndex, visualContext: visualContext.snapshot(), workingMemory, imageCount: attachedImagePaths.length, observationCount: runtimeObservationCount(observationStore, input.runId), explicitPageState: true, screenshotToolEnabled: modelSupportsScreenshotInput(), modelContextStats: { ...finalStats, windowTokens, thresholdRatio, thresholdTokens }, modelContextSegmentation } });
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
      await onDebug?.({
        phase: 'ai:runtime:request',
        stepIndex,
        message: 'AI request started; waiting for browser action decision.',
        details: aiRequestLogDetails(aiRequest, { provider: getModelSettings().provider, model: getModelSettings().model, codexObjectMode: true }, modelMessagesForLog),
      });
      const result = await generateTextWithTimeout({ model: getModel(), system, messages, temperature: 0.1, maxRetries: 0, abortSignal });
      const aiElapsedMs = elapsedSince(aiStartedAt);
      const object = codexRuntimeObjectFromText(result.text);
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
        onVisualContextChange: async (snapshot) => { await onDebug?.({ phase: 'ai:visual-context', stepIndex, message: 'Visual Context Manager updated.', details: snapshot }); },
        onToolTrace: async (trace) => {
          workingMemory = updateWorkingMemoryFromTrace(workingMemory, trace, stepIndex);
          await onToolTrace?.(trace, { workingMemory, visualContext: visualContext.snapshot() });
          await onDebug?.({ phase: 'ai:tool', stepIndex, message: trace.name + (trace.result ? ' -> ' + (trace.result.ok ? 'ok' : 'failed') : ' started'), details: { trace, visualContext: visualContext.snapshot(), workingMemory } });
        },
        observeCurrentScreenshot,
        takeSnapshot,
      });
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
        runtimeMessageState: appendRuntimeResponseMessages(lastRetryState, responseMessagesFromGenerateTextResult(result)),
        endedWithText: browserChatMode && !execution.executed && Boolean(execution.text.trim()),
      };
    }

    const stopWhen = [hasToolCall('reportState'), hasToolCall('waitForHumanVerification')];
    nativeToolsRef.current = makeBrowserTools(session, testCase.targetUrl, mode, traces, aiRequest, async (trace) => {
      workingMemory = updateWorkingMemoryFromTrace(workingMemory, trace, stepIndex);
      await onToolTrace?.(trace, { workingMemory, visualContext: visualContext.snapshot() });
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
      observeCurrentScreenshot,
      takeSnapshot,
      onVisualContextChange: async (snapshot) => {
        await onDebug?.({ phase: 'ai:visual-context', stepIndex, message: 'Visual Context Manager updated.', details: snapshot });
      },
      onSelectReferenceScreenshots: async (selection) => {
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
          const prepared = await prepareStep(stepNumber, messages as RuntimeModelMessage[]);
          stepModelMessagesForLog.set(stepNumber, prepared.modelMessagesForLog);
          toolExecutionGate.stepNumber = stepNumber;
          toolExecutionGate.executed = false;
          stepTraceStarts.set(stepNumber, traces.length);
          stepStartedAt.set(stepNumber, Date.now());
          await onDebug?.({
            phase: 'ai:runtime:request',
            stepIndex,
            message: 'AI request started; waiting for browser action decision. agent step ' + agentStepLabel(retryAgentStepOffset + stepNumber) + '.',
            details: aiRequestLogDetails(aiRequest, { provider: getModelSettings().provider, model: getModelSettings().model, agentStepIndex: retryAgentStepOffset + stepNumber + 1, nativeToolLoop: true }, prepared.modelMessagesForLog),
          });
          return { system: prepared.system, messages: prepared.messages };
        },
        onStepFinish: async (event) => {
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
      latestText = result.text || latestText;
      return {
        text: latestText,
        traces,
        aiRequest,
        visualContext: visualContext.snapshot(),
        workingMemory,
        runtimeMessageState: appendRuntimeResponseMessages(lastRetryState, responseMessagesFromGenerateTextResult(result)),
        endedWithText: browserChatMode && Boolean(latestText.trim()) && traces.at(-1)?.name !== 'waitForHumanVerification',
      };
    } catch (error) {
      if (traces.length && !abortSignal?.aborted) {
        await onDebug?.({
          phase: 'ai:runtime:partial',
          stepIndex,
          message: 'AI request stopped after a tool executed; keeping the action and returning the partial native tool-loop state.',
          details: { error: error instanceof Error ? error.message : String(error), traces, visualContext: visualContext.snapshot() },
        });
        return {
          text: latestText,
          traces,
          aiRequest,
          visualContext: visualContext.snapshot(),
          workingMemory,
          runtimeMessageState: cloneRuntimeMessageState(lastRetryState),
          endedWithText: false,
        };
      }
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
      if (abortSignal?.aborted) throw error;
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

function manualVerificationMaxPromptsPerStep() {
  const raw = Number(process.env.AI_MANUAL_VERIFICATION_MAX_PROMPTS_PER_STEP || 3);
  return Math.max(1, Math.floor(Number.isFinite(raw) ? raw : 3));
}

function manualResumeCount(counts: Map<number, number>, stepIndex: number) {
  return counts.get(stepIndex) || 0;
}

function markManualResumed(counts: Map<number, number>, stepIndex: number) {
  counts.set(stepIndex, manualResumeCount(counts, stepIndex) + 1);
}

function canPromptManualVerification(counts: Map<number, number>, stepIndex: number, maxPrompts: number) {
  return manualResumeCount(counts, stepIndex) < maxPrompts;
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

function firstErrorNumber(error: unknown, key: string) {
  for (const source of errorRecordSources(error)) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function errorDetailText(error: unknown) {
  const exitCode = firstErrorNumber(error, 'exitCode');
  const code = firstErrorString(error, 'code');
  const stderr = firstErrorString(error, 'stderr');
  const promptExcerpt = firstErrorString(error, 'promptExcerpt');
  return [
    typeof exitCode === 'number' ? `exitCode=${exitCode}` : '',
    code ? `code=${code}` : '',
    stderr ? `stderr=${trimDebugText(stderr, 1200)}` : '',
    promptExcerpt ? `promptExcerpt=${trimDebugText(promptExcerpt, 600)}` : '',
  ].filter(Boolean).join('\n');
}

function infrastructureError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || 'Unknown execution error');
  const details = errorDetailText(error);
  return details ? `${message}\n${details}` : message;
}

function serializeError(error: unknown) {
  if (!(error instanceof Error)) return { message: String(error) };
  return {
    name: error.name,
    message: error.message,
    exitCode: firstErrorNumber(error, 'exitCode'),
    code: firstErrorString(error, 'code'),
    stderr: firstErrorString(error, 'stderr'),
    promptExcerpt: firstErrorString(error, 'promptExcerpt'),
    stack: error.stack,
  };
}

function shouldKeepBrowserOpenAfterError() {
  if (process.env.KEEP_BROWSER_OPEN_ON_AI_ERROR === 'false') return false;
  return true;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSkippedStep(stepIndex: number, beforeScreenshotPath?: string, afterScreenshotPath?: string): StepExecutionResult {
  return {
    index: stepIndex,
    action: '用户跳过当前 AI 运行步骤',
    expected: 'After this skipped step, continue to the next AI decision.',
    actual: 'User skipped this step manually.',
    status: 'blocked',
    beforeScreenshotPath,
    afterScreenshotPath,
    screenshotPath: afterScreenshotPath,
  };
}

async function createRecoverableRuntimeErrorStep(input: {
  session: BrowserSession;
  runId: string;
  stepIndex: number;
  beforeScreenshotPath?: string;
  error: unknown;
  tools?: StepToolCall[];
  aiRequest?: AiRequestSnapshot;
  recoveredState?: Partial<StepExecutionResult>;
}): Promise<StepExecutionResult> {
  const { session, runId, stepIndex, beforeScreenshotPath, error, tools, aiRequest, recoveredState } = input;
  const afterScreenshotPath = await session.takeScreenshot(runId, stepIndex, 'after').catch(() => undefined);

  return {
    index: stepIndex,
        action: 'AI request or response handling failed; continuing automatically',
        expected: 'A single AI request/tool/parse failure should not stop the flow; the next round will continue from the latest screenshot.',
    actual: `${infrastructureError(error)}. Recorded as recoverable; flow will continue unless real verification, completion, or impossibility is detected.`,
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

function normalizeBrowserUrl(url: string) {
  const trimmed = url.trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /^(about|data|file|blob):/i.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(trimmed)) return `http://${trimmed}`;
  return `https://${trimmed}`;
}

function recordedStepDelayMs(flow: RecordedFlowStep, isFirstStep: boolean) {
  if (typeof flow.delayBeforeMs === 'number' && Number.isFinite(flow.delayBeforeMs)) {
    return Math.max(0, Math.floor(flow.delayBeforeMs));
  }
  if (isFirstStep) return 0;
  const configuredDelay = Number(process.env.REPLAY_STEP_DELAY_MS || 1500);
  return Math.max(0, Math.floor(Number.isFinite(configuredDelay) ? configuredDelay : 1500));
}

async function waitBeforeRecordedTool(session: BrowserSession, flow: RecordedFlowStep, isFirstStep: boolean) {
  const delayMs = recordedStepDelayMs(flow, isFirstStep);
  if (delayMs > 0) await session.wait(delayMs).catch(() => undefined);
}

async function waitAfterRecordedTool(session: BrowserSession) {
  await session.waitForPage().catch(() => undefined);
  const configuredDelay = Number(process.env.REPLAY_AFTER_ACTION_SETTLE_MS || 0);
  const delayMs = Number.isFinite(configuredDelay) ? configuredDelay : 0;
  if (delayMs > 0) await session.wait(delayMs).catch(() => undefined);
}

function replayAiRepairEnabled() {
  return process.env.REPLAY_AI_REPAIR !== 'false';
}

function replayAiRepairMaxSteps() {
  const raw = Number(process.env.REPLAY_AI_REPAIR_MAX_STEPS || 2);
  return Math.max(1, Math.floor(Number.isFinite(raw) ? raw : 2));
}

function recordedTextGenerationLimit(input: Record<string, unknown>) {
  const value = typeof input.maxCharacters === 'number' ? input.maxCharacters : Number(input.maxCharacters || 1200);
  return Math.max(200, Math.min(8000, Math.floor(Number.isFinite(value) ? value : 1200)));
}

function recordedTextGenerationPrompt(input: Record<string, unknown>) {
  return [
    typeof input.prompt === 'string' ? input.prompt : '',
    typeof input.instruction === 'string' ? input.instruction : '',
    typeof input.question === 'string' ? input.question : '',
  ].map((item) => item.trim()).find(Boolean) || '';
}

function recordedTextGenerationContextLines(mode: BrowserSessionMode, pageContext: RuntimePageContext, input: Record<string, unknown>) {
  const includePageText = input.includePageText !== false;
  const lines = [
    'Current browser context:',
    `- Mode: ${mode}`,
    `- URL: ${pageContext.url || '[unknown]'}`,
    `- Title: ${pageContext.title || '[unknown]'}`,
    pageContext.focusedElement ? `- Focused element: ${trimDebugText(JSON.stringify(pageContext.focusedElement), 1200)}` : '',
    pageContext.pageScrollState ? `- Page scroll: ${trimDebugText(JSON.stringify(pageContext.pageScrollState), 1200)}` : '',
    pageContext.scrollableAreas ? `- Scrollable areas: ${trimDebugText(JSON.stringify(pageContext.scrollableAreas), 1800)}` : '',
    includePageText && pageContext.text ? `\nVisible/page text:\n${trimDebugText(pageTextForPrompt(pageContext.text), 6000)}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

async function runRecordedTextGeneration(
  session: BrowserSession,
  mode: BrowserSessionMode,
  flow: RecordedFlowStep,
  options: { currentScreenshotPath?: string },
): Promise<BrowserActionResult> {
  const input = flowInput(flow.input);
  const prompt = recordedTextGenerationPrompt(input);
  if (!prompt) {
    return { ok: false, actual: 'generateText failed: prompt is required.' };
  }

  const includeScreenshot = input.includeScreenshot !== false;
  const outputFormat = typeof input.outputFormat === 'string' ? input.outputFormat : 'markdown';
  const maxCharacters = recordedTextGenerationLimit(input);
  const pageContext = await session.getPageContext({
    domScope: 'full',
    includeDomTree: false,
    includeText: input.includePageText !== false,
    includeManualVerification: true,
    includeInteractiveCandidates: false,
    textMaxChars: 6000,
    useCachedInteractiveCandidates: false,
  });
  const content: Array<{ type: 'text'; text: string } | { type: 'image'; image: Buffer }> = [{
    type: 'text',
    text: [
      'You are generating text for a manually edited web test replay tool.',
      'Use only the current browser context and the user prompt. Do not invent page content.',
      `Output format: ${outputFormat}.`,
      `Keep the answer within ${maxCharacters} Chinese characters unless JSON format requires concise keys.`,
      '',
      recordedTextGenerationContextLines(mode, pageContext, input),
      '',
      `User prompt:\n${prompt}`,
    ].join('\n'),
  }];

  if (includeScreenshot && options.currentScreenshotPath && modelSupportsScreenshotInput()) {
    const screenshot = await readScreenshotForAi(options.currentScreenshotPath).catch(() => undefined);
    if (screenshot) content.push({ type: 'image', image: screenshot });
  }

  const result = await generateTextWithTimeout({
    model: getModel(),
    system: 'You are a precise browser UI analysis assistant for replayed web test records.',
    messages: [{ role: 'user', content }],
    temperature: 0.1,
    maxRetries: 0,
  });
  const text = result.text.trim();
  return {
    ok: true,
    actual: text ? trimDebugText(text, maxCharacters) : 'AI 没有返回内容。',
  };
}

async function recordedToolAiRequestSnapshot(input: {
  flow: RecordedFlowStep;
  mode: BrowserSessionMode;
  stepIndex: number;
  screenshotPath?: string;
}) {
  const { flow, mode, stepIndex, screenshotPath } = input;
  return createAiRequestSnapshot({
    kind: 'runtime',
    stepIndex,
    prompt: `Recorded replay context for ${flow.name}.`,
    screenshotPath,
    imageAttached: false,
    tools: [flow.name],
    options: { recordedReplay: true, browserMode: mode },
  });
}

async function runRecordedTool(
  session: BrowserSession,
  targetUrl: string,
  flow: RecordedFlowStep,
  options: { currentScreenshotPath?: string; mode: BrowserSessionMode; runId?: string; stepIndex?: number },
): Promise<BrowserActionResult> {
  const input = flowInput(flow.input);
  const text = typeof input.text === 'string' ? input.text : undefined;
  const reason = flow.reason ? ` Recorded reason: ${flow.reason}` : '';

  switch (flow.name) {
    case 'page':
      if (input.action === 'wait') return typeof input.ms === 'number' ? session.wait(input.ms) : session.waitForPage();
      {
        const rawUrl = typeof input.url === 'string' && input.url.trim() ? input.url : targetUrl;
        const url = normalizeBrowserUrl(rawUrl);
        if (!url) return { ok: false, actual: 'Recorded page open failed because the target URL is empty.' };
        return input.target === 'new' ? session.openInNewTab(url) : session.open(url);
      }
    case 'openPage':
      {
        const rawUrl = typeof input.url === 'string' && input.url.trim() ? input.url : targetUrl;
        const url = normalizeBrowserUrl(rawUrl);
        if (!url) return { ok: false, actual: 'Recorded openPage failed because the target URL is empty.' };
        return session.open(url);
    }
    case 'takeSnapshot': {
      const mode = input.mode === 'full' || input.mode === 'text' || input.mode === 'changes' ? input.mode : undefined;
      const snapshot = await session.readDomObservationSnapshot({
        cursor: typeof input.cursor === 'string' ? input.cursor : undefined,
        mode,
      });
      return {
        ok: true,
        actual: [
          snapshot.pageSummary,
          snapshot.content,
          snapshot.nextCursor ? `More pages remain. Continue with takeSnapshot({mode:\"${snapshot.mode}\",cursor:\"${snapshot.nextCursor}\"}).` : 'End of this snapshot.',
        ].join('\n'),
        nextCursor: snapshot.nextCursor,
      };
    }
    case 'takeScreenshot': {
      const capture = input.capture === 'fullPage' ? 'fullPage' : 'viewport';
      const visualIndex = options.stepIndex ?? flow.index ?? 0;
      const screenshotPath = await session.takeCurrentScreenshotOnly(
        options.runId || 'recorded-flow',
        visualIndex,
        `visual-${visualIndex}`,
        { capture, markers: input.markers === true },
      );
      return { ok: true, actual: `Captured ${capture} screenshot: ${screenshotPath}` };
    }
    case 'searchSnapshot':
      return session.searchSnapshot({
        query: typeof input.query === 'string' ? input.query : undefined,
        tag: typeof input.tag === 'string' ? input.tag : undefined,
        uid: typeof input.uid === 'string' ? input.uid : undefined,
        roles: Array.isArray(input.roles) ? input.roles.filter((role): role is string => typeof role === 'string') : undefined,
        limit: typeof input.limit === 'number' ? input.limit : undefined,
        includeAx: input.includeAx === true,
        includeShadow: input.includeShadow === true,
      });
    case 'interact': {
      const action = typeof input.action === 'string' ? input.action : '';
      const legacyName = ['click', 'move', 'drag', 'scroll', 'scrollIntoView'].includes(action)
        ? 'mouse'
        : ['type', 'press', 'shortcut'].includes(action)
          ? 'keyboard'
          : action === 'selectOption'
            ? 'selectOption'
            : undefined;
      if (!legacyName) return { ok: false, actual: 'interact requires a supported action.' };
      return runRecordedTool(session, targetUrl, { ...flow, name: legacyName }, options);
    }
    case 'mouse':
      return session.mouse({
        action: String(input.action || 'click') as 'click' | 'move' | 'drag' | 'scroll' | 'scrollIntoView',
        uid: typeof input.uid === 'string' ? input.uid : undefined,
        xThousandth: typeof input.x_thousandth === 'number' ? input.x_thousandth : undefined,
        yThousandth: typeof input.y_thousandth === 'number' ? input.y_thousandth : undefined,
        toUid: typeof input.toUid === 'string' ? input.toUid : undefined,
        toXThousandth: typeof input.toX_thousandth === 'number' ? input.toX_thousandth : undefined,
        toYThousandth: typeof input.toY_thousandth === 'number' ? input.toY_thousandth : undefined,
        button: typeof input.button === 'string' ? input.button as 'left' | 'right' | 'middle' : undefined,
        clickCount: typeof input.clickCount === 'number' ? input.clickCount : undefined,
        deltaX: typeof input.deltaX === 'number' ? input.deltaX : undefined,
        deltaY: typeof input.deltaY === 'number' ? input.deltaY : undefined,
      });
    case 'keyboard':
      return session.keyboard({
        action: String(input.action || 'type') as 'type' | 'press' | 'shortcut',
        uid: typeof input.uid === 'string' ? input.uid : undefined,
        xThousandth: typeof input.x_thousandth === 'number' ? input.x_thousandth : undefined,
        yThousandth: typeof input.y_thousandth === 'number' ? input.y_thousandth : undefined,
        text,
        key: typeof input.key === 'string' ? input.key : undefined,
        keys: Array.isArray(input.keys) ? input.keys.filter((key): key is string => typeof key === 'string') : undefined,
        replace: typeof input.replace === 'boolean' ? input.replace : undefined,
        followByEnter: typeof input.followByEnter === 'boolean' ? input.followByEnter : undefined,
      });
    case 'selectOption':
      return session.selectOption({
        uid: typeof input.uid === 'string' ? input.uid : '',
        value: typeof input.value === 'string' ? input.value : undefined,
        label: typeof input.label === 'string' ? input.label : undefined,
      });
    case 'waitForPage':
      return typeof input.ms === 'number' ? session.wait(input.ms) : session.waitForPage();
    case 'waitForHumanVerification':
      return session.waitForManualVerification(typeof input.maxMs === 'number' ? input.maxMs : undefined);
    case 'listTabs':
      return session.listTabs();
    case 'tab':
      return input.action === 'switch'
        ? session.switchTab(typeof input.index === 'number' ? input.index : Number(input.index || 0))
        : session.listTabs();
    case 'getHttpRequests':
      return session.getCurrentTabHttpRequests({ ids: Array.isArray(input.ids) ? input.ids.filter((id): id is string => typeof id === 'string') : undefined });
    case 'downloadFile':
      return downloadFileArtifact({
        runId: options.runId,
        url: typeof input.url === 'string' ? input.url : undefined,
        path: typeof input.path === 'string' ? input.path : undefined,
        urlOrPath: typeof input.urlOrPath === 'string' ? input.urlOrPath : undefined,
        sourcePageUrl: session.currentUrl(),
        fileName: typeof input.fileName === 'string' ? input.fileName : undefined,
      });
    case 'generateMarkdownFile':
      return generateMarkdownArtifact({
        runId: options.runId,
        fileName: typeof input.fileName === 'string' ? input.fileName : undefined,
        title: typeof input.title === 'string' ? input.title : undefined,
        content: typeof input.content === 'string' ? input.content : typeof input.text === 'string' ? input.text : undefined,
      });
    case 'generateText':
      return runRecordedTextGeneration(session, options.mode, flow, { currentScreenshotPath: options.currentScreenshotPath });
    case 'switchTab':
      return session.switchTab(typeof input.index === 'number' ? input.index : Number(input.index || 0));
    case 'reportState':
      return { ok: true, actual: `Reported state without browser action: ${String(input.actual || input.reason || '')}` };
    case 'selectReferenceScreenshots':
      return { ok: true, actual: `Selected screenshot references for context only: ${(Array.isArray(input.ids) ? input.ids : []).join(', ') || '[none]'}.` };
    default:
      return { ok: false, actual: `Unsupported recorded tool: ${flow.name}.${reason}` };
  }
}

function recordedToolTraceInput(flow: RecordedFlowStep) {
  const input = jsonSafe(flow.input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return flow.reason ? { value: input, reason: flow.reason } : input;
  }
  const withReason = { ...(input as Record<string, unknown>) };
  if (flow.reason && typeof withReason.reason !== 'string') withReason.reason = flow.reason;
  return withReason;
}

async function runTracedRecordedTool(input: {
  session: BrowserSession;
  targetUrl: string;
  flow: RecordedFlowStep;
  mode: BrowserSessionMode;
  traces: ToolTrace[];
  runId: string;
  stepIndex: number;
  visualContext: VisualContextManager;
  onToolTrace?: (trace: ToolTrace) => void | Promise<void>;
  onVisualContextChange?: (snapshot: ReturnType<VisualContextManager['snapshot']>) => void | Promise<void>;
}) {
  const { session, targetUrl, flow, mode, traces, runId, stepIndex, visualContext, onToolTrace, onVisualContextChange } = input;
  const currentScreenshotPath = visualContext.current()?.path;
  const aiRequest = await recordedToolAiRequestSnapshot({
    flow,
    mode,
    stepIndex,
    screenshotPath: currentScreenshotPath,
  });
  return executeTracedBrowserAction({
    session,
    traces,
    name: flow.name,
    toolInput: recordedToolTraceInput(flow),
    aiRequest,
    runId,
    stepIndex,
    visualContext,
    onToolTrace,
    onVisualContextChange,
    action: () => runRecordedTool(session, targetUrl, flow, {
      currentScreenshotPath,
      mode,
      runId,
      stepIndex,
    }),
  });
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
  onVisualContextChange?: (snapshot: ReturnType<VisualContextManager['snapshot']>) => void | Promise<void>;
  onToolTrace?: (trace: ToolTrace, progress?: ToolTraceProgress) => void | Promise<void>;
  takeSnapshot?: (input?: RuntimeObservationReadOptions) => BrowserActionResult | Promise<BrowserActionResult>;
  observeCurrentScreenshot?: (input?: { capture?: ScreenshotCaptureMode; markers?: boolean }) => BrowserActionResult | Promise<BrowserActionResult>;
}) {
  const { session, targetUrl, runId, stepIndex, mode, type, message, params, allowedTypes, traces, aiRequest, visualContext, onVisualContextChange, onToolTrace, takeSnapshot, observeCurrentScreenshot } = input;
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

  const normalizedParams = { ...params };
  const flow: RecordedFlowStep = {
    index: stepIndex,
    name: type,
    input: normalizedParams,
    reason: typeof normalizedParams.reason === 'string' ? normalizedParams.reason : undefined,
  };
  const runTool = async () => {
    if (type === 'takeScreenshot') {
      return observeCurrentScreenshot
        ? observeCurrentScreenshot({
            capture: normalizedParams.capture === 'fullPage' ? 'fullPage' : 'viewport',
            markers: normalizedParams.markers === true,
          })
        : { ok: false, actual: 'takeScreenshot is unavailable in this runtime.' };
    }
    if (type === 'browser') {
      const action = typeof normalizedParams.action === 'string' ? normalizedParams.action : 'open';
      if (action === 'wait') return typeof normalizedParams.ms === 'number' ? session.wait(normalizedParams.ms) : session.waitForPage();
      if (action === 'listTabs') return session.listTabs();
      if (action === 'switchTab') {
        if (typeof normalizedParams.index !== 'number') return { ok: false, actual: 'browser action=switchTab requires index.' };
        return session.switchTab(normalizedParams.index);
      }
      if (action !== 'open') return { ok: false, actual: 'browser requires action=open, action=wait, action=listTabs, or action=switchTab.' };
      return normalizedParams.target === 'new'
        ? session.openInNewTab(typeof normalizedParams.url === 'string' ? normalizedParams.url : targetUrl)
        : session.open(typeof normalizedParams.url === 'string' ? normalizedParams.url : targetUrl);
    }
    if (type === 'inspect') {
      const action = normalizedParams.action === 'search' || normalizedParams.action === 'httpRequests' ? normalizedParams.action : 'capture';
      if (action === 'httpRequests') {
        return session.getCurrentTabHttpRequests({ ids: Array.isArray(normalizedParams.ids) ? normalizedParams.ids.filter((id): id is string => typeof id === 'string') : undefined });
      }
      if (action === 'search') {
        const query = typeof normalizedParams.query === 'string' ? normalizedParams.query : undefined;
        const tag = typeof normalizedParams.tag === 'string' ? normalizedParams.tag : undefined;
        const uid = typeof normalizedParams.uid === 'string' ? normalizedParams.uid : undefined;
        if (!query && !tag && !uid) return { ok: false, actual: 'inspect action=search requires query, tag, or uid.' };
        if (normalizedParams.includeShadow === true && !uid) return { ok: false, actual: 'inspect action=search includeShadow requires one exact uid.' };
        return session.searchSnapshot({
          query,
          tag,
          uid,
          roles: Array.isArray(normalizedParams.roles) ? normalizedParams.roles.filter((role): role is string => typeof role === 'string') : undefined,
          limit: typeof normalizedParams.limit === 'number' ? normalizedParams.limit : undefined,
          includeAx: normalizedParams.includeAx === true,
          includeShadow: normalizedParams.includeShadow === true,
        });
      }
      return takeSnapshot
        ? takeSnapshot({
          cursor: typeof normalizedParams.cursor === 'string' ? normalizedParams.cursor : undefined,
          mode: normalizedParams.mode === 'text' || normalizedParams.mode === 'changes' ? normalizedParams.mode : 'full',
        })
        : { ok: false, actual: 'inspect action=capture is unavailable in this runtime.' };
    }
    if (type === 'interact') {
      return runRecordedTool(session, targetUrl, {
        index: stepIndex,
        name: 'interact',
        input: normalizedParams,
        reason: typeof normalizedParams.reason === 'string' ? normalizedParams.reason : undefined,
      }, {
        currentScreenshotPath: visualContext?.current()?.path,
        mode,
        runId,
        stepIndex,
      });
    }
    if (type === 'file') {
      if (normalizedParams.action === 'download') {
        return downloadFileArtifact({
          runId,
          url: typeof normalizedParams.url === 'string' ? normalizedParams.url : undefined,
          path: typeof normalizedParams.path === 'string' ? normalizedParams.path : undefined,
          urlOrPath: typeof normalizedParams.urlOrPath === 'string' ? normalizedParams.urlOrPath : undefined,
          sourcePageUrl: session.currentUrl(),
          fileName: typeof normalizedParams.fileName === 'string' ? normalizedParams.fileName : undefined,
        });
      }
      if (normalizedParams.action === 'writeMarkdown') {
        return generateMarkdownArtifact({
          runId,
          fileName: typeof normalizedParams.fileName === 'string' ? normalizedParams.fileName : undefined,
          title: typeof normalizedParams.title === 'string' ? normalizedParams.title : undefined,
          content: typeof normalizedParams.content === 'string' ? normalizedParams.content : undefined,
        });
      }
      return { ok: false, actual: 'file requires action=download or action=writeMarkdown.' };
    }
    return runRecordedTool(session, targetUrl, flow, {
      currentScreenshotPath: visualContext?.current()?.path,
      mode,
      runId,
      stepIndex,
    });
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
    onToolTrace,
    onVisualContextChange,
    action: runTool,
  });
  const fileResult = result.ok ? formatFileArtifactResult(fileArtifactAction(type, normalizedParams), result.actual) : undefined;
  return { text: fileResult || readableActionFromRawText(message) || '', executed: true };
}

async function executeRecordedFlow(testCase: TestCaseRecord, runId: string, recordedFlow: RecordedFlowStep[], options: ExecutionOptions): Promise<TestExecutionResult> {
  const {
    onProgress,
    onDebug,
    shouldSkipStep,
    shouldPauseRun,
    shouldResumeStep,
    onPaused,
    onResumed,
    onManualIntervention,
    onManualInterventionCleared,
  } = options;
  const mode = browserModeOf(testCase);
  const session = new BrowserSession(mode, {
    browserSurface: 'external',
    isMarked: false,
    runId,
  });
  const steps: StepExecutionResult[] = [];
  let selectedScreenshotReferences: SelectedScreenshotReference[] = [];
  const runtimeObservationStore: RuntimeObservationStore = new Map();
  let allowBrowserClose = false;

  async function waitWhilePaused(stepIndex: number) {
    if (!shouldPauseRun) return false;
    let paused = false;
    while (await shouldPauseRun(stepIndex)) {
      if (!paused) {
        paused = true;
        await onPaused?.(stepIndex);
        await onDebug?.({ phase: 'recorded:paused', stepIndex, message: 'Recorded flow paused by user; waiting for resume.' });
      }
      await sleep(800);
    }
    if (paused) {
      await onResumed?.(stepIndex);
      await onDebug?.({ phase: 'recorded:resumed', stepIndex, message: 'Recorded flow resumed.' });
    }
    return paused;
  }

  async function waitForRecordedManualIntervention(input: {
    stepIndex: number;
    reason: string;
    screenshotPath?: string;
    runningStep: StepExecutionResult;
  }) {
    const { stepIndex, reason, screenshotPath, runningStep } = input;
    if (!shouldResumeStep) return false;
    await onManualIntervention?.({ stepIndex, reason, screenshotPath });
    await onDebug?.({
      phase: 'recorded:manual-required',
      stepIndex,
      message: 'Recorded flow is waiting for user-side verification before continuing.',
      details: { reason, screenshotPath },
    });
    await onProgress?.({
      ...runningStep,
      actual: `${reason} 完成后请回到运行报告点击“执行完毕”，回放会从当前浏览器状态继续。`,
    });

    while (true) {
      if (await shouldSkipStep?.(stepIndex)) {
        await onManualInterventionCleared?.(stepIndex);
        return true;
      }
      if (await shouldResumeStep(stepIndex)) break;
      await sleep(800);
    }

    await onManualInterventionCleared?.(stepIndex);
    await onDebug?.({ phase: 'recorded:manual-resumed', stepIndex, message: 'User confirmed manual verification; recorded flow is continuing.' });
    return false;
  }

  async function runAiRepairForRecordedFailure(
    failedRecordedStep: StepExecutionResult,
    flow: RecordedFlowStep,
    repairAttempt = 1,
  ): Promise<{ status: 'passed' | 'failed' | 'blocked'; done: boolean }> {
    const repairStepIndex = steps.length + 1;
    await waitWhilePaused(repairStepIndex);

    if (await shouldSkipStep?.(repairStepIndex)) {
      const skippedStep = createSkippedStep(repairStepIndex, failedRecordedStep.afterScreenshotPath || failedRecordedStep.screenshotPath);
      steps.push(skippedStep);
      await onProgress?.(skippedStep);
      return { status: 'blocked', done: true };
    }

    const beforeScreenshotPath = failedRecordedStep.afterScreenshotPath
      || failedRecordedStep.screenshotPath
      || await session.takeScreenshot(runId, repairStepIndex, 'before');
    const runningStep: StepExecutionResult = {
      index: repairStepIndex,
      action: 'AI 接管修复回放失败操作',
      expected: 'AI 应基于当前页面重新选择可靠操作，修复固定回放中失败或失效的录制动作。',
      actual: `回放步骤 ${failedRecordedStep.index} 的工具 ${flow.name} 执行失败，AI 正在接管修复。`,
      status: 'running',
      beforeScreenshotPath,
    };
    await onProgress?.(runningStep);
    await onDebug?.({
      phase: 'recorded:repair:start',
      stepIndex: repairStepIndex,
      message: `AI repair attempt ${repairAttempt} started after recorded tool ${flow.name} failed.`,
      details: { failedRecordedStep, flow, repairAttempt },
    });

    const abortController = registerStepAbortController(runId, repairStepIndex);
    const liveToolTraces: ToolTrace[] = [];
    let latestToolProgress: ToolTraceProgress | undefined;

    try {
      const flowIndex = recordedFlow.indexOf(flow);
      const nextFlow = flowIndex >= 0 ? recordedFlow[flowIndex + 1] : undefined;
      const repairContext = [
        '- A recorded replay operation just failed. This AI step must automatically repair the current browser state so the remaining recorded replay can continue.',
        '- Perform one concrete corrective browser action from the CURRENT screenshot/context. Do not ask the user unless CAPTCHA/login/security verification is actually required.',
        '- Do not reuse old recorded candidate ids, DOM ids, coordinates, or scroll area ids. Treat them only as historical clues.',
        '- Do not mark the full test complete unless every user requirement is already proven. Prefer restoring the page to a state where the next recorded operation can work.',
        '- When the page is repaired and ready for the remaining replay, call reportState with done=false and status="passed" to say replay can continue. If it is not repaired yet, keep taking corrective tool actions within this agent loop.',
        `- Failed recorded tool: ${flow.name}.`,
        flow.reason ? `- Recorded reason: ${sanitizeHistoricalToolText(flow.reason, 240)}.` : '',
        `- Failure result: ${sanitizeHistoricalToolText(failedRecordedStep.actual, 420)}.`,
        nextFlow ? `- Next recorded tool after repair: ${nextFlow.name}${nextFlow.reason ? ` (${sanitizeHistoricalToolText(nextFlow.reason, 180)})` : ''}.` : '- There is no next recorded tool; repair should finish only if the requirement is proven.',
      ].filter(Boolean).join('\n');
      const actionResult = await executeRuntimeStep({
        session,
        testCase,
        runId,
        stepIndex: repairStepIndex,
        beforeScreenshotPath,
        completedSteps: steps,
        runtimeObservationStore,
        selectedScreenshotReferences,
        onSelectReferenceScreenshots: async (selection) => {
          selectedScreenshotReferences = selection.ids
            .map((id) => selection.availableReferences.find((ref) => ref.id === id))
            .filter((ref): ref is ScreenshotReference => Boolean(ref))
            .map((ref) => ({
              ...ref,
              selectionReason: selection.selectionReason,
              sameInterfaceGroup: selection.sameInterfaceGroup || ref.sameInterfaceGroup,
            }));
          await onDebug?.({
            phase: 'recorded:repair:reference-screenshots:selected',
            stepIndex: repairStepIndex,
            message: selectedScreenshotReferences.length
              ? `Selected reference screenshots for AI repair: ${selectedScreenshotReferences.map((ref) => ref.id).join(', ')}`
              : 'Cleared reference screenshots for AI repair.',
            details: { selection, selectedScreenshotReferences },
          });
        },
        abortSignal: abortController.signal,
        onDebug,
        repairContext,
        onToolTrace: async (trace, progress) => {
          upsertToolTrace(liveToolTraces, trace);
          latestToolProgress = progress || latestToolProgress;
          const liveFields = progressFieldsFromToolTraces(liveToolTraces, requirementOf(testCase), repairStepIndex, latestToolProgress);
          await onProgress?.({
            ...runningStep,
            actual: 'AI 已调用浏览器工具修复回放失败操作，正在等待页面反馈。',
            tools: summarizeToolTraces(liveToolTraces),
            ...liveFields,
          });
        },
      });

      const afterScreenshotPath = await session.takeScreenshot(runId, repairStepIndex, 'after');
      let decision = normalizeRuntimeDecision(deriveDecision(actionResult.text, actionResult.traces, requirementOf(testCase)));

      if (decision.done && completionVerifyEnabled()) {
        const verifyPageContext = await session.getPageContext({
          includeDomTree: false,
          includeText: false,
          includeManualVerification: true,
        });
        const verification = await verifyRuntimeCompletion({
          testCase,
          screenshotPath: afterScreenshotPath || '',
          proposed: decision,
          completedSteps: steps,
          pageContext: verifyPageContext,
          abortSignal: abortController.signal,
        });
        await onDebug?.({
          phase: 'recorded:repair:completion-verify',
          stepIndex: repairStepIndex,
          message: verification.verified
            ? 'AI repair completion verification passed.'
            : `AI repair completion verification failed: ${verification.remainingWork || verification.summary}`,
          details: { verification, proposed: decision },
        });

        if (!verification.verified) {
          const retryInstruction = `[AI 修复完成校验未通过] ${verification.summary}${
            verification.remainingWork ? ` 待继续：${verification.remainingWork}` : ''
          }。`;
          decision = {
            ...decision,
            done: false,
            status: verification.status === 'blocked' ? 'blocked' : 'passed',
            actual: `${decision.actual}\n\n${retryInstruction}`,
            note: retryInstruction,
          };
        } else {
          decision = {
            ...decision,
            done: true,
            status: verification.status,
            actual: verification.summary,
          };
        }
      }

      if (
        decision.status === 'blocked' &&
        !decision.done &&
        manualIssuePattern.test(`${decision.action}\n${decision.expected}\n${decision.actual}`)
      ) {
        const skippedForManual = await waitForRecordedManualIntervention({
          stepIndex: repairStepIndex,
          reason: decision.actual || 'AI 修复过程中检测到验证码、登录验证或安全校验，需要用户手动处理。',
          screenshotPath: afterScreenshotPath,
          runningStep,
        });
        if (skippedForManual) {
          const skippedStep = createSkippedStep(repairStepIndex, beforeScreenshotPath, afterScreenshotPath);
          steps.push(skippedStep);
          await onProgress?.(skippedStep);
          return { status: 'blocked', done: true };
        }

        const manualStep: StepExecutionResult = {
          index: repairStepIndex,
          action: 'AI 修复等待人工校验',
          expected: '人工校验完成前，AI 修复不应继续执行后续操作。',
          actual: '用户已确认人工校验完成，AI 将基于最新页面继续修复回放失败操作。',
          status: 'passed',
          note: decision.note,
          taskFrame: decision.taskFrame || actionResult.workingMemory.taskFrame,
          ledgerItems: mergeLedgerItems(decision.ledgerItems || [], [{
            dimensionId: 'runtime-replay',
            title: 'AI 修复等待人工校验',
            status: 'evidence',
            severity: 'info',
            expected: '人工校验完成前暂停自动化修复。',
            actual: '已等待用户点击“执行完毕”后继续。',
            sourceStep: repairStepIndex,
          }], ledgerMemoryLimit()).map((item) => ({ ...item, sourceStep: item.sourceStep ?? repairStepIndex })),
          aiRequest: actionResult.aiRequest,
          beforeScreenshotPath,
          afterScreenshotPath,
          screenshotPath: afterScreenshotPath,
          tools: summarizeToolTraces(actionResult.traces),
          visualContext: actionResult.visualContext,
          workingMemory: actionResult.workingMemory,
        };
        steps.push(manualStep);
        await onProgress?.(manualStep);
        clearStepAbortController(runId, repairStepIndex);
        if (repairAttempt < replayAiRepairMaxSteps()) {
          return runAiRepairForRecordedFailure(failedRecordedStep, flow, repairAttempt + 1);
        }
        return { status: 'blocked', done: true };
      }

      const completedStep: StepExecutionResult = {
        index: repairStepIndex,
        action: `AI 接管修复：${decision.action}`,
        expected: decision.expected,
        actual: decision.actual,
        status: decision.status,
        note: decision.note,
        taskFrame: decision.taskFrame || actionResult.workingMemory.taskFrame,
        ledgerItems: mergeLedgerItems(decision.ledgerItems || [], actionResult.workingMemory.ledgerItems || [], ledgerMemoryLimit())
          .map((item) => ({ ...item, sourceStep: item.sourceStep ?? repairStepIndex })),
        aiRequest: actionResult.aiRequest,
        beforeScreenshotPath,
        afterScreenshotPath,
        screenshotPath: afterScreenshotPath,
        tools: summarizeToolTraces(actionResult.traces),
        visualContext: actionResult.visualContext,
        workingMemory: actionResult.workingMemory,
      };
      steps.push(completedStep);
      await onProgress?.(completedStep);
      await onDebug?.({
        phase: 'recorded:repair:done',
        stepIndex: repairStepIndex,
        message: `AI repair completed with ${decision.status}${decision.done ? '; requirement marked done' : '; replay can continue'}.`,
        details: { decision, traces: actionResult.traces },
      });
      return { status: decision.status, done: decision.done };
    } catch (error) {
      const recoverableStep = await createRecoverableRuntimeErrorStep({
        session,
        runId,
        stepIndex: repairStepIndex,
        beforeScreenshotPath,
        error,
        tools: summarizeToolTraces(liveToolTraces),
        aiRequest: error && typeof error === 'object' ? (error as { aiRequest?: AiRequestSnapshot }).aiRequest : undefined,
        recoveredState: progressFieldsFromToolTraces(liveToolTraces, requirementOf(testCase), repairStepIndex, latestToolProgress),
      });
      steps.push(recoverableStep);
      await onProgress?.(recoverableStep);
      await onDebug?.({
        phase: 'recorded:repair:error',
        stepIndex: repairStepIndex,
        message: 'AI repair failed; recorded replay cannot continue automatically.',
        details: { error: serializeError(error), failedRecordedStep, flow },
      });
      return { status: 'failed', done: true };
    } finally {
      clearStepAbortController(runId, repairStepIndex);
    }
  }

  try {
    await onDebug?.({ phase: 'recorded:start', message: `Using recorded flow with ${recordedFlow.length} tool calls; AI repair will take over if a recorded operation fails.` });
    await session.start();

    for (let index = 0; index < recordedFlow.length; index += 1) {
      const flow = recordedFlow[index];
      const stepIndex = steps.length + 1;
      await waitWhilePaused(stepIndex);

      if (await shouldSkipStep?.(stepIndex)) {
        const skippedStep = createSkippedStep(stepIndex);
        steps.push(skippedStep);
        await onProgress?.(skippedStep);
        continue;
      }

      await waitBeforeRecordedTool(session, flow, index === 0);
      let beforeScreenshotPath = await session.takeScreenshot(runId, stepIndex, 'before');
      const runningStep: StepExecutionResult = {
        index: stepIndex,
        action: `回放固定流程工具：${flow.name}`,
        expected: 'Recorded tool should execute with recorded parameters.',
        actual: 'Executing recorded tool call.',
        status: 'running',
        beforeScreenshotPath,
        tools: [{ name: flow.name, input: flow.input, reason: flow.reason }],
      };
      await onProgress?.(runningStep);
      const visualContext = new VisualContextManager();
      visualContext.init({
        path: beforeScreenshotPath,
        stepIndex,
        capture: 'viewport',
        reason: 'Initial screenshot for recorded replay step',
      });
      const liveToolTraces: ToolTrace[] = [];
      const publishRecordedToolProgress = async (actual: string) => {
        const liveFields = progressFieldsFromToolTraces(liveToolTraces, requirementOf(testCase), stepIndex);
        await onProgress?.({
          ...runningStep,
          beforeScreenshotPath,
          actual,
          tools: liveToolTraces.length ? summarizeToolTraces(liveToolTraces) : runningStep.tools,
          ...liveFields,
          visualContext: liveFields.visualContext || visualContext.snapshot(),
        });
      };

      const pageContext = await session.getManualVerificationState();
      const explicitManualWait = flow.waitForManual || flow.name === 'waitForHumanVerification';
      if (explicitManualWait || pageContext.isManualVerification) {
        const reason = explicitManualWait
          ? '录制流程在此处需要用户完成验证码、登录验证或安全校验。'
          : '回放检测到当前页面出现验证码、登录验证或安全校验，需要用户在现有浏览器中手动处理。';
        const skippedForManual = await waitForRecordedManualIntervention({
          stepIndex,
          reason,
          screenshotPath: beforeScreenshotPath,
          runningStep,
        });
        if (skippedForManual) {
          const skippedStep = createSkippedStep(stepIndex, beforeScreenshotPath);
          steps.push(skippedStep);
          await onProgress?.(skippedStep);
          continue;
        }

        beforeScreenshotPath = await session.takeScreenshot(runId, stepIndex, 'before');
        await onProgress?.({
          ...runningStep,
          beforeScreenshotPath,
          actual: '用户已确认人工校验完成；回放正在从最新页面状态继续。',
        });

        if (explicitManualWait) {
          const afterScreenshotPath = await session.takeScreenshot(runId, stepIndex, 'after');
          const completedStep: StepExecutionResult = {
            index: stepIndex,
            action: `回放固定流程工具：${flow.name}`,
            expected: 'Recorded manual verification wait should pause until the user confirms completion.',
            actual: '用户已确认人工校验完成，回放继续执行后续步骤。',
            status: 'passed',
            beforeScreenshotPath,
            afterScreenshotPath,
            screenshotPath: afterScreenshotPath,
            tools: [{ name: flow.name, input: flow.input, reason: flow.reason, ok: true, result: 'Manual verification confirmed by user before replay continued.' }],
            ledgerItems: [{
              dimensionId: 'runtime-replay',
              title: '回放等待人工校验',
              status: 'evidence',
              severity: 'info',
              expected: '验证码、登录验证或安全校验完成前，回放不应继续执行后续操作。',
              actual: '回放已暂停并等待用户点击“执行完毕”后继续。',
              sourceStep: stepIndex,
            }],
          };
          steps.push(completedStep);
          await onProgress?.(completedStep);
          await onDebug?.({
            phase: 'recorded:manual-step',
            stepIndex,
            message: 'Recorded manual verification step completed after user confirmation.',
            details: { flow },
          });
          continue;
        }
      }

      const result = await runTracedRecordedTool({
        session,
        targetUrl: testCase.targetUrl,
        flow,
        mode,
        traces: liveToolTraces,
        runId,
        stepIndex,
        visualContext,
        onVisualContextChange: async () => {
          await publishRecordedToolProgress(`Recorded tool ${flow.name} updated the replay screenshot context.`);
        },
        onToolTrace: async (trace) => {
          upsertToolTrace(liveToolTraces, trace);
          await publishRecordedToolProgress(trace.result
            ? `Recorded tool ${trace.name} ${trace.result.ok ? 'completed' : 'failed'}.`
            : `Recorded tool ${trace.name} started.`);
        },
      }).catch((error) => ({
        ok: false,
        actual: infrastructureError(error),
      }));
      await waitAfterRecordedTool(session);
      const afterScreenshotPath = await session.takeScreenshot(runId, stepIndex, 'after');
      const completedStep: StepExecutionResult = {
        index: stepIndex,
        action: `回放固定流程工具：${flow.name}`,
        expected: 'Recorded tool should execute with recorded parameters.',
        actual: result.actual,
        status: result.ok ? 'passed' : 'failed',
        beforeScreenshotPath: beforeScreenshotPath || '',
        afterScreenshotPath,
        screenshotPath: afterScreenshotPath,
        tools: liveToolTraces.length ? summarizeToolTraces(liveToolTraces) : [{ name: flow.name, input: flow.input, reason: flow.reason, ok: result.ok, result: result.actual }],
        visualContext: visualContext.snapshot(),
        ledgerItems: result.ok ? undefined : [{
          dimensionId: 'runtime-replay',
          title: '固定回放操作失败',
          status: 'issue',
          severity: 'major',
          expected: '录制动作应能在当前页面稳定执行。',
          actual: result.actual,
          summary: `回放工具 ${flow.name} 失败，可能是页面加载状态、候选编号、DOM 结构或登录/验证状态变化导致。`,
          sourceStep: stepIndex,
        }],
      };
      steps.push(completedStep);
      await onProgress?.(completedStep);
      await onDebug?.({
        phase: 'recorded:step',
        stepIndex,
        message: `${flow.name} -> ${result.ok ? 'ok' : 'failed'}`,
        details: { flow, result },
      });

      if (!result.ok) {
        if (!replayAiRepairEnabled()) {
          allowBrowserClose = true;
          return {
            status: 'failed' as const,
            result: {
              steps,
              consoleErrors: session.getConsoleErrors(),
              networkErrors: session.getNetworkErrors(),
            },
          };
        }

        const repair = await runAiRepairForRecordedFailure(completedStep, flow);
        if (repair.status === 'passed' && !repair.done) continue;
        allowBrowserClose = repair.status !== 'blocked';
        return {
          status: repair.status,
          result: {
            steps,
            consoleErrors: session.getConsoleErrors(),
            networkErrors: session.getNetworkErrors(),
          },
        };
      }
    }

    allowBrowserClose = true;
    return {
      status: 'passed' as const,
      result: {
        steps,
        consoleErrors: session.getConsoleErrors(),
        networkErrors: session.getNetworkErrors(),
      },
    };
  } catch (error) {
    const blockedStep: StepExecutionResult = {
      index: steps.length + 1,
      action: '固定流程回放中断',
      expected: 'Recorded tool flow should replay stably.',
      actual: infrastructureError(error),
      status: 'blocked',
    };
    steps.push(blockedStep);
    await onProgress?.(blockedStep);
    return {
      status: 'blocked' as const,
      result: {
        steps,
        consoleErrors: session.getConsoleErrors(),
        networkErrors: session.getNetworkErrors(),
      },
    };
  } finally {
    await session.close({ keepOpen: !allowBrowserClose });
  }
}

export async function executeTestCase(testCase: TestCaseRecord, runId: string, options: ExecutionOptions = {}): Promise<TestExecutionResult> {
  if (!options.initialSteps?.length && options.recordedFlow?.length) {
    return executeRecordedFlow(testCase, runId, options.recordedFlow, options);
  }

  const runtimeMode = browserModeOf(testCase);

  const {
    onProgress,
    onDebug,
    initialSteps,
    shouldSkipStep,
    shouldPauseRun,
    shouldResumeStep,
    onPaused,
    onResumed,
    onManualIntervention,
    onManualInterventionCleared,
  } = options;
  const session = new BrowserSession(runtimeMode, {
    browserSurface: 'external',
    isMarked: false,
    runId,
  });
  const steps: StepExecutionResult[] = [...(initialSteps || [])];
  const startStepIndex = Math.max(0, ...steps.map((step) => step.index)) + 1;
  const manualResumeCounts = new Map<number, number>();
  const maxManualPromptsPerStep = manualVerificationMaxPromptsPerStep();
  let selectedScreenshotReferences: SelectedScreenshotReference[] = [];
  let runtimeMessageState: RuntimeRetryState | undefined;
  const runtimeObservationStore: RuntimeObservationStore = new Map();
  let keepBrowserOpen = false;
  let allowBrowserClose = false;
  let tracePath: string | undefined;

  async function waitWhilePaused(stepIndex: number) {
    if (!shouldPauseRun) return false;
    let paused = false;
    while (await shouldPauseRun(stepIndex)) {
      if (!paused) {
        paused = true;
        await onPaused?.(stepIndex);
        await onDebug?.({ phase: 'run:paused', stepIndex, message: 'Run paused by user; waiting for resume.' });
      }
      await sleep(800);
    }
    if (paused) {
      await onResumed?.(stepIndex);
      await onDebug?.({ phase: 'run:resumed', stepIndex, message: 'Run resumed by user; continuing from the same step.' });
    }
    return paused;
  }

  async function takeStepScreenshot(phase: 'before' | 'after', stepIndex: number) {
    if (runtimeMode === 'dom' && process.env.TARGET_DOM_SCREENSHOTS !== 'true' && process.env.BROWSER_CHAT_DOM_SCREENSHOTS !== 'true') {
      await onDebug?.({
        phase: `browser:screenshot:${phase}:skipped`,
        stepIndex,
        message: `DOM test execution skipped ${phase} screenshot; using DOM page context instead.`,
        details: { browserMode: runtimeMode, enabledBy: 'TARGET_DOM_SCREENSHOTS=true' },
      });
      return undefined;
    }
    const startedAt = Date.now();
    try {
      const screenshotPath = await session.takeScreenshot(runId, stepIndex, phase);
      const message = phase === 'before'
        ? `Current page screenshot captured in ${elapsedSince(startedAt)}ms.`
        : `Post-action screenshot captured in ${elapsedSince(startedAt)}ms.`;
      const timingSummary = session.formatLastScreenshotTiming();
      await onDebug?.({
        phase: `browser:screenshot:${phase}`,
        stepIndex,
        message: timingSummary ? `${message} ${timingSummary}` : message,
        details: { elapsedMs: elapsedSince(startedAt), path: screenshotPath, timings: session.getLastScreenshotTiming() },
      });
      return screenshotPath;
    } catch (error) {
      if (runtimeMode !== 'dom') throw error;
      await onDebug?.({
        phase: `browser:screenshot:${phase}:error`,
        stepIndex,
        message: `DOM test execution screenshot ${phase} failed after ${elapsedSince(startedAt)}ms; continuing with DOM page context.`,
        details: serializeError(error),
      });
      return undefined;
    }
  }

  try {
    await onDebug?.({ phase: 'browser:start', message: 'Starting visible browser.' });
    await session.start();
    await session.startTrace(runId);
    await onDebug?.({ phase: 'browser:ready', message: 'Browser is ready; AI will decide each next action from the current page.' });

    for (let stepIndex = startStepIndex; ; stepIndex += 1) {
      await waitWhilePaused(stepIndex);
      const abortController = registerStepAbortController(runId, stepIndex);
      await onDebug?.({ phase: 'step:start', stepIndex, message: `开始执行运行时步骤 ${stepIndex}` });

      if (await shouldSkipStep?.(stepIndex)) {
        const skippedStep = createSkippedStep(stepIndex);
        steps.push(skippedStep);
        await onProgress?.(skippedStep);
        clearStepAbortController(runId, stepIndex);
        continue;
      }

      const beforeScreenshotStartedAt = Date.now();
      let beforeScreenshotPath = await takeStepScreenshot('before', stepIndex);
      const runningStep: StepExecutionResult = {
        index: stepIndex,
                action: 'AI is choosing the next browser action from the current screenshot',
                expected: 'AI should call a browser tool to advance the requirement or decide the requirement is complete.',
        actual: 'AI is choosing the next browser action from the current page context.',
        status: 'running',
        beforeScreenshotPath,
      };
      await onProgress?.(runningStep);
      const beforeTimingSummary = session.formatLastScreenshotTiming();
      await onDebug?.({
        phase: 'perf:before-screenshot',
        stepIndex,
        message: `操作前截图耗时 ${elapsedSince(beforeScreenshotStartedAt)}ms${beforeTimingSummary ? ` ${beforeTimingSummary}` : ''}`,
        details: { elapsedMs: elapsedSince(beforeScreenshotStartedAt), screenshotPath: beforeScreenshotPath, timings: session.getLastScreenshotTiming() },
      });

      if (await waitWhilePaused(stepIndex)) {
        clearStepAbortController(runId, stepIndex);
        stepIndex -= 1;
        continue;
      }

      let skippedDuringManualIntervention = false;
      const pageContext = await session.getManualVerificationState();
      if (pageContext.isManualVerification && !canPromptManualVerification(manualResumeCounts, stepIndex, maxManualPromptsPerStep)) {
        await onDebug?.({
          phase: 'manual:prompt-limit-reached',
          stepIndex,
          message: 'Manual verification still detected after repeated resumes; prompt limit reached, so AI will judge the current page state.',
          details: {
            url: pageContext.url,
            title: pageContext.title,
            screenshotPath: beforeScreenshotPath,
            resumeCount: manualResumeCount(manualResumeCounts, stepIndex),
            maxPrompts: maxManualPromptsPerStep,
          },
        });
      } else if (pageContext.isManualVerification) {
        const reason = '当前页面出现验证码、登录验证或安全校验，需要用户在可见浏览器中手动处理。';
        await onManualIntervention?.({ stepIndex, reason, screenshotPath: beforeScreenshotPath });
        await onDebug?.({
          phase: 'manual:required',
          stepIndex,
                    message: 'Manual verification page detected; run paused for user intervention.',
          details: { url: pageContext.url, title: pageContext.title, screenshotPath: beforeScreenshotPath },
        });
        await onProgress?.({
          ...runningStep,
          actual: `${reason} 完成后请回到运行报告点击“执行完毕”，AI 会重新观察页面并继续。`,
        });

        while (true) {
          if (await shouldSkipStep?.(stepIndex)) {
            const skippedStep = createSkippedStep(stepIndex, beforeScreenshotPath);
            steps.push(skippedStep);
            await onProgress?.(skippedStep);
            skippedDuringManualIntervention = true;
            break;
          }
          if (await shouldResumeStep?.(stepIndex)) break;
          await sleep(800);
        }

        if (skippedDuringManualIntervention) {
          await onManualInterventionCleared?.(stepIndex);
          clearStepAbortController(runId, stepIndex);
          continue;
        }

        await onManualInterventionCleared?.(stepIndex);
        await onDebug?.({ phase: 'manual:resumed', stepIndex, message: 'User confirmed verification complete; collecting a fresh screenshot for AI.' });
        markManualResumed(manualResumeCounts, stepIndex);
        const manualScreenshotStartedAt = Date.now();
        beforeScreenshotPath = await takeStepScreenshot('before', stepIndex);
        const manualTimingSummary = session.formatLastScreenshotTiming();
        await onDebug?.({
          phase: 'perf:manual-resume-screenshot',
          stepIndex,
          message: `Manual-resume screenshot took ${elapsedSince(manualScreenshotStartedAt)}ms${manualTimingSummary ? ` ${manualTimingSummary}` : ''}`,
          details: { elapsedMs: elapsedSince(manualScreenshotStartedAt), screenshotPath: beforeScreenshotPath, timings: session.getLastScreenshotTiming() },
        });
        await onProgress?.({
          ...runningStep,
          beforeScreenshotPath,
                    actual: 'User completed verification; AI is continuing from the latest screenshot.',
        });
      }

      const liveToolTraces: ToolTrace[] = [];
      let latestToolProgress: ToolTraceProgress | undefined;
      let actionResult: Awaited<ReturnType<typeof executeRuntimeStep>>;
      try {
        actionResult = await executeRuntimeStep({
        session,
        testCase,
        runId,
        stepIndex,
        beforeScreenshotPath: beforeScreenshotPath || '',
        completedSteps: steps,
        runtimeMessageState,
        runtimeObservationStore,
        selectedScreenshotReferences,
        onSelectReferenceScreenshots: async (selection) => {
          selectedScreenshotReferences = selection.ids
            .map((id) => selection.availableReferences.find((ref) => ref.id === id))
            .filter((ref): ref is ScreenshotReference => Boolean(ref))
            .map((ref) => ({
              ...ref,
              selectionReason: selection.selectionReason,
              sameInterfaceGroup: selection.sameInterfaceGroup || ref.sameInterfaceGroup,
            }));
          await onDebug?.({
            phase: 'ai:reference-screenshots:selected',
            stepIndex,
            message: selectedScreenshotReferences.length
              ? `Selected reference screenshots for next AI request: ${selectedScreenshotReferences.map((ref) => ref.id).join(', ')}`
              : 'Cleared reference screenshots for next AI request.',
            details: { selection, selectedScreenshotReferences },
          });
        },
        abortSignal: abortController.signal,
        onDebug,
        onToolTrace: async (trace, progress) => {
          upsertToolTrace(liveToolTraces, trace);
          latestToolProgress = progress || latestToolProgress;
          const liveFields = progressFieldsFromToolTraces(liveToolTraces, requirementOf(testCase), stepIndex, latestToolProgress);
          await onProgress?.({
            ...runningStep,
            beforeScreenshotPath,
                          actual: 'AI called a browser tool; waiting for page feedback.',
            tools: summarizeToolTraces(liveToolTraces),
            ...liveFields,
          });
        },
        });
      } catch (error) {
        if (await shouldPauseRun?.(stepIndex)) {
          clearStepAbortController(runId, stepIndex);
          await waitWhilePaused(stepIndex);
          stepIndex -= 1;
          continue;
        }
        if (await shouldSkipStep?.(stepIndex)) {
          const skippedStep = createSkippedStep(stepIndex, beforeScreenshotPath);
          steps.push(skippedStep);
          await onProgress?.(skippedStep);
          clearStepAbortController(runId, stepIndex);
          continue;
        }
        const errorText = infrastructureError(error);
        if (!liveToolTraces.length && isInfrastructureNoise(errorText)) {
          const blockedStep: StepExecutionResult = {
            index: stepIndex,
            action: 'AI request failed before any browser tool executed',
            expected: 'The upstream AI provider should return a tool decision or a clear error within the configured timeout.',
            actual: `${errorText}\n本轮操作已停止，当前页面状态已保留。`,
            status: 'blocked',
            beforeScreenshotPath,
            aiRequest: error && typeof error === 'object' ? (error as { aiRequest?: AiRequestSnapshot }).aiRequest : undefined,
          };
          steps.push(blockedStep);
          await onProgress?.(blockedStep);
          await onDebug?.({
            phase: 'ai:runtime:upstream-error',
            stepIndex,
            message: 'AI provider request failed before any browser tool executed; stopping this run instead of starting another message array.',
            details: {
              error: serializeError(error),
              aiRequest: blockedStep.aiRequest,
            },
          });
          keepBrowserOpen = shouldKeepBrowserOpenAfterError();
          clearStepAbortController(runId, stepIndex);
          return {
            status: 'blocked',
            result: {
              steps,
              consoleErrors: session.getConsoleErrors(),
              networkErrors: session.getNetworkErrors(),
              tracePath,
            },
          };
        }
        const recoverableStep = await createRecoverableRuntimeErrorStep({
          session,
          runId,
          stepIndex,
          beforeScreenshotPath,
          error,
          tools: summarizeToolTraces(liveToolTraces),
          aiRequest: error && typeof error === 'object' ? (error as { aiRequest?: AiRequestSnapshot }).aiRequest : undefined,
          recoveredState: progressFieldsFromToolTraces(liveToolTraces, requirementOf(testCase), stepIndex, latestToolProgress),
        });
        steps.push(recoverableStep);
        await onProgress?.(recoverableStep);
        await onDebug?.({
          phase: 'ai:runtime:recoverable-error',
          stepIndex,
                    message: 'This AI request or response handling failed; recorded as failed step and continuing.',
          details: {
            error: serializeError(error),
            screenshotPath: recoverableStep.screenshotPath,
            aiRequest: recoverableStep.aiRequest,
          },
        });
        clearStepAbortController(runId, stepIndex);
        continue;
      }

      runtimeMessageState = cloneRuntimeMessageState(actionResult.runtimeMessageState);

      if (await waitWhilePaused(stepIndex)) {
        clearStepAbortController(runId, stepIndex);
        stepIndex -= 1;
        continue;
      }

      const afterScreenshotStartedAt = Date.now();
      const afterScreenshotPath = await takeStepScreenshot('after', stepIndex);
      const afterTimingSummary = session.formatLastScreenshotTiming();
      await onDebug?.({
        phase: 'perf:after-screenshot',
        stepIndex,
        message: `操作后截图耗时 ${elapsedSince(afterScreenshotStartedAt)}ms${afterTimingSummary ? ` ${afterTimingSummary}` : ''}`,
        details: { elapsedMs: elapsedSince(afterScreenshotStartedAt), screenshotPath: afterScreenshotPath, timings: session.getLastScreenshotTiming() },
      });

      if (await waitWhilePaused(stepIndex)) {
        clearStepAbortController(runId, stepIndex);
        stepIndex -= 1;
        continue;
      }

      if (await shouldSkipStep?.(stepIndex)) {
        const skippedStep = createSkippedStep(stepIndex, beforeScreenshotPath, afterScreenshotPath);
        steps.push(skippedStep);
        await onProgress?.(skippedStep);
        clearStepAbortController(runId, stepIndex);
        continue;
      }

      let decision = normalizeRuntimeDecision(deriveDecision(actionResult.text, actionResult.traces, requirementOf(testCase)));
      let stopAfterManualPromptLimit = false;

      if (decision.done && completionVerifyEnabled()) {
        const verifyPageContext = await session.getPageContext({
          includeDomTree: false,
          includeText: false,
          includeManualVerification: true,
        });
        const verificationStartedAt = Date.now();
        let verification: CompletionVerification;
        try {
          verification = await verifyRuntimeCompletion({
            testCase,
            screenshotPath: afterScreenshotPath || '',
            proposed: decision,
            completedSteps: steps,
            pageContext: verifyPageContext,
            abortSignal: abortController.signal,
          });
        } catch (error) {
          if (await shouldPauseRun?.(stepIndex)) {
            clearStepAbortController(runId, stepIndex);
            await waitWhilePaused(stepIndex);
            stepIndex -= 1;
            continue;
          }
          throw error;
        }
        await onDebug?.({
          phase: 'completion:verify',
          stepIndex,
          message: verification.verified
            ? 'Completion verification passed; ending run.'
            : `Completion verification failed; continuing: ${verification.remainingWork || verification.summary}`,
          details: { verification, proposed: decision, elapsedMs: elapsedSince(verificationStartedAt) },
        });

        if (!verification.verified) {
          const retryInstruction = `[完成校验未通过] ${verification.summary}${
            verification.remainingWork ? ` 待继续：${verification.remainingWork}` : ''
          }。下一步必须基于新截图继续观察，不要直接再次声明完成。`;
          decision = {
            ...decision,
            done: false,
            status: verification.status === 'blocked' ? 'blocked' : 'passed',
            actual: `${decision.actual}\n\n${retryInstruction}`,
            note: retryInstruction,
          };
        } else {
          decision = {
            ...decision,
            done: true,
            status: verification.status,
            actual: verification.summary,
          };
        }
      }

      if (
        decision.status === 'blocked' &&
        !decision.done &&
        manualIssuePattern.test(`${decision.action}\n${decision.expected}\n${decision.actual}`)
      ) {
        if (!canPromptManualVerification(manualResumeCounts, stepIndex, maxManualPromptsPerStep)) {
          await onDebug?.({
            phase: 'manual:ai-detected-limit-reached',
            stepIndex,
            message: 'AI still detected manual verification after repeated resumes; ending this run as blocked instead of prompting again.',
            details: {
              decision,
              screenshotPath: afterScreenshotPath,
              resumeCount: manualResumeCount(manualResumeCounts, stepIndex),
              maxPrompts: maxManualPromptsPerStep,
            },
          });
          decision = {
            ...decision,
            status: 'blocked',
            actual: `${decision.actual}\n\n已多次等待人工验证，但页面仍被识别为验证码、登录验证或安全校验；为避免无限循环，本次运行按阻塞结束。`,
          };
          stopAfterManualPromptLimit = true;
        } else {
          const reason = decision.actual || 'AI 判断当前截图需要用户完成验证码、登录验证或安全校验。';
          await onManualIntervention?.({ stepIndex, reason, screenshotPath: afterScreenshotPath });
          await onDebug?.({
            phase: 'manual:ai-detected',
            stepIndex,
            message: 'AI detected manual verification in the screenshot; run paused.',
            details: {
              decision,
              screenshotPath: afterScreenshotPath,
              resumeCount: manualResumeCount(manualResumeCounts, stepIndex),
              maxPrompts: maxManualPromptsPerStep,
            },
          });
          await onProgress?.({
            ...runningStep,
            beforeScreenshotPath,
            afterScreenshotPath,
            screenshotPath: afterScreenshotPath,
            actual: `${reason} 完成后请回到运行报告点击“执行完毕”，AI 会重新请求并继续。`,
          });

          let skippedAfterAiManual = false;
          while (true) {
            if (await shouldSkipStep?.(stepIndex)) {
              const skippedStep = createSkippedStep(stepIndex, beforeScreenshotPath, afterScreenshotPath);
              steps.push(skippedStep);
              await onProgress?.(skippedStep);
              await onManualInterventionCleared?.(stepIndex);
              clearStepAbortController(runId, stepIndex);
              skippedAfterAiManual = true;
              break;
            }
            if (await shouldResumeStep?.(stepIndex)) break;
            await sleep(800);
          }

          if (skippedAfterAiManual) continue;

          await onManualInterventionCleared?.(stepIndex);
          await onDebug?.({ phase: 'manual:resumed', stepIndex, message: 'User confirmed verification complete; retrying this AI step.' });
          markManualResumed(manualResumeCounts, stepIndex);
          clearStepAbortController(runId, stepIndex);
          stepIndex -= 1;
          continue;
        }
      }

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
      steps.push(completedStep);
      await onProgress?.(completedStep);
      await onDebug?.({
        phase: 'step:done',
        stepIndex,
          message: `Runtime step ${stepIndex} completed: ${decision.status}${decision.done ? '; AI marked requirement finished' : ''}`,
        details: { decision, traces: actionResult.traces },
      });
      clearStepAbortController(runId, stepIndex);

      if (stopAfterManualPromptLimit) {
        allowBrowserClose = true;
        return {
          status: 'blocked',
          result: {
            steps,
            consoleErrors: session.getConsoleErrors(),
            networkErrors: session.getNetworkErrors(),
            tracePath,
          },
        };
      }

      if (decision.done) {
        allowBrowserClose = true;
        return {
          status: decision.status,
          result: {
            steps,
            consoleErrors: session.getConsoleErrors(),
            networkErrors: session.getNetworkErrors(),
            tracePath,
          },
        };
      }
    }

  } catch (error) {
    keepBrowserOpen = shouldKeepBrowserOpenAfterError();
    const blockedStep: StepExecutionResult = {
      index: steps.length + 1,
            action: 'AI browser run interrupted',
            expected: 'AI should continue operating the browser according to the user requirement.',
      actual: `${infrastructureError(error)}${keepBrowserOpen ? ' Browser is kept open for investigation.' : ''}`,
      status: 'blocked',
    };
    steps.push(blockedStep);
    await onProgress?.(blockedStep);
    return {
      status: 'blocked' as const,
      result: {
        steps,
        consoleErrors: session.getConsoleErrors(),
        networkErrors: session.getNetworkErrors(),
        tracePath,
      },
    };
  } finally {
    tracePath = await session.stopTrace(runId);
    await session.close({ keepOpen: keepBrowserOpen || !allowBrowserClose });
  }
}
