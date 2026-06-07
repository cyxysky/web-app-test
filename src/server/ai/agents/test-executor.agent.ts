import { readFile } from 'node:fs/promises';
import { generateObject, generateText, stepCountIs, tool } from 'ai';
import sharp from 'sharp';
import { z } from 'zod';
import type { AiRequestSnapshot, RecordedFlowStep, RuntimeWorkingMemory, StepExecutionResult, StepToolCall, TaskFrame, TaskLedgerItem, TestCaseRecord, VisualFrameRecord } from '@/server/ai/schemas/test-case.schema';
import { getModel, getModelSettings } from '@/server/ai/model';
import { buildCodexObjectPrompt, buildCompletionPromptLines, buildCompletionVerificationPrompt, buildPrepareStepPrompt, buildVerificationPromptLines } from '@/server/ai/prompts/runtime-agent.prompt';
import { clearStepAbortController, registerStepAbortController } from '@/server/ai/run-control.registry';
import { BrowserSession, type BrowserActionResult, type BrowserSessionMode, type ScreenshotCaptureMode } from '@/server/browser/browser-session';
import { richTextToPlainText } from '@/lib/rich-text';

type ExecutionProgress = (step: StepExecutionResult) => void | Promise<void>;
type ExecutionDebug = (event: { phase: string; message: string; stepIndex?: number; details?: unknown }) => void | Promise<void>;
type ManualIntervention = { stepIndex: number; reason: string; screenshotPath?: string };
type RuntimeStructuredMemoryMode = 'full' | 'light';
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

type ToolTrace = {
  name: string;
  input: unknown;
  result: BrowserActionResult;
  visualAfter?: VisualAfterPolicy;
  screenshots?: Array<{
    title: string;
    path: string;
    kind?: 'current' | 'history' | 'pinned' | 'after' | 'marker' | 'other';
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
  type: z.string().min(1).describe('Tool type to execute. Use reportState when the requirement is complete, blocked, impossible, or only needs a no-op observation.'),
  params: z.object({
    reason: z.string().nullable(),
    url: z.string().nullable(),
    id: z.string().nullable(),
    areaId: z.string().nullable(),
    text: z.string().nullable(),
    key: z.string().nullable(),
    path: z.string().nullable(),
    domPath: z.string().nullable(),
    fromId: z.string().nullable(),
    toId: z.string().nullable(),
    index: z.number().nullable(),
    ms: z.number().nullable(),
    maxMs: z.number().nullable(),
    deltaX: z.number().nullable(),
    deltaY: z.number().nullable(),
    action: z.string().nullable(),
    expected: z.string().nullable(),
    actual: z.string().nullable(),
    status: z.enum(['passed', 'failed', 'blocked']).nullable(),
    done: z.boolean().nullable(),
    currentState: z.string().nullable(),
    observation: z.string().nullable(),
    findings: z.string().nullable(),
    memory: z.string().nullable(),
    nextGoal: z.string().nullable(),
    targetVisual: z.string().nullable(),
    taskFrameJson: z.string().nullable(),
    ledgerItemsJson: z.string().nullable(),
    ids: z.array(z.string()).nullable(),
    selectionReason: z.string().nullable(),
    sameInterfaceGroup: z.string().nullable(),
  }).describe('Parameters for the selected tool. Include every listed key; set unused keys to null. Include reason when choosing a tool.'),
});

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
  const raw = process.env.AI_BROWSER_MODE;
  return /^(true|1|yes|visual|vision|click|visual-markers)$/i.test(String(raw || ''))
    ? 'visual-markers'
    : 'dom';
}

function browserModeOf(testCase: TestCaseRecord): BrowserSessionMode {
  const configured = testCase.content.browserMode;
  if (configured === 'dom' || configured === 'visual-markers') {
    return configured;
  }
  return browserModeFromEnv();
}

function isVisualMode(mode: BrowserSessionMode) {
  return mode !== 'dom';
}

// 是否启用视觉候选标识。关闭时仍发送截图，但候选元素只以文本摘要进入 prompt。
function visualMarkersEnabledFor(testCase: TestCaseRecord) {
  if (typeof testCase.content.isMarked === 'boolean') return testCase.content.isMarked;
  if (process.env.VISUAL_MARKERS_IS_MARKED === 'false' || process.env.SCREENSHOT_IS_MARKED === 'false') return false;
  return true;
}

// 兼容旧双截图链路；默认 false，标识直接叠加在当前截图里。
function usesSeparateMarkerMap() {
  return process.env.VISUAL_MARKER_SEPARATE_MAP !== 'false';
}

// 只有视觉点击模式才允许把截图作为 AI 输入；DOM 模式即使模型支持图片也不会发送。
function shouldSendScreenshotToAi(mode: BrowserSessionMode) {
  return isVisualMode(mode) && modelSupportsScreenshotInput();
}

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
  const raw = process.env.AI_SCREENSHOT_MAX_KB || process.env.SCREENSHOT_MAX_KB || '';
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

// 为每次 AI 请求加超时保护，避免模型长时间无响应导致整次执行卡死。
async function generateTextWithTimeout(options: Parameters<typeof generateText>[0]) {
  const timeoutMs = Number(process.env.AI_TEST_REQUEST_TIMEOUT_MS || 30000);
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new Error(`AI request timed out after ${timeoutMs}ms`)), timeoutMs);
  const upstream = options.abortSignal;
  const abortSignal = upstream ? AbortSignal.any([upstream, timeoutController.signal]) : timeoutController.signal;
  try {
    return await generateText({ ...options, abortSignal });
  } finally {
    clearTimeout(timer);
  }
}

async function generateObjectWithTimeout(options: Parameters<typeof generateObject>[0]) {
  const timeoutMs = Number(process.env.AI_TEST_REQUEST_TIMEOUT_MS || 30000);
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new Error(`AI request timed out after ${timeoutMs}ms`)), timeoutMs);
  const upstream = options.abortSignal;
  const abortSignal = upstream ? AbortSignal.any([upstream, timeoutController.signal]) : timeoutController.signal;
  try {
    return await generateObject({ ...options, abortSignal });
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
function requirementOf(testCase: TestCaseRecord) {
  return richTextToPlainText(testCase.content.userRequirement || testCase.description) || testCase.description || testCase.title;
}

// 读取测试用例上的额外系统提示词，例如级联选择器必须选到叶子节点。
function systemPromptOf(testCase: TestCaseRecord) {
  return richTextToPlainText(testCase.content.systemPrompt || '').trim();
}

// 将浏览器工具调用轨迹压缩为步骤证据，保存到运行历史中。
function summarizeToolTraces(traces: ToolTrace[]): StepToolCall[] {
  return traces.map((trace) => {
    const { input, reason } = splitToolInputAndReason(trace.input);
    return {
      name: trace.name,
      input,
      reason,
      ok: trace.result.ok,
      result: trimDebugText(trace.result.actual, 360),
      visualAfter: trace.visualAfter,
      screenshots: trace.screenshots,
    };
  });
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
  const scrollTool = (step.tools || []).find((toolCall) => toolCall.name === 'scrollArea' || toolCall.name === 'scrollViewport');
  if (!scrollTool) return undefined;
  const input = scrollTool.input && typeof scrollTool.input === 'object' && !Array.isArray(scrollTool.input)
    ? scrollTool.input as Record<string, unknown>
    : {};
  const area = typeof input.areaId === 'string' ? input.areaId : typeof input.domPath === 'string' ? input.domPath : 'page';
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
    const status = trace.result.ok ? 'ok' : `failed: ${sanitizeHistoricalToolText(trace.result.actual, 180)}`;
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

function estimateTextTokens(text: string) {
  let ascii = 0;
  let nonAscii = 0;
  for (const char of text) {
    if (char.charCodeAt(0) <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4 + nonAscii);
}

function estimateContextTokens(text: string, imageCount: number) {
  const imageTokens = Math.max(0, Number(process.env.AI_IMAGE_CONTEXT_ESTIMATE_TOKENS || 1200));
  return estimateTextTokens(text) + imageCount * imageTokens;
}

function compactWorkingMemory(memory: RuntimeWorkingMemory): RuntimeWorkingMemory {
  return {
    ...memory,
    completed: memory.completed.slice(-6),
    findings: memory.findings.slice(-8),
    blockers: memory.blockers.slice(-4),
    lastAction: concise(memory.lastAction, 180),
    lastResult: concise(memory.lastResult, 180),
    pageUnderstanding: concise(memory.pageUnderstanding, 260),
    currentState: concise(memory.currentState, 260),
    scrollSummary: concise(memory.scrollSummary, 360),
    userConstraints: memory.userConstraints.slice(-4).map((item) => concise(item, 180)),
    nextStep: concise(memory.nextStep, 180),
  };
}

function isInfrastructureNoise(value?: string) {
  if (!value) return false;
  return /No capacity available|Request aborted|Active browser page has been closed|Execution context was destroyed|ECONNRESET|ETIMEDOUT|timeout|rate limit|model .*server|Failed after \d+ attempts/i.test(value);
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

function filterRegressiveMemoryItems(items: string[], memory: RuntimeWorkingMemory) {
  void memory;
  return items;
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

function formatInteractiveCandidates(candidates: unknown, limit = 50) {
  if (!Array.isArray(candidates) || !candidates.length) return '[no visible interactive candidates]';
  return JSON.stringify(
    candidates.slice(0, limit).map((item) => {
      const candidate = item as Record<string, unknown>;
      return {
        id: candidate.id,
        tag: candidate.tag,
        role: candidate.role,
        type: candidate.type,
        name: candidate.name,
        text: candidate.text,
        href: candidate.href,
        host: candidate.host,
        rect: candidate.rect,
        center: candidate.center,
        input: candidate.input,
        disabled: candidate.disabled,
        framePath: candidate.framePath,
        frameUrl: candidate.frameUrl,
        nearbyText: candidate.nearbyText,
      };
    }),
    null,
    2,
  );
}

function formatVisualInteractiveElements(candidates: unknown, limit = 80) {
  if (!Array.isArray(candidates) || !candidates.length) return '[no visible interactive elements detected]';
  return candidates.slice(0, limit).map((item, index) => {
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
      candidate.href ? `href=${candidate.href}` : '',
      candidate.framePath ? `frame=${candidate.framePath}` : '',
    ].filter(Boolean).join(', ');
    return `${index + 1}. id=${candidate.id} ${role || 'element'} "${String(label).slice(0, 120)}"${state ? ` (${state})` : ''}${rect}`;
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
    const height = Number(scroll.height);
    const clientHeight = Number(scroll.clientHeight);
    const maxTop = Number.isFinite(height) && Number.isFinite(clientHeight) ? Math.max(0, height - clientHeight) : undefined;
    const progress = Number.isFinite(top) && maxTop !== undefined ? ` scroll=${Math.round(top)}/${Math.round(maxTop)}` : '';
    return `${area.id || '?'}${directions ? ` ${directions}` : ''}${progress}${label ? ` "${String(label).slice(0, 60)}"` : ''}`;
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
      .replace(/\b(?:clickCandidate|doubleClickCandidate|rightClickCandidate|hoverCandidate|dragCandidate|scrollArea|pressKey|typeText)\s*\([^)]*\)/gi, '根据当前截图选择合适工具'),
    220,
  );
}

function sanitizeCurrentState(value: unknown) {
  if (typeof value !== 'string') return '';
  return sanitizeHistoricalToolText(
    value
      .replace(/\b(?:clickCandidate|doubleClickCandidate|rightClickCandidate|hoverCandidate|dragCandidate|scrollArea|pressKey|typeText)\s*\([^)]*\)/gi, '已执行页面操作')
      .replace(/(?:候选|编号|id)\s*\d+/gi, '当前截图中的目标'),
    260,
  );
}

function hasConcreteTargetVisual(input: unknown) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const targetVisual = typeof raw.targetVisual === 'string' ? raw.targetVisual.trim() : '';
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  const combined = `${targetVisual} ${reason}`.trim();
  if (targetVisual.length < 4) return false;
  if (!/[A-Za-z\u4e00-\u9fff]/.test(targetVisual)) return false;
  if (/^(?:候选|编号|id|ID|candidate|#|\d|\s|[:：-])+$/i.test(targetVisual)) return false;
  if (/^(?:下一张|上一张|确定|确认|关闭|按钮|图标|图片|目标|控件)$/i.test(targetVisual)) return false;
  if (!reason || /^(?:点击|选择|使用)?\s*(?:候选|编号|id|ID|candidate)?\s*\d+$/i.test(reason)) return false;
  return /[A-Za-z\u4e00-\u9fff]/.test(combined);
}

function rejectWeakTargetVisual(name: string, input: unknown): BrowserActionResult | undefined {
  if (hasConcreteTargetVisual(input)) return undefined;
  return {
    ok: false,
    actual: `${name} rejected before execution: targetVisual/reason must describe the visible target in the CURRENT screenshot, such as text/icon/position/role. Do not provide only a candidate id or a generic label.`,
  };
}

function candidateActionId(name: string, input: unknown) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  if (name === 'dragCandidate') return `${raw.fromId || ''}->${raw.toId || ''}`;
  return typeof raw.id === 'string' ? raw.id : '';
}

function rejectStaleRepeatedCandidateAction(name: string, input: unknown, traces: ToolTrace[]): BrowserActionResult | undefined {
  const id = candidateActionId(name, input);
  if (!id) return undefined;
  const repeated = traces.some((trace) => trace.name === name && candidateActionId(name, trace.input) === id);
  if (!repeated) return undefined;
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  const targetVisual = typeof raw.targetVisual === 'string' ? raw.targetVisual.trim() : '';
  const hasReasonedRepeat = targetVisual.length >= 4 && reason.length >= 10;
  if (hasReasonedRepeat) return undefined;
  return {
    ok: false,
    actual: `${name} rejected before execution: candidate ${id} was already used in this agent loop. Repeating the same id is allowed, but targetVisual and reason must explain why the current screenshot still supports this same visible target.`,
  };
}

function validateCandidateActionBeforeExecution(name: string, input: unknown, traces: ToolTrace[]) {
  void traces;
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const targetVisual = typeof raw.targetVisual === 'string' ? raw.targetVisual.trim() : '';
  if (!targetVisual) {
    return {
      ok: false,
      actual: `${name} rejected before execution: targetVisual is required for candidate actions so the chosen id is tied to visible evidence from the current screenshot.`,
    };
  }
  return undefined;
}

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
  return !['reportState', 'selectReferenceScreenshots', 'manageVisualContext', 'listTabs', 'getHttpRequests', 'getInteractiveCandidates', 'getDomTree', 'waitForHumanVerification'].includes(name);
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
  const result = trace.result.ok
    ? sanitizeHistoricalToolText(trace.result.actual, 160)
    : `failed: ${sanitizeHistoricalToolText(trace.result.actual, 180)}`;
  return [
    `上一动作：${trace.name}${semanticAction ? ` - ${sanitizeHistoricalToolText(semanticAction, 180)}` : ''}`,
    `结果：${result}`,
  ].join('；');
}

function updateWorkingMemoryFromTrace(memory: RuntimeWorkingMemory, trace: ToolTrace, sourceStep?: number) {
  const input = trace.input && typeof trace.input === 'object' && !Array.isArray(trace.input)
    ? trace.input as Record<string, unknown>
    : {};
  const next: RuntimeWorkingMemory = { ...memory };
  const currentState = sanitizeCurrentState(input.currentState);
  const observation = typeof input.observation === 'string' ? sanitizeHistoricalToolText(input.observation.trim(), 800) : '';
  const findings = typeof input.findings === 'string' ? parseListLike(input.findings).map((item) => sanitizeHistoricalToolText(item, 260)) : [];
  const remembered = filterRegressiveMemoryItems(typeof input.memory === 'string' ? parseListLike(input.memory).map((item) => sanitizeHistoricalToolText(item, 260)) : [], memory);
  const nextGoal = sanitizeNextGoal(input.nextGoal);
  const evidence = (trace.screenshots || []).map((shot) => shot.path).filter(Boolean);
  const taskFrame = normalizeTaskFrame(input.taskFrameJson, memory.taskFrame, memory.taskGoal);
  const ledgerItems = parseLedgerItems(input.ledgerItemsJson, sourceStep, evidence);
  next.lastAction = summarizeTraceForMemory(trace);
  next.lastResult = concise(trace.result.actual, 240);
  if (currentState) next.currentState = currentState;
  if (taskFrame) next.taskFrame = taskFrame;
  next.ledgerItems = mergeLedgerItems(memory.ledgerItems || [], ledgerItems, ledgerMemoryLimit());
  if (observation && !/^none$|^无$/i.test(observation)) next.pageUnderstanding = concise(observation, 400);
  next.findings = Array.from(new Set([...next.findings, ...findings])).slice(-12);
  next.completed = Array.from(new Set([...next.completed, ...remembered])).slice(-12);
  if (!trace.result.ok) next.blockers = Array.from(new Set([...next.blockers, concise(trace.result.actual, 220)])).slice(-8);
  if (trace.name === 'scrollArea') {
    next.phase = '正在查看滚动区域或长页面内容';
    next.scrollSummary = concise([next.scrollSummary, observation || trace.result.actual].filter(Boolean).join('；'), 600);
  } else if (trace.name === 'reportState') {
    next.phase = '正在汇报当前状态或最终结论';
  } else {
    next.phase = '正在执行网页操作并等待页面反馈';
  }
  next.nextStep = nextGoal || (trace.name === 'reportState' ? '根据报告状态决定是否结束' : '根据当前截图继续完成上一个未完成目标');
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
      `${frame.id} ${concise(frame.reason, 80)} image=${basenameOfPath(frame.path)}${frame.markerPath ? ` marker=${basenameOfPath(frame.markerPath)}` : ''}${frame.capture ? ` capture=${frame.capture}` : ''}`
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

function makeBrowserTools(
  session: BrowserSession,
  targetUrl: string,
  mode: BrowserSessionMode,
  traces: ToolTrace[],
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
    visualContext?: VisualContextManager;
    onVisualContextChange?: (snapshot: ReturnType<VisualContextManager['snapshot']>) => void | Promise<void>;
    structuredMemory?: RuntimeStructuredMemoryMode;
  },
) {
  // Enforce a single executed tool per AI request. makeBrowserTools is created fresh for each
  // request, so this flag guarantees that even if the model emits several tool calls in one
  // response (parallel/chained), only the first one actually runs. The rest are ignored, which
  // keeps every browser action paired with a fresh screenshot on the next step and prevents the
  // duplicate-operation problem seen when a request was retried mid-chain.
  let toolExecutedThisRequest = false;
  const semanticFieldRule = 'Do not include candidate ids, area ids, coordinates, delta values, screenshot ids/file names, marker numbers as business meaning, old tool params, or tool input JSON in this semantic field.';
  const toolReasonInput = z.string().min(1).max(300).describe(`Required: concise Chinese reason for this exact tool call. Name the visible target and expected page change; do not merely repeat a candidate ID. ${semanticFieldRule}`);
  const structuredMemory = referenceOptions?.structuredMemory || 'full';
  const structuredMemoryFields = structuredMemory === 'light'
    ? {
        taskFrameJson: z.string().max(9000).nullable().optional().describe('Optional JSON string in browser chat. Include only when the task frame materially changes.'),
        ledgerItemsJson: z.string().max(10000).nullable().optional().describe('Optional JSON array string in browser chat. Include durable issue/risk/findings items when useful; omit or use [] when nothing durable was found.'),
      }
    : {
        taskFrameJson: z.string().min(1).max(9000).describe('Required JSON string. If no TaskFrame exists yet, create one with goal, successCriteria, deliverables, analysisGuidance, finalOutputRequirements, and task-specific dynamic dimensions for THIS user task. Dimensions must be content/coverage axes, not execution progress/status buckets such as login status, reading progress, or test-case generation status. If unchanged, repeat the current TaskFrame JSON.'),
        ledgerItemsJson: z.string().min(1).max(10000).describe('Required JSON array string of NEW structured ledger items from this step. Use [] only when nothing durable was found. Each item has dimensionId,title,status,severity,expected,actual,summary,confidence,attributes. For defects or mismatches, use status="issue"; for potential instability, use status="risk"; include expected vs actual and evidence from the current page/tool result. For requirement-analysis tasks, capture business rules, interface behavior, test flow steps, assertions, risks, and open questions in detail.'),
      };
  const toolContextShape = {
    reason: toolReasonInput,
    currentState: z.string().min(1).max(500).describe(`Required Chinese compact current state after reading the CURRENT screenshot and RunState: page/dialog/mode/progress/error/recovery status. This is authoritative state for the next request. ${semanticFieldRule}`),
    observation: z.string().min(1).max(2200).describe(`Required Chinese observation of the current page/task state. Be concrete and include visible requirement content, business rules, UI state, errors, or "无明显新增观察". ${semanticFieldRule}`),
    findings: z.string().min(1).max(3000).describe(`Required Chinese findings from this step. Act as a tester: record requirement mismatches, visible UI defects, loading/latency problems, validation errors, console/network symptoms mentioned by tools, blocked verification, business rules, test targets, operation flows, risks, and questions. Use "无" only when truly nothing durable was learned. Separate multiple items with semicolons. ${semanticFieldRule}`),
    memory: z.string().min(1).max(2500).describe(`Required Chinese memory for later steps. Include durable business facts/progress only; preserve concrete requirement facts and test ideas. Use "无" if none. Separate multiple items with semicolons. ${semanticFieldRule}`),
    nextGoal: z.string().min(1).max(600).describe(`Required Chinese objective for the NEXT AI request. Describe only the next unfinished target/state, not the concrete operation method, tool name, candidate id, area id, button id, coordinates, or scroll delta. Example: "继续处理尚未覆盖的业务规则并保持已记录结论". ${semanticFieldRule}`),
    ...structuredMemoryFields,
    visualAfter: z.object({
      capture: z.enum(['auto', 'viewport', 'fullPage']).optional().describe('Use auto normally. Use viewport/fullPage only when the next model request truly needs that screenshot size.'),
      retention: z.enum(['auto', 'replace', 'append']).optional().describe('Use replace by default. Use append only when the next decision must compare with, continue from, or analyze together with the previous screenshot.'),
      reason: z.string().optional().describe(`Short Chinese reason for append/capture choice. ${semanticFieldRule}`),
    }).optional(),
  };
  const browserToolInput = <T extends z.ZodRawShape>(shape: T) => z.object({ ...toolContextShape, ...shape });

  async function record(name: string, input: unknown, action: () => Promise<BrowserActionResult>) {
    if (toolExecutedThisRequest) {
      // Do not execute or trace extra calls; just tell the model to stop. This keeps the recorded
      // step clean (one real action) and avoids any duplicate side effect.
      return {
        ok: false,
        actual: 'Ignored: only one tool call is allowed per step. Stop now; you will get a fresh screenshot at the start of the next step and can act again then.',
      } satisfies BrowserActionResult;
    }
    toolExecutedThisRequest = true;
    const beforeFrame = referenceOptions?.visualContext?.current();
    const screenshots: ToolTrace['screenshots'] = [];
    const visualAfter = visualAfterFromInput(name, input);
    if (beforeFrame?.path) {
      screenshots.push({ title: `${name} before`, path: beforeFrame.path, kind: 'history' });
      if (beforeFrame.markerPath) screenshots.push({ title: `${name} before marker map`, path: beforeFrame.markerPath, kind: 'marker' });
    }
    let result: BrowserActionResult;
    try {
      result = await action();
    } catch (error) {
      result = {
        ok: false,
        actual: `Tool ${name} threw after execution started: ${infrastructureError(error)}`,
      };
    }
    if (result.ok && shouldCaptureVisualAfter(name, visualAfter) && referenceOptions?.runId && referenceOptions.stepIndex && referenceOptions.visualContext) {
      try {
        await session.waitForPage().catch(() => undefined);
        const visualIndex = traces.filter((trace) => trace.screenshots?.some((shot) => shot.kind === 'current')).length + 1;
        const screenshotOptions = screenshotOptionsFromVisualAfter(visualAfter);
        const screenshotPath = await session.takeScreenshot(referenceOptions.runId, referenceOptions.stepIndex, `visual-${visualIndex}`, screenshotOptions);
        const markerPath = session.getLastCandidateMarkerScreenshotPath();
        const frame = referenceOptions.visualContext.apply({
          path: screenshotPath,
          markerPath,
          stepIndex: referenceOptions.stepIndex,
          toolName: name,
          capture: screenshotOptions.capture,
          reason: visualAfter.reason || `${name} after screenshot`,
        }, visualAfter);
        screenshots.push({ title: `${name} ${screenshotOptions.capture} after`, path: screenshotPath, kind: frame.role === 'pinned' ? 'pinned' : 'current' });
        if (markerPath) screenshots.push({ title: `${name} marker map`, path: markerPath, kind: 'marker' });
        await referenceOptions.onVisualContextChange?.(referenceOptions.visualContext.snapshot());
      } catch (error) {
        result = {
          ...result,
          actual: `${result.actual} Visual-after screenshot failed, so the action is kept and will not be retried: ${infrastructureError(error)}`,
        };
      }
    } else if (!result.ok && referenceOptions?.visualContext) {
      const current = referenceOptions.visualContext.current();
      if (current?.path) {
        screenshots.push({ title: `${name} failure evidence`, path: current.path, kind: 'other' });
        if (current.markerPath) screenshots.push({ title: `${name} marker map`, path: current.markerPath, kind: 'marker' });
      }
    }
    const trace = { name, input, result, visualAfter, screenshots };
    traces.push(trace);
    try {
      await onToolTrace?.(trace);
    } catch {
      // Progress persistence failures must not make a browser action look unexecuted.
    }
    return result;
  }

  const sharedTools = {
    openPage: tool({
      description: 'Open or navigate to a URL in the browser.',
      inputSchema: browserToolInput({
        url: z.string().optional().describe('The URL to open. Defaults to the test target URL.'),
      }),
      execute: (input) => record('openPage', input, () => session.open(input.url || targetUrl)),
    }),
    scrollArea: tool({
      description: 'Scroll a visible scrollable area by its green S label in the CURRENT screenshot. One call should scroll about one visible viewport/container height only. Green dashed boxes/green labels mark scrollable regions. S ids are volatile per screenshot/turn; never reuse remembered or historical S ids.',
      inputSchema: browserToolInput({
        areaId: z.string().describe('Scrollable area id copied from a green S label visible in the CURRENT screenshot, such as S1 or S2. Do not invent or reuse an old S id.'),
        deltaY: z.number().describe('Vertical scroll delta. Positive scrolls down, negative scrolls up. Use roughly one viewport/container height per call; do not request multiple screens of scrolling in one tool call.'),
        deltaX: z.number().optional().describe('Horizontal scroll delta. Positive scrolls right, negative scrolls left.'),
      }),
      execute: (input) => record('scrollArea', input, () => session.scrollArea(input.areaId, input.deltaY, input.deltaX || 0)),
    }),
    clickCandidate: tool({
      description: 'Click a visible candidate by its numbered label from the current step screenshot snapshot. Choose the smallest/tightest candidate that directly encloses the intended visible text, icon, or control; avoid larger containing wrapper boxes. A successful tool result only confirms the click was delivered, not that the UI changed. The same visible target may be attempted at most twice because the first click can dismiss an overlay while the second activates the target. If text is provided, type it immediately after the click.',
      inputSchema: browserToolInput({
        id: z.string().describe('Candidate id such as 1 or 12. Must come from the current visual labels or interactive candidate list. Never choose a larger overlapping wrapper when a tighter candidate represents the same visible target.'),
        targetVisual: z.string().min(1).max(300).describe('Visible target description from the CURRENT screenshot.'),
        text: z.string().optional().describe('Optional text to type immediately after clicking, useful when the click focuses an input or editable control.'),
      }),
      execute: (input) => record('clickCandidate', input, async () => validateCandidateActionBeforeExecution('clickCandidate', input, traces) || session.clickCandidate(input.id, input.text)),
    }),
    hoverCandidate: tool({
      description: 'Move the mouse over a visible candidate by its numbered label. Use this to reveal hover menus, tooltips, dropdown panels, or controls that only appear on hover.',
      inputSchema: browserToolInput({
        id: z.string().describe('Candidate id such as 1 or 12. Must come from the current visual labels or interactive candidate list.'),
        targetVisual: z.string().min(1).max(300).describe('Visible target description from the CURRENT screenshot.'),
      }),
      execute: (input) => record('hoverCandidate', input, async () => validateCandidateActionBeforeExecution('hoverCandidate', input, traces) || session.hoverCandidate(input.id)),
    }),
    typeText: tool({
      description: 'Type text into the currently focused element. Prefer clickCandidate(id,text) for numbered inputs; use this only after a fallback click already focused the field.',
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
    switchTab: tool({
      description: 'Switch to a browser tab by index when the workflow opened a new tab.',
      inputSchema: browserToolInput({
        index: z.number().describe('The tab index from listTabs.'),
      }),
      execute: (input) => record('switchTab', input, () => session.switchTab(input.index)),
    }),
    reportState: tool({
      description: 'No-op reporting tool. Use exactly this tool when no browser action is needed: requirement complete, blocked, failed, or you only need to record observations/findings/memory. This tool does not change the browser.',
      inputSchema: browserToolInput({
        action: z.string().min(1).describe('Chinese summary of the current assistant state or final conclusion.'),
        expected: z.string().min(1).describe('Chinese expected condition or remaining goal.'),
        actual: z.string().min(1).describe('Chinese evidence-based actual state, including important details.'),
        status: z.enum(['passed', 'failed', 'blocked']).describe('passed for complete or non-terminal observation, failed for impossible/end-to-end failure, blocked for manual verification/security/user input.'),
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
    getInteractiveCandidates: tool({
      description: 'Fallback only (DOM mode): return visible interactable candidates as JSON when the candidate context needs refresh. Each candidate has id (1...), tag/role/name/text, href/host, visible box/center, and nearbyText.',
      inputSchema: browserToolInput({}),
      execute: (input) => record('getInteractiveCandidates', input, () => session.getInteractiveCandidates()),
    }),
    getDomTree: tool({
      description: 'Return the current tab simplified DOM tree of currently visible elements. Each line is "[path] tag#id.class * @x,y,w,h {attrs} \\"text\\"": "*" marks clickable elements, @ is the visible viewport box, {attrs} holds key attributes (placeholder/aria-label/role/href/value...), and "text" is the node\'s own text. Hidden nodes are removed, so paths line up with what is on screen.',
      inputSchema: browserToolInput({}),
      execute: (input) => record('getDomTree', input, () => session.getSimplifiedDomTree()),
    }),
    clickDomNode: tool({
      description: 'Fallback only: click a node from the simplified DOM tree by its bracket path, for example "0.1.2". Prefer clickCandidate when a numbered candidate exists.',
      inputSchema: browserToolInput({
        path: z.string().describe('The bracket path shown in the simplified DOM tree, such as 0.1.2.'),
      }),
      execute: (input) => record('clickDomNode', input, () => session.clickDomNode(input.path)),
    }),
  };

  const visualTools = {
    doubleClickCandidate: tool({
      description: 'Visual mode: double-click a visible candidate by its numbered label. The backend clicks the candidate visible center.',
      inputSchema: browserToolInput({
        id: z.string().describe('Candidate id such as 1 or 12. Must come from the current screenshot labels or interactive candidate list.'),
        targetVisual: z.string().min(1).max(300).describe('Visible target description from the CURRENT screenshot.'),
      }),
      execute: (input) => record('doubleClickCandidate', input, async () => validateCandidateActionBeforeExecution('doubleClickCandidate', input, traces) || session.doubleClickCandidate(input.id)),
    }),
    rightClickCandidate: tool({
      description: 'Visual mode: right-click a visible candidate by its numbered label. The backend clicks the candidate visible center.',
      inputSchema: browserToolInput({
        id: z.string().describe('Candidate id such as 1 or 12. Must come from the current screenshot labels or interactive candidate list.'),
        targetVisual: z.string().min(1).max(300).describe('Visible target description from the CURRENT screenshot.'),
      }),
      execute: (input) => record('rightClickCandidate', input, async () => validateCandidateActionBeforeExecution('rightClickCandidate', input, traces) || session.rightClickCandidate(input.id)),
    }),
    dragCandidate: tool({
      description: 'Visual mode: drag from one numbered candidate center to another numbered candidate center.',
      inputSchema: browserToolInput({
        fromId: z.string().describe('Start candidate id such as 1.'),
        toId: z.string().describe('End candidate id such as 2.'),
        targetVisual: z.string().min(1).max(300).describe('Visible target description from the CURRENT screenshot.'),
      }),
      execute: (input) => record('dragCandidate', input, async () => validateCandidateActionBeforeExecution('dragCandidate', input, traces) || session.dragCandidate(input.fromId, input.toId)),
    }),
  };

  return mode === 'visual-markers' ? { ...sharedTools, ...visualTools } : { ...sharedTools, ...domTools };
}

// 构造完成判定规则；视觉模式用截图作证据，DOM 模式用文本化页面上下文作证据。
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
  const attachScreenshot = shouldSendScreenshotToAi(browserModeOf(testCase));
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
  structuredMemory?: RuntimeStructuredMemoryMode;
}) {
  const { testCase, pageContext, completedSteps } = input;
  const targetHost = hostOf(testCase.targetUrl) || '[unknown target host]';
  const mode = browserModeOf(testCase);
  const visualMode = isVisualMode(mode);
  const attachScreenshot = shouldSendScreenshotToAi(mode);
  const markerEnabled = mode === 'visual-markers' && visualMarkersEnabledFor(testCase);
  const visualMarkersWithoutOverlay = mode === 'visual-markers' && !markerEnabled;
  const markerOverlayInScreenshot = Boolean(markerEnabled && input.markerOverlayInScreenshot);
  const separateMarkerScreenshot = Boolean(markerEnabled && input.hasMarkerScreenshot);
  const structuredMemory = input.structuredMemory || 'full';
  const caseSystemPrompt = systemPromptOf(testCase);
  const requirement = requirementOf(testCase);
  const compactRunContext = buildCompactRunContext(completedSteps, input.workingMemory);
  const availableScreenshotReferences = input.availableScreenshotReferences || [];
  const selectedScreenshotReferences = input.selectedScreenshotReferences || [];
  const strategyMemory = (testCase.strategyMemory || [])
    .filter((hint) => !isInfrastructureNoise(hint))
    .map((hint) => concise(hint, 220))
    .slice(-4);
  const domTree = visualMode ? '[disabled because visual mode is enabled]' : trimDebugText(pageContext.domTree || '[empty DOM tree]', 12000);
  const candidateLimit = Math.max(10, Number(process.env.SCREENSHOT_ELEMENT_LABEL_LIMIT || process.env.INTERACTIVE_CANDIDATE_LIMIT || 160));
  const candidateContext = visualMode
    ? visualMarkersWithoutOverlay
      ? formatVisualInteractiveElements(pageContext.interactiveCandidates, candidateLimit)
      : '[disabled because visual mode uses screenshot labels]'
    : formatInteractiveCandidates(pageContext.interactiveCandidates, candidateLimit);
  const evidence = attachScreenshot
    ? mode === 'visual-markers' && separateMarkerScreenshot
      ? 'the two attached screenshots'
      : mode === 'visual-markers' && markerOverlayInScreenshot
        ? 'the attached viewport screenshot with marker labels overlaid'
      : visualMarkersWithoutOverlay
        ? 'the attached clean viewport screenshot plus the visible interactive elements list'
        : 'the attached clean viewport screenshot'
    : 'Interactive candidates JSON, DOM tree, URL, tabs, and focused element';
  const markerSourceRule = separateMarkerScreenshot
    ? '- Image 1 is the source of truth for what the page means. Image 2 only maps visible click/scroll positions to candidate IDs.'
    : markerOverlayInScreenshot
      ? '- The attached screenshot is the source of truth and contains marker labels overlaid only as click/scroll position IDs.'
      : '- The attached screenshot is the source of truth for what the page means.';
  const markerTargetRules = mode === 'visual-markers' && attachScreenshot && markerEnabled
    ? [
        '',
        'Visual target selection and no-progress recovery:',
        markerSourceRule,
        '- Marker numbers/labels are NOT page content, image/page numbers, item order, progress, status, priority, or business meaning; they only identify where a tool can click/hover/drag/scroll.',
        '- A tool result with ok=true only confirms that the browser received the action. It does NOT prove the target was correct or that the page changed.',
        '- Candidate ids in attached reference screenshots are historical only. For the next action, use only ids that are visible in the current screenshot/marker map.',
        '- For overlapping boxes, choose the smallest/tightest box that directly encloses the intended visible text/icon/control.',
        '- Count repeated attempts by visible target + action, not only by id. After two ineffective attempts, choose another evidence-based path.',
        '- Never issue two clicks from one screenshot. Re-inspect the new screenshot before a second attempt.',
      ]
    : [];
  const modeActionRules = [
    '- Candidate IDs are volatile and valid only for the CURRENT screenshot. Re-read the visible target first, then use its current number.',
    '- For text entry on a numbered candidate, use clickCandidate(id,text) in one tool call. Use typeText only after a fallback click already focused the field.',
    '- For hover-only menus, call hoverCandidate on the visible trigger, then act on the revealed target in the next step.',
    '- If needed content may be outside the visible area, use scrollArea with the green S label shown on the current screenshot.',
    '- For scrollArea, one tool call scrolls one visible viewport/container height. If more content remains, wait for the next screenshot and scroll again.',
    '- Green dashed boxes/green S labels mark scrollable regions. Use only a green S id visible in the CURRENT screenshot; never reuse historical S ids.',
    '- Previous screenshots/references are context only; never use their candidate ids.',
    '- visualAfter defaults to {capture:"auto", retention:"replace"}. Use retention:"append" only when the next turn must compare with or continue from the previous screenshot.',
  ];
  const structuredMemoryRules = structuredMemory === 'full'
    ? [
        '- Maintain a generic TaskFrame. Dimensions must be task-specific content/coverage axes from THIS user goal, not fixed buckets and not agent progress/status such as login status, reading progress, or test-case generation status.',
        '- If the user asks for detailed requirement analysis or test cases, ledgerItemsJson must record concrete business rules, test points, operation flows, assertions, edge cases, and risks discovered in the current screenshot. Do not write vague status-only items.',
        '- Every step should append durable ledgerItemsJson entries against the TaskFrame axes unless the current screenshot truly adds no durable information.',
      ]
    : [
        '- Browser chat uses light structured memory. Do not spend effort generating or repeating a full TaskFrame unless the user is explicitly asking for test-case analysis or the structure materially changes.',
        '- In browser chat, ledgerItemsJson is optional. Use it for clear defects, risks, durable findings, or requirement facts; otherwise omit it or use [].',
      ];
  const structuredMemoryResponseRules = structuredMemory === 'full'
    ? ['- Include taskFrameJson and ledgerItemsJson in tool params. Use ledgerItemsJson=[] when this step adds no durable item.']
    : ['- taskFrameJson and ledgerItemsJson are optional in browser chat. Keep them short and only include durable defects, risks, or requirement facts.'];

  return [
    'You are an AI browser testing agent. Call exactly ONE tool. Use reportState only when no browser action is needed.',
    `Requirement: ${requirement}`,
    `Target URL: ${testCase.targetUrl}`,
    `Target host: ${targetHost}`,
    `Current URL: ${pageContext.url}`,
    '',
    'Hard rules:',
    '- One tool only; all user-facing fields in Chinese.',
    '- Treat RunState JSON as authoritative compact memory. Preserve currentState and do not downgrade completed state because the current screen shows a recovery/earlier state.',
    '- Historical actions in RunState/Working Memory are semantic summaries only. Do not reuse historical candidate ids, area ids, coordinates, deltas, screenshot ids, or old tool input JSON.',
    '- In semantic fields (reason/currentState/observation/findings/memory/nextGoal/ledger text), do not output candidate ids, area ids, coordinates, deltas, screenshot file ids, or tool input JSON.',
    '- If ledgerDigest already covers a requirement area, do not restart that area by habit; continue only with missing or contradicted work.',
    '- Keep currentState as the compact state after reading current screenshot; nextGoal is the next target state, not the operation method.',
    ...structuredMemoryRules,
    '- This is a testing workflow, not a generic browser assistant. In every step, actively look for product defects, requirement mismatches, broken navigation, unexpected page states, visible loading stalls, validation problems, and reliability risks.',
    '- When a problem is observed or strongly indicated by tool/page feedback, describe why it is a problem in findings and add a ledgerItemsJson item with status="issue" or status="risk", severity, expected, actual, summary/reason, and evidence. The runtime will attach current screenshots as issue evidence.',
    '- If the page looks broken, data is missing, a request may have failed, or an issue may be caused by an API/static-resource failure, call getHttpRequests before finalizing that issue when possible.',
    input.repairContext ? `Replay repair mode:\n${input.repairContext}` : '',
    '- Candidate action reason must describe the visible text/icon/position/role from the CURRENT screenshot before choosing id.',
    `- Use ${evidence} as the current page state.`,
    '- If no progress or target mismatch, choose a different evidence-based path; do not repeat the same visible target by habit.',
    '- If loading/transitioning, call waitForPage once. Block only for manual captcha/OTP/security/user input.',
    ...modeActionRules,
    '- After a click may open a tab/window, call listTabs; switchTab if the relevant page is in another tab.',
    '- Block only for empty captcha/OTP/security/manual verification. If captchaAppearsFilled=true, submit/login and continue.',
    '- If the current page requires user-side captcha/OTP/security/manual verification, call waitForHumanVerification. It pauses the run for user intervention and no further AI tool should be requested from that screenshot.',
    '- Finish only when EVERY requirement clause is satisfied; use reportState with done=true/status=passed. Otherwise call one more useful browser tool or reportState with done=false when only recording observations.',
    attachScreenshot
      ? separateMarkerScreenshot
        ? '- Visual mode: image 1 is the clean viewport screenshot. Image 2 is a pixel-aligned marker map: white labels mark clickable targets; green dashed boxes/green S labels mark scrollable regions. getInteractiveCandidates/getDomTree are unavailable.'
        : markerOverlayInScreenshot
          ? '- Visual mode: the attached screenshot is the current page with marker labels overlaid. White labels mark clickable targets; green dashed boxes/green S labels mark scrollable regions. getInteractiveCandidates/getDomTree are unavailable.'
        : markerEnabled
          ? '- Visual mode: use the clean viewport screenshot as the current page state. Candidate marker image is unavailable for this request. getInteractiveCandidates/getDomTree are unavailable.'
          : '- Visual mode without markers: use the clean viewport screenshot as the current page state and use the visible interactive elements list below to choose candidate IDs. getInteractiveCandidates/getDomTree are unavailable.'
      : '- DOM mode: no screenshot image/path is attached. Use candidates first; use DOM tree as fallback. Do not infer from screenshots.',
    ...markerTargetRules,
    caseSystemPrompt ? `Test-case-specific instructions:
${caseSystemPrompt}` : '',
    strategyMemory.length ? `Historical failure strategy memory:
${strategyMemory.map((hint, index) => `${index + 1}. ${hint}`).join('\n')}` : '',
    '',
    ...buildVerificationPromptLines(pageContext, attachScreenshot),
    ...buildCompletionPromptLines(attachScreenshot),
    '',
    'Response:',
    '- Call one tool and keep state fields grounded in RunState plus current screenshot.',
    ...structuredMemoryResponseRules,
    '- Candidate action reason must mention the current-screenshot visual feature, not just an id.',
    '- nextGoal is target state only, e.g. "继续分析未完成的新内容", not "点击按钮".',
    '- To finish/block/fail or only record an observation, call reportState. Do not return standalone JSON.',
    '',
    'Current context:',
    `Open tabs JSON: ${JSON.stringify(pageContext.tabs)}`,
    `Page scroll state JSON: ${JSON.stringify(pageContext.pageScrollState)}`,
    `Scrollable areas summary (green S labels in screenshot are authoritative):\n${formatScrollableAreaSummary(pageContext.scrollableAreas)}`,
    visualMode ? '' : `Focused element JSON: ${JSON.stringify(pageContext.focusedElement)}`,
    visualMarkersWithoutOverlay ? `Visible interactive elements:
${candidateContext}` : '',
    visualMode ? '' : `Interactive candidates JSON:
${candidateContext}`,
    visualMode ? '' : `Simplified DOM tree:
${domTree}`,
    compactRunContext,
    availableScreenshotReferences.length ? `Available previous screenshot references:
${formatScreenshotReferences(availableScreenshotReferences)}` : '',
    selectedScreenshotReferences.length ? `Selected reference screenshots:
${formatScreenshotReferences(selectedScreenshotReferences)}` : '',
    selectedScreenshotReferences.length
      ? 'Reference screenshot rule: selected reference images help connect scroll continuity or compare earlier page state. They may show the same interface at different scroll offsets when sameInterfaceGroup matches, but their candidate ids are historical and must never be used for the current action.'
      : '',
    attachScreenshot
      ? mode === 'visual-markers' && separateMarkerScreenshot
        ? `Screenshot images are attached in this order: Image 1 current clean viewport, Image 2 current marker map${selectedScreenshotReferences.length ? ', then selected reference screenshots in listed order' : ''}.`
        : mode === 'visual-markers' && markerOverlayInScreenshot
          ? `Screenshot images are attached in this order: Image 1 current page with marker labels overlaid${selectedScreenshotReferences.length ? ', then selected reference screenshots in listed order' : ''}.`
        : `Screenshot images are attached in this order: Image 1 current clean viewport${selectedScreenshotReferences.length ? ', then selected reference screenshots in listed order' : ''}.`
      : 'Screenshot image/path is not attached.',
  ].filter(Boolean).join('\n');
}
function summarizeToolInput(input: unknown) {
  if (input && typeof input === 'object') {
    const entries = Object.entries(input as Record<string, unknown>)
      .filter(([key, value]) => !['reason', 'taskFrameJson', 'ledgerItemsJson', 'visualAfter'].includes(key) && value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
    return entries.length ? ` (${entries.join(', ')})` : '';
  }
  return '';
}

function runtimeToolNames(mode: BrowserSessionMode) {
  const sharedTools = [
    'openPage',
    'openUrl',
    'waitForPage',
    'waitForHumanVerification',
    'listTabs',
    'getHttpRequests',
    'switchTab',
    'typeText',
    'pressKey',
    'reportState',
    'scrollArea',
    'selectReferenceScreenshots',
    'manageVisualContext',
  ];
  const candidateTools = [
    ...sharedTools,
    'clickCandidate',
    'hoverCandidate',
    'doubleClickCandidate',
    'rightClickCandidate',
    'dragCandidate',
  ];
  if (mode === 'visual-markers') return candidateTools;
  return [...candidateTools, 'getInteractiveCandidates', 'getDomTree', 'clickDomNode'];
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
    kind: input.kind,
    stepIndex: input.stepIndex,
    createdAt: new Date().toISOString(),
    provider,
    model,
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

function extractProgressNote(text: string) {
  if (!text) return undefined;
  // The model is asked to emit a single "PROGRESS: ... NEXT: ..." line alongside its tool call.
  const match = text.match(/PROGRESS\s*[:：][\s\S]*/i);
  const note = (match ? match[0] : text).replace(/```[\s\S]*?```/g, '').replace(/\s+/g, ' ').trim();
  return note ? note.slice(0, 400) : undefined;
}

function parseListLike(text?: string) {
  if (!text || /^(无|none)$/i.test(text.trim())) return [];
  return text
    .split(/(?:[；;]\s*|\n+|\s(?:\d+\.|[-*])\s)/)
    .map((item) => item.replace(/^[\d.\s、*-]+/, '').trim())
    .filter((item) => item && !/^(无|none)$/i.test(item))
    .slice(0, 8);
}

function parseJsonPayload(value: unknown) {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text || /^(null|none|unchanged|无|暂无)$/i.test(text)) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function stringField(value: unknown, max = 240) {
  return typeof value === 'string' && value.trim() ? concise(value.trim(), max) : undefined;
}

function arrayOfStrings(value: unknown, maxItems = 12) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => stringField(item, 220)).filter((item): item is string => Boolean(item)).slice(0, maxItems);
}

function normalizeDimension(value: unknown): TaskFrame['dimensions'][number] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const name = stringField(raw.name, 80);
  const id = stringField(raw.id, 80) || name?.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '_').replace(/^_+|_+$/g, '');
  if (!id || !name) return undefined;
  const dimension: TaskFrame['dimensions'][number] = {
    id,
    name,
    description: stringField(raw.description, 500),
  };
  const focus = arrayOfStrings(raw.focus, 12);
  const testIdeas = arrayOfStrings(raw.testIdeas, 12);
  const risks = arrayOfStrings(raw.risks, 8);
  if (focus.length) dimension.focus = focus;
  if (testIdeas.length) dimension.testIdeas = testIdeas;
  if (risks.length) dimension.risks = risks;
  return dimension;
}

function fallbackTaskFrame(goal: string): TaskFrame {
  return {
    goal: concise(goal, 300) || 'Complete the user task and preserve structured findings.',
    version: 1,
    successCriteria: ['满足用户目标', '结构化记录关键过程和结论', '最终输出可由台账追溯'],
    dimensions: [],
  };
}

function normalizeTaskFrame(value: unknown, previous: TaskFrame | undefined, goal: string): TaskFrame | undefined {
  const parsed = parseJsonPayload(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return previous || fallbackTaskFrame(goal);
  const raw = parsed as Record<string, unknown>;
  const dimensions = Array.isArray(raw.dimensions)
    ? raw.dimensions.map(normalizeDimension).filter((item): item is TaskFrame['dimensions'][number] => Boolean(item)).slice(0, 12)
    : [];
  if (!dimensions.length && previous) return previous;
  if (!dimensions.length) return fallbackTaskFrame(goal);
  const successCriteria = arrayOfStrings(raw.successCriteria, 12);
  const next: TaskFrame = {
    goal: stringField(raw.goal, 320) || previous?.goal || concise(goal, 320),
    version: typeof raw.version === 'number' ? raw.version : previous?.version || 1,
    successCriteria: successCriteria.length ? successCriteria : previous?.successCriteria || fallbackTaskFrame(goal).successCriteria,
    dimensions,
  };
  const deliverables = arrayOfStrings(raw.deliverables, 12);
  const analysisGuidance = arrayOfStrings(raw.analysisGuidance, 12);
  const finalOutputRequirements = arrayOfStrings(raw.finalOutputRequirements, 12);
  if (deliverables.length) next.deliverables = deliverables;
  else if (previous?.deliverables?.length) next.deliverables = previous.deliverables;
  if (analysisGuidance.length) next.analysisGuidance = analysisGuidance;
  else if (previous?.analysisGuidance?.length) next.analysisGuidance = previous.analysisGuidance;
  if (finalOutputRequirements.length) next.finalOutputRequirements = finalOutputRequirements;
  else if (previous?.finalOutputRequirements?.length) next.finalOutputRequirements = previous.finalOutputRequirements;
  return next;
}

function normalizeLedgerItem(value: unknown, sourceStep?: number, evidence: string[] = []): TaskLedgerItem | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const title = stringField(raw.title, 180);
  if (!title) return undefined;
  const status = ['finding', 'issue', 'covered', 'risk', 'question', 'evidence', 'decision'].includes(String(raw.status))
    ? raw.status as TaskLedgerItem['status']
    : 'finding';
  const severity = ['info', 'minor', 'major', 'critical'].includes(String(raw.severity))
    ? raw.severity as TaskLedgerItem['severity']
    : status === 'issue' || status === 'risk' ? 'minor' : 'info';
  const attributes = Array.isArray(raw.attributes)
    ? raw.attributes.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
      const pair = item as Record<string, unknown>;
      const key = stringField(pair.key, 80);
      const valueText = stringField(pair.value, 180);
      return key && valueText ? { key, value: valueText } : undefined;
    }).filter((item): item is { key: string; value: string } => Boolean(item)).slice(0, 8)
    : undefined;
  const itemEvidence = arrayOfStrings(raw.evidence, 8);
  return {
    id: stringField(raw.id, 120),
    dimensionId: stringField(raw.dimensionId, 80) || 'general',
    title,
    summary: stringField(raw.summary, 500),
    status,
    severity,
    expected: stringField(raw.expected, 500),
    actual: stringField(raw.actual, 500),
    evidence: Array.from(new Set([...itemEvidence, ...evidence])).slice(0, 8),
    confidence: typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? Math.max(0, Math.min(1, raw.confidence)) : undefined,
    sourceStep: typeof raw.sourceStep === 'number' ? raw.sourceStep : sourceStep,
    attributes,
  };
}

function parseLedgerItems(value: unknown, sourceStep?: number, evidence: string[] = []) {
  const parsed = parseJsonPayload(value);
  const rawItems = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  return rawItems
    .map((item) => normalizeLedgerItem(item, sourceStep, evidence))
    .filter((item): item is TaskLedgerItem => Boolean(item))
    .slice(0, 12);
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

function formatTaskFrameContext(frame?: TaskFrame) {
  return JSON.stringify({
    taskFrame: frame || null,
  }, null, 2);
}

function extractAssistantStepInfoFromToolInputs(traces: ToolTrace[], goal = ''): Pick<RuntimeDecision, 'observation' | 'findings' | 'memoryItems' | 'taskFrame' | 'ledgerItems'> {
  const observations: string[] = [];
  const findings: string[] = [];
  const memoryItems: string[] = [];
  let taskFrame: TaskFrame | undefined;
  let ledgerItems: TaskLedgerItem[] = [];
  for (const trace of traces) {
    if (!trace.input || typeof trace.input !== 'object' || Array.isArray(trace.input)) continue;
    const input = trace.input as Record<string, unknown>;
    if (typeof input.observation === 'string' && input.observation.trim() && !/^无$|^none$/i.test(input.observation.trim())) {
      observations.push(sanitizeHistoricalToolText(input.observation.trim(), 800));
    }
    if (typeof input.findings === 'string') findings.push(...parseListLike(input.findings).map((item) => sanitizeHistoricalToolText(item, 260)));
    if (typeof input.memory === 'string') memoryItems.push(...parseListLike(input.memory).map((item) => sanitizeHistoricalToolText(item, 260)));
    const evidence = (trace.screenshots || []).map((shot) => shot.path).filter(Boolean);
    taskFrame = normalizeTaskFrame(input.taskFrameJson, taskFrame, goal);
    ledgerItems = mergeLedgerItems(ledgerItems, parseLedgerItems(input.ledgerItemsJson, undefined, evidence), 24);
  }
  return {
    observation: observations.length ? observations.at(-1)?.slice(0, 800) : undefined,
    findings: Array.from(new Set(findings)).slice(0, 8),
    memoryItems: Array.from(new Set(memoryItems)).slice(0, 8),
    taskFrame,
    ledgerItems,
  };
}

function deriveDecision(text: string, traces: ToolTrace[], goal = ''): RuntimeDecision {
  // When a tool actually executed this step, the step result is derived from the action itself. We
  // never trust JSON done/status in the same response as a tool call, so the model cannot accidentally
  // declare the requirement complete before seeing the next screenshot.
  if (traces.length > 0) {
    const executed = traces.filter((trace) => trace.name);
    const last = executed.at(-1);
    const failed = executed.find((trace) => !trace.result.ok);
    const names = executed.map((trace) => summarizeTraceForMemory(trace)).join('; ');
    const note = extractProgressNote(text);
    const assistantInfo = extractAssistantStepInfoFromToolInputs(executed, goal);
    const toolReason = executed.map((trace) => splitToolInputAndReason(trace.input).reason).find(Boolean);

    if (last?.name === 'reportState' && last.input && typeof last.input === 'object' && !Array.isArray(last.input)) {
      const input = last.input as Record<string, unknown>;
      const status = input.status === 'failed' || input.status === 'blocked' || input.status === 'passed' ? input.status : 'passed';
      return {
        action: typeof input.action === 'string' ? input.action : toolReason || 'AI reported current state',
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
        action: toolReason || '等待人工完成验证',
        expected: '用户在可见浏览器中完成验证码、登录验证或安全校验后，回到运行报告点击“执行完毕”。',
        actual: `AI 已请求人工介入：${last.result.actual || '请在浏览器中完成验证后继续。'}`,
        status: 'blocked',
        done: false,
        note,
        ...assistantInfo,
      };
    }

    return {
      action: note || toolReason || `AI executed browser action: ${names || last?.name || 'browser action'}`,
      expected: 'This action should advance the user requirement; the next screenshot will verify the result.',
      actual: last?.result.actual || 'Tool call finished; waiting for next screenshot to confirm effect.',
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
  const findings = Array.from(new Set([
    ...(assistantInfo.findings || []),
    ...(workingMemory?.findings || []),
  ])).slice(-12);
  const memoryItems = Array.from(new Set([
    ...(assistantInfo.memoryItems || []),
    ...(workingMemory?.completed || []),
  ])).slice(-12);
  const ledgerItems = mergeLedgerItems(
    assistantInfo.ledgerItems || [],
    workingMemory?.ledgerItems || [],
    ledgerMemoryLimit(),
  ).map((item) => ({ ...item, sourceStep: item.sourceStep ?? stepIndex }));

  return {
    observation: assistantInfo.observation || workingMemory?.pageUnderstanding,
    findings,
    memoryItems,
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
  selectedScreenshotReferences?: SelectedScreenshotReference[];
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
  structuredMemory?: RuntimeStructuredMemoryMode;
}) {
  const {
    session,
    testCase,
    stepIndex,
    beforeScreenshotPath,
    completedSteps,
    selectedScreenshotReferences = [],
    onSelectReferenceScreenshots,
    abortSignal,
    onDebug,
    onToolTrace,
  } = input;
  const structuredMemory = input.structuredMemory || 'full';
  const mode = browserModeOf(testCase);
  const screenshotInputEnabled = shouldSendScreenshotToAi(mode);
  const markerEnabled = mode === 'visual-markers' && visualMarkersEnabledFor(testCase);
  const separateMarkerMap = markerEnabled && usesSeparateMarkerMap();
  const markerOverlayInScreenshot = markerEnabled && !separateMarkerMap;
  const markerScreenshotPath = separateMarkerMap && screenshotInputEnabled
    ? session.getLastCandidateMarkerScreenshotPath()
    : undefined;
  const contextStartedAt = Date.now();
  const pageContext = await session.getPageContext({
    includeDomTree: mode === 'dom',
    includeText: false,
    includeManualVerification: false,
    includeInteractiveCandidates: true,
    useCachedInteractiveCandidates: true,
  });
  const contextMs = elapsedSince(contextStartedAt);
  const screenshotReadStartedAt = Date.now();
  const screenshot = screenshotInputEnabled ? await readScreenshotForAi(beforeScreenshotPath) : undefined;
  const markerScreenshot = screenshot && markerScreenshotPath
    ? await readMarkerScreenshotForAi(markerScreenshotPath, screenshot).catch(() => undefined)
    : undefined;
  const selectedReferenceScreenshots = screenshotInputEnabled
    ? await Promise.all(selectedScreenshotReferences.map(async (ref) => ({
        ref,
        image: await readScreenshotForAi(ref.path).catch(() => undefined),
      })))
    : [];
  const screenshotReadMs = elapsedSince(screenshotReadStartedAt);
  const availableScreenshotReferences = buildAvailableScreenshotReferences(completedSteps);
  const availableReferenceIds = new Set(availableScreenshotReferences.map((ref) => ref.id));
  const promptStartedAt = Date.now();
  const prompt = runtimePrompt({
    testCase,
    pageContext,
    completedSteps,
    stepIndex,
    beforeScreenshotPath,
    hasMarkerScreenshot: Boolean(markerScreenshot),
    markerOverlayInScreenshot,
    availableScreenshotReferences,
    selectedScreenshotReferences,
    repairContext: input.repairContext,
    structuredMemory,
  });
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
      screenshotBytes: screenshot?.length,
      markerScreenshotBytes: markerScreenshot?.length,
      selectedReferenceScreenshotCount: selectedReferenceScreenshots.filter((item) => item.image).length,
      browserMode: mode,
    },
  });
  let lastAiRequest: AiRequestSnapshot | undefined;

  async function runAgent(includeImage: boolean) {
    const traces: ToolTrace[] = [];
    const codexMode = isCodexProvider();
    const allowedToolTypes = runtimeToolNames(mode);
    const visualContext = new VisualContextManager();
    visualContext.init({ path: beforeScreenshotPath, markerPath: markerScreenshotPath, stepIndex, capture: 'viewport', reason: 'Initial current screenshot for this agent loop' });
    let requestPrompt = codexMode ? buildCodexObjectPrompt(prompt, allowedToolTypes) : prompt;
    async function refreshRequestPromptForTurn() {
      const currentPageContext = await session.getPageContext({
        includeDomTree: mode === 'dom',
        includeText: false,
        includeManualVerification: false,
        includeInteractiveCandidates: true,
        useCachedInteractiveCandidates: true,
      });
      const currentMarkerPath = visualContext.current()?.markerPath;
      const basePrompt = runtimePrompt({
        testCase,
        pageContext: currentPageContext,
        completedSteps,
        workingMemory,
        stepIndex,
        beforeScreenshotPath,
        hasMarkerScreenshot: Boolean(separateMarkerMap && currentMarkerPath),
        markerOverlayInScreenshot,
        availableScreenshotReferences,
        selectedScreenshotReferences,
        repairContext: input.repairContext,
        structuredMemory,
      });
      requestPrompt = codexMode ? buildCodexObjectPrompt(basePrompt, allowedToolTypes) : basePrompt;
      return requestPrompt;
    }
    let workingMemory: RuntimeWorkingMemory = {
      taskGoal: requirementOf(testCase), phase: 'Entering Agent Loop; choose one tool from the current visual frame.', completed: [], findings: [], blockers: [],
      pageUnderstanding: '', currentState: '尚未形成状态摘要；等待当前截图判断。', scrollSummary: '', userConstraints: systemPromptOf(testCase) ? [systemPromptOf(testCase)] : [], nextStep: '根据当前截图完成下一个未完成目标。',
      taskFrame: testCase.content.taskFrame,
    };
    let latestText = '';
    let contextCompressionTurns = 0;
    let aiRequest = createAiRequestSnapshot({ kind: 'runtime', stepIndex, prompt: requestPrompt, screenshotPath: beforeScreenshotPath, imagePaths: includeImage ? visualContext.imagePaths() : [], imageAttached: Boolean(includeImage && screenshot), tools: allowedToolTypes, options: { agentLoop: true, prepareStep: true, visualContext: visualContext.snapshot(), workingMemory, imageCount: includeImage ? visualContext.imagePaths().length : 0, markerScreenshotPath, isMarked: markerEnabled, markerOverlayInScreenshot, separateMarkerMap, modelSupportsScreenshotInput: modelSupportsScreenshotInput(), screenshotInputEnabled, browserMode: mode, visualClickMode: mode === 'visual-markers', codexObjectMode: codexMode } });
    lastAiRequest = aiRequest;

    async function prepareStep(turnIndex: number) {
      const maxTurns = Math.max(1, Number(process.env.AI_AGENT_LOOP_MAX_TURNS || process.env.AI_TEST_AGENT_MAX_STEPS || 6));
      let visualPaths = includeImage ? visualContext.imagePaths() : [];
      let traceLimit = 5;
      let compressionDetails: Record<string, unknown> | undefined;
      await refreshRequestPromptForTurn();
      const buildContextText = () => {
        const compressionNote = compressionDetails
          ? [
              'Context budget manager:',
              `- Estimated context exceeded ${Math.round(Number(compressionDetails.thresholdRatio) * 100)}%; historical visual frames and working memory were compressed.`,
              '- This request is a single reconstructed prompt built from current visual context, compact memory, and recent tool summaries.',
            ].join('\n')
          : '';
        return buildPrepareStepPrompt({
          requestPrompt,
          compressionNote,
          workingMemoryText: formatWorkingMemory(workingMemory),
          visualContextText: visualContext.renderText(),
          currentToolAttemptsText: formatCurrentToolAttemptSummary(traces, traceLimit),
          turnIndex,
          maxTurns,
          traceLimit,
        });
      };
      let contextText = buildContextText();
      const windowTokens = contextWindowTokens();
      const thresholdRatio = contextCompressionThresholdRatio();
      const thresholdTokens = Math.floor(windowTokens * thresholdRatio);
      let estimatedTokens = estimateContextTokens(contextText, visualPaths.length);
      if (estimatedTokens > thresholdTokens) {
        const beforeImageCount = visualPaths.length;
        const removedFrames = visualContext.compressForBudget('Context budget exceeded; compacting historical visual frames.');
        workingMemory = compactWorkingMemory(workingMemory);
        contextCompressionTurns += 1;
        traceLimit = 3;
        visualPaths = includeImage ? visualContext.imagePaths() : [];
        compressionDetails = {
          turn: contextCompressionTurns,
          estimatedTokensBefore: estimatedTokens,
          thresholdTokens,
          thresholdRatio,
          windowTokens,
          beforeImageCount,
          afterImageCount: visualPaths.length,
          removedFrames,
        };
        contextText = buildContextText();
        estimatedTokens = estimateContextTokens(contextText, visualPaths.length);
        if (estimatedTokens > thresholdTokens && visualPaths.length > 1) {
          visualContext.manage('keepLatestOnly', 'Context budget still exceeded after history compression; keeping only current visual frame for the next dialogue turn.');
          visualPaths = includeImage ? visualContext.imagePaths() : [];
          compressionDetails = {
            ...compressionDetails,
            secondPass: 'keepLatestOnly',
            estimatedTokensAfterFirstPass: estimatedTokens,
            afterImageCount: visualPaths.length,
          };
          contextText = buildContextText();
          estimatedTokens = estimateContextTokens(contextText, visualPaths.length);
        }
        await onDebug?.({
          phase: 'ai:context-compressed',
          stepIndex,
          message: `Context estimate ${estimatedTokens}/${windowTokens} tokens after compression; rebuilt one-shot runtime context ${contextCompressionTurns}.`,
          details: { ...compressionDetails, estimatedTokensAfter: estimatedTokens, visualContext: visualContext.snapshot(), workingMemory },
        });
      }
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; image: Buffer }> = [{ type: 'text', text: contextText }];
      for (const imagePath of visualPaths) { const image = await readScreenshotForAi(imagePath).catch(() => undefined); if (image) content.push({ type: 'image', image }); }
      aiRequest = createAiRequestSnapshot({ kind: 'runtime', stepIndex, prompt: contextText, screenshotPath: visualContext.current()?.path || beforeScreenshotPath, imagePaths: visualPaths, imageAttached: visualPaths.length > 0, tools: allowedToolTypes, options: { agentLoop: true, turnIndex: turnIndex + 1, visualContext: visualContext.snapshot(), workingMemory, imageCount: visualPaths.length, prepareStep: true, contextCompression: compressionDetails ? { ...compressionDetails, estimatedTokensAfter: estimatedTokens } : undefined } });
      lastAiRequest = aiRequest;
      return [{ role: 'user' as const, content }];
    }

    if (codexMode) {
      const aiStartedAt = Date.now();
      const messages = await prepareStep(0);
      await onDebug?.({ phase: 'ai:runtime:request', stepIndex, message: 'AI request started; waiting for browser action decision.', details: { provider: getModelSettings().provider, model: getModelSettings().model, codexObjectMode: true } });
      const result = await generateObjectWithTimeout({ model: getModel(), messages, schema: codexRuntimeObjectSchema, temperature: 0.1, maxRetries: 0, abortSignal });
      const object = result.object as z.infer<typeof codexRuntimeObjectSchema>;
      const execution = await executeCodexRuntimeObject({
        session,
        targetUrl: testCase.targetUrl,
        runId: input.runId,
        stepIndex,
        type: object.type,
        params: object.params,
        allowedTypes: allowedToolTypes,
        traces,
        visualContext,
        onVisualContextChange: async (snapshot) => { await onDebug?.({ phase: 'ai:visual-context', stepIndex, message: 'Visual Context Manager updated.', details: snapshot }); },
        onToolTrace: async (trace) => {
          workingMemory = updateWorkingMemoryFromTrace(workingMemory, trace, stepIndex);
          await onToolTrace?.(trace, { workingMemory, visualContext: visualContext.snapshot() });
          await onDebug?.({ phase: 'ai:tool', stepIndex, message: trace.name + ' -> ' + (trace.result.ok ? 'ok' : 'failed'), details: { trace, visualContext: visualContext.snapshot(), workingMemory } });
        },
        onSelectReferenceScreenshots: async (selection) => { const validIds = selection.ids.filter((id) => availableReferenceIds.has(id)); await onSelectReferenceScreenshots?.({ ...selection, ids: validIds, availableReferences: availableScreenshotReferences }); },
      });
      await onDebug?.({ phase: 'ai:runtime:object', stepIndex, message: 'Codex object -> ' + object.type + '; AI+tool ' + elapsedSince(aiStartedAt) + 'ms', details: jsonSafe({ object, traces, elapsedMs: elapsedSince(aiStartedAt) }) });
      return { text: execution.text, traces, aiRequest, visualContext: visualContext.snapshot(), workingMemory };
    }

    const maxTurns = Math.max(1, Number(process.env.AI_AGENT_LOOP_MAX_TURNS || process.env.AI_TEST_AGENT_MAX_STEPS || 6));
    for (let turnIndex = 0; turnIndex < maxTurns; turnIndex += 1) {
      const aiStartedAt = Date.now();
      const traceStart = traces.length;
      try {
        const messages = await prepareStep(turnIndex);
        await onDebug?.({ phase: 'ai:runtime:request', stepIndex, message: 'AI request started; waiting for browser action decision. turn ' + (turnIndex + 1) + '/' + maxTurns + '.', details: { provider: getModelSettings().provider, model: getModelSettings().model, turnIndex: turnIndex + 1, maxTurns } });
        const result = await generateTextWithTimeout({
          model: getModel(), messages,
          tools: makeBrowserTools(session, testCase.targetUrl, mode, traces, async (trace) => { workingMemory = updateWorkingMemoryFromTrace(workingMemory, trace, stepIndex); await onToolTrace?.(trace, { workingMemory, visualContext: visualContext.snapshot() }); await onDebug?.({ phase: 'ai:tool', stepIndex, message: trace.name + ' -> ' + (trace.result.ok ? 'ok' : 'failed'), details: { trace, visualContext: visualContext.snapshot(), workingMemory } }); }, { availableReferenceIds, runId: input.runId, stepIndex, visualContext, structuredMemory, onVisualContextChange: async (snapshot) => { await onDebug?.({ phase: 'ai:visual-context', stepIndex, message: 'Visual Context Manager updated.', details: snapshot }); }, onSelectReferenceScreenshots: async (selection) => { await onSelectReferenceScreenshots?.({ ...selection, availableReferences: availableScreenshotReferences }); } }),
          stopWhen: stepCountIs(1), temperature: 0.1, maxRetries: 0, abortSignal,
        });
        latestText = result.text || '';
        const newTraces = traces.slice(traceStart);
        const lastTrace = newTraces.at(-1);
        await onDebug?.({ phase: 'ai:runtime:response', stepIndex, message: trimDebugText(latestText || 'AI returned no text; tool call completed.', 220) + '; turn ' + (turnIndex + 1) + '/' + maxTurns + '; AI+tool ' + elapsedSince(aiStartedAt) + 'ms', details: jsonSafe({ text: latestText, traces: newTraces, visualContext: visualContext.snapshot(), workingMemory, elapsedMs: elapsedSince(aiStartedAt) }) });
        if (!lastTrace || lastTrace.name === 'reportState' || lastTrace.name === 'waitForHumanVerification') {
          return { text: latestText, traces, aiRequest, visualContext: visualContext.snapshot(), workingMemory };
        }
      } catch (error) {
        if (traces.length > traceStart && !abortSignal?.aborted) {
          await onDebug?.({ phase: 'ai:runtime:partial', stepIndex, message: 'AI request stopped after a tool executed; keeping the action and continuing from Visual Context Manager.', details: { error: error instanceof Error ? error.message : String(error), traces: traces.slice(traceStart), visualContext: visualContext.snapshot() } });
          return { text: latestText, traces, aiRequest, visualContext: visualContext.snapshot(), workingMemory };
        }
        if (error && typeof error === 'object') (error as { aiRequest?: AiRequestSnapshot }).aiRequest = aiRequest;
        throw error;
      }
    }
    return { text: latestText, traces, aiRequest, visualContext: visualContext.snapshot(), workingMemory };
  }

  // Hidden retries can duplicate browser actions when a provider error happens after a tool
  // started but before the trace is fully persisted. Keep retry opt-in so one AI request maps
  // to at most one browser action by default.
  const retryPureRequestFailure = process.env.AI_RUNTIME_RETRY_ON_PURE_FAILURE === 'true';
  const attempts = retryPureRequestFailure && screenshot ? [true, true] : [Boolean(screenshot)];
  let lastError: unknown;

  for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
    const includeImage = attempts[attemptIndex];
    try {
      if (attemptIndex > 0) {
        await onDebug?.({
          phase: 'ai:runtime:retry',
          stepIndex,
          message: 'AI request failed before any tool executed; retrying once.',
          details: infrastructureError(lastError),
        });
      }
      return await runAgent(includeImage);
    } catch (error) {
      if (abortSignal?.aborted) throw error;
      lastError = error;
    }
  }

  if (lastError && typeof lastError === 'object') {
    (lastError as { aiRequest?: AiRequestSnapshot }).aiRequest ??= lastAiRequest;
    throw lastError;
  }

  const wrapped = new Error(String(lastError || 'AI request failed before a response was returned'));
  (wrapped as { aiRequest?: AiRequestSnapshot }).aiRequest = lastAiRequest;
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

function browserChatMaxSteps() {
  const raw = Number(process.env.AI_BROWSER_CHAT_MAX_STEPS || 6);
  return Math.max(1, Math.floor(Number.isFinite(raw) ? raw : 6));
}

function browserChatRequirement(input: {
  targetUrl: string;
  instruction: string;
  conversation: InteractiveBrowserTurnMessage[];
}) {
  const history = input.conversation
    .slice(-12)
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${concise(message.content, 900)}`)
    .join('\n');
  return [
    'Browser chat mode. This is not a fixed test case.',
    'The user is having a live conversation with you and expects you to operate the browser from the current page state.',
    `Latest user message: ${input.instruction}`,
    `Target URL if the user did not specify another page: ${input.targetUrl || 'about:blank'}`,
    history ? `Conversation history:\n${history}` : '',
    '',
    'Work style:',
    '- Follow the latest user message first, while preserving useful context from the conversation.',
    '- If browser work is needed, take concrete browser actions instead of only describing what to do.',
    '- If the user asks a question about the current page, inspect the page and answer from evidence.',
    '- If the user asks you to continue after manual login/captcha/security work, continue from the current browser state.',
    '- Stop this turn when the latest user message is satisfied, blocked by manual input, or needs clarification.',
    '- Keep tester discipline: record visible problems, suspicious network failures, broken UI states, and why they matter.',
  ].filter(Boolean).join('\n');
}

function createInteractiveBrowserTestCase(input: {
  id: string;
  mode?: BrowserSessionMode | 'default';
  targetUrl: string;
  instruction: string;
  conversation: InteractiveBrowserTurnMessage[];
}): TestCaseRecord {
  const now = new Date().toISOString();
  const targetUrl = input.targetUrl || 'about:blank';
  const requirement = browserChatRequirement({
    targetUrl,
    instruction: input.instruction,
    conversation: input.conversation,
  });
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
      browserMode: input.mode || 'default',
      isMarked: true,
      userRequirement: requirement,
      systemPrompt: 'This is an interactive browser chat. Do not assume a fixed test-case script; operate from the live page and answer the latest user message in Chinese.',
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

function assistantReplyFromStep(step?: StepExecutionResult) {
  if (!step) return '这一轮没有产生新的浏览器操作。';
  const lastTool = step.tools?.at(-1);
  const input = lastTool?.input && typeof lastTool.input === 'object' && !Array.isArray(lastTool.input)
    ? lastTool.input as Record<string, unknown>
    : {};
  const toolText = typeof input.actual === 'string' && input.actual.trim()
    ? input.actual.trim()
    : typeof input.action === 'string' && input.action.trim()
      ? input.action.trim()
      : '';
  const actual = (step.actual || '').replace(/^Reported state without browser action:\s*/i, '').trim();
  return toolText || actual || step.note || '已完成这一轮浏览器操作。';
}

export async function executeInteractiveBrowserTurn(input: {
  session: BrowserSession;
  runId: string;
  targetUrl: string;
  instruction: string;
  conversation?: InteractiveBrowserTurnMessage[];
  completedSteps?: StepExecutionResult[];
  mode?: BrowserSessionMode | 'default';
  onProgress?: (step: StepExecutionResult) => void | Promise<void>;
  onDebug?: ExecutionDebug;
  abortSignal?: AbortSignal;
}): Promise<InteractiveBrowserTurnResult> {
  const steps = [...(input.completedSteps || [])];
  const newSteps: StepExecutionResult[] = [];
  const testCase = createInteractiveBrowserTestCase({
    id: `chat_${input.runId}`,
    mode: input.mode,
    targetUrl: input.targetUrl,
    instruction: input.instruction,
    conversation: input.conversation || [],
  });
  let selectedScreenshotReferences: SelectedScreenshotReference[] = [];
  let finalStatus: InteractiveBrowserTurnResult['status'] = 'passed';
  let reply = '';

  for (let turnStep = 0; turnStep < browserChatMaxSteps(); turnStep += 1) {
    const stepIndex = Math.max(0, ...steps.map((step) => step.index)) + 1;
    await input.onDebug?.({ phase: 'chat:step:start', stepIndex, message: `Preparing browser chat step ${stepIndex}; capturing current page screenshot.` });
    const beforeScreenshotStartedAt = Date.now();
    const beforeScreenshotPath = await input.session.takeScreenshot(input.runId, stepIndex, 'before');
    await input.onDebug?.({ phase: 'browser:screenshot:before', stepIndex, message: `Current page screenshot captured in ${elapsedSince(beforeScreenshotStartedAt)}ms.`, details: { elapsedMs: elapsedSince(beforeScreenshotStartedAt), path: beforeScreenshotPath } });
    const runningStep: StepExecutionResult = {
      index: stepIndex,
      action: 'AI is handling the latest browser chat message',
      expected: 'AI should inspect the live browser state and perform one useful browser action or report the current state.',
      actual: 'AI is choosing the next browser action from the current page.',
      status: 'running',
      beforeScreenshotPath,
    };
    upsertStep(steps, runningStep);
    await input.onProgress?.(runningStep);

    const liveToolTraces: ToolTrace[] = [];
    let latestToolProgress: ToolTraceProgress | undefined;
    let actionResult: Awaited<ReturnType<typeof executeRuntimeStep>>;

    try {
      actionResult = await executeRuntimeStep({
        session: input.session,
        testCase,
        runId: input.runId,
        stepIndex,
        beforeScreenshotPath,
        completedSteps: steps.filter((step) => step.index !== stepIndex),
        structuredMemory: 'light',
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
        },
        abortSignal: input.abortSignal,
        onDebug: input.onDebug,
        onToolTrace: async (trace, progress) => {
          liveToolTraces.push(trace);
          latestToolProgress = progress || latestToolProgress;
          await input.onProgress?.({
            ...runningStep,
            actual: 'AI called a browser tool; waiting for page feedback.',
            tools: summarizeToolTraces(liveToolTraces),
            ...progressFieldsFromToolTraces(liveToolTraces, requirementOf(testCase), stepIndex, latestToolProgress),
          });
        },
      });
    } catch (error) {
      const recoveredState = progressFieldsFromToolTraces(liveToolTraces, requirementOf(testCase), stepIndex, latestToolProgress);
      const errorStep = await createRecoverableRuntimeErrorStep({
        session: input.session,
        runId: input.runId,
        stepIndex,
        beforeScreenshotPath,
        error,
        tools: summarizeToolTraces(liveToolTraces),
        aiRequest: error && typeof error === 'object' ? (error as { aiRequest?: AiRequestSnapshot }).aiRequest : undefined,
        recoveredState,
      });
      upsertStep(steps, errorStep);
      newSteps.push(errorStep);
      await input.onProgress?.(errorStep);
      finalStatus = 'failed';
      reply = assistantReplyFromStep(errorStep);
      break;
    }

    const afterScreenshotStartedAt = Date.now();
    const afterScreenshotPath = await input.session.takeScreenshot(input.runId, stepIndex, 'after');
    await input.onDebug?.({ phase: 'browser:screenshot:after', stepIndex, message: `Post-action screenshot captured in ${elapsedSince(afterScreenshotStartedAt)}ms.`, details: { elapsedMs: elapsedSince(afterScreenshotStartedAt), path: afterScreenshotPath } });
    const decision = normalizeRuntimeDecision(deriveDecision(actionResult.text, actionResult.traces, requirementOf(testCase)));
    const completedStep: StepExecutionResult = {
      index: stepIndex,
      action: decision.action,
      expected: decision.expected,
      actual: decision.actual,
      status: decision.status,
      note: decision.note,
      observation: decision.observation,
      findings: decision.findings,
      memoryItems: decision.memoryItems,
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
    await input.onProgress?.(completedStep);
    reply = assistantReplyFromStep(completedStep);

    const lastToolName = actionResult.traces.at(-1)?.name;
    if (decision.status === 'blocked' || decision.status === 'failed') {
      finalStatus = decision.status;
      break;
    }
    if (decision.done || lastToolName === 'reportState' || lastToolName === 'waitForHumanVerification') {
      finalStatus = decision.status;
      break;
    }
  }

  if (!newSteps.length) {
    reply = reply || '这一轮没有产生新的浏览器操作。';
  } else if (!reply) {
    reply = assistantReplyFromStep(newSteps.at(-1));
  }

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
    observation: recoveredState?.observation,
    findings: recoveredState?.findings,
    memoryItems: recoveredState?.memoryItems,
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

async function runRecordedTool(session: BrowserSession, targetUrl: string, flow: RecordedFlowStep): Promise<BrowserActionResult> {
  const input = flowInput(flow.input);
  const text = typeof input.text === 'string' ? input.text : undefined;
  const domPath = typeof input.domPath === 'string' ? input.domPath : undefined;
  const reason = flow.reason ? ` Recorded reason: ${flow.reason}` : '';

  switch (flow.name) {
    case 'openPage':
    case 'openUrl':
      {
        const rawUrl = typeof input.url === 'string' && input.url.trim() ? input.url : targetUrl;
        const url = normalizeBrowserUrl(rawUrl);
        if (!url) return { ok: false, actual: 'Recorded openPage/openUrl failed because the target URL is empty.' };
        return session.open(url);
      }
    case 'scrollViewport':
      return session.scroll(
        typeof input.deltaY === 'number' ? input.deltaY : 0,
        typeof input.deltaX === 'number' ? input.deltaX : 0,
        { domPath },
      );
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
    case 'clickCandidate':
      return session.clickCandidate(String(input.id || ''), text);
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
    case 'clickDomNode':
      return session.clickDomNode(String(input.path || ''));
    case 'focusDomNode':
      return session.clickDomNode(String(input.path || ''));
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
    case 'switchTab':
      return session.switchTab(typeof input.index === 'number' ? input.index : Number(input.index || 0));
    case 'reportState':
      return { ok: true, actual: `Reported state without browser action: ${String(input.actual || input.reason || '')}` };
    case 'selectReferenceScreenshots':
      return { ok: true, actual: `Selected screenshot references for context only: ${(Array.isArray(input.ids) ? input.ids : []).join(', ') || '[none]'}.` };
    case 'getInteractiveCandidates':
      return session.getInteractiveCandidates();
    case 'getDomTree':
      return session.getSimplifiedDomTree();
    default:
      return { ok: false, actual: `Unsupported recorded tool: ${flow.name}.${reason}` };
  }
}

async function executeCodexRuntimeObject(input: {
  session: BrowserSession;
  targetUrl: string;
  runId: string;
  stepIndex: number;
  type: string;
  params: Record<string, unknown>;
  allowedTypes: string[];
  traces: ToolTrace[];
  visualContext?: VisualContextManager;
  onVisualContextChange?: (snapshot: ReturnType<VisualContextManager['snapshot']>) => void | Promise<void>;
  onToolTrace?: (trace: ToolTrace, progress?: ToolTraceProgress) => void | Promise<void>;
  onSelectReferenceScreenshots?: (selection: {
    ids: string[];
    selectionReason: string;
    sameInterfaceGroup?: string;
  }) => void | Promise<void>;
}) {
  const { session, targetUrl, runId, stepIndex, type, params, allowedTypes, traces, visualContext, onVisualContextChange, onToolTrace, onSelectReferenceScreenshots } = input;
  if (!allowedTypes.includes(type)) {
    return {
      text: `Codex returned unsupported action type: ${type}. It must call exactly one allowed tool, usually reportState for no-op reporting.`,
      executed: false,
    };
  }

  if (type === 'selectReferenceScreenshots') {
    await onSelectReferenceScreenshots?.({
      ids: Array.isArray(params.ids) ? params.ids.filter((id): id is string => typeof id === 'string') : [],
      selectionReason: typeof params.selectionReason === 'string' ? params.selectionReason : String(params.reason || ''),
      sameInterfaceGroup: typeof params.sameInterfaceGroup === 'string' ? params.sameInterfaceGroup : undefined,
    });
  }

  const normalizedParams = { ...params };
  if (type === 'scrollArea') {
    const areaId = typeof normalizedParams.areaId === 'string' && normalizedParams.areaId.trim()
      ? normalizedParams.areaId.trim()
      : typeof normalizedParams.id === 'string' && /^S\d+$/i.test(normalizedParams.id.trim())
        ? normalizedParams.id.trim()
        : '';
    normalizedParams.areaId = areaId || normalizedParams.areaId;
  }

  const beforeFrame = visualContext?.current();
  const screenshots: ToolTrace['screenshots'] = [];
  if (beforeFrame?.path) {
    screenshots.push({ title: `${type} before`, path: beforeFrame.path, kind: 'history' });
    if (beforeFrame.markerPath) screenshots.push({ title: `${type} before marker map`, path: beforeFrame.markerPath, kind: 'marker' });
  }

  const visualAfter = visualAfterFromInput(type, normalizedParams);
  const candidateActionNames = new Set(['clickCandidate', 'hoverCandidate', 'doubleClickCandidate', 'rightClickCandidate', 'dragCandidate']);
  let result: BrowserActionResult;
  try {
    result = candidateActionNames.has(type)
      ? validateCandidateActionBeforeExecution(type, normalizedParams, traces) || await runRecordedTool(session, targetUrl, {
        index: stepIndex,
        name: type,
        input: normalizedParams,
        reason: typeof normalizedParams.reason === 'string' ? normalizedParams.reason : undefined,
      })
      : await runRecordedTool(session, targetUrl, {
        index: stepIndex,
        name: type,
        input: normalizedParams,
        reason: typeof normalizedParams.reason === 'string' ? normalizedParams.reason : undefined,
      });
  } catch (error) {
    result = {
      ok: false,
      actual: `Tool ${type} threw after execution started: ${infrastructureError(error)}`,
    };
  }
  if (result.ok && shouldCaptureVisualAfter(type, visualAfter) && visualContext) {
    try {
      await session.waitForPage().catch(() => undefined);
      const visualIndex = traces.filter((trace) => trace.screenshots?.some((shot) => shot.kind === 'current')).length + 1;
      const screenshotOptions = screenshotOptionsFromVisualAfter(visualAfter);
      const screenshotPath = await session.takeScreenshot(runId, stepIndex, `visual-${visualIndex}`, screenshotOptions);
      const markerPath = session.getLastCandidateMarkerScreenshotPath();
      const frame = visualContext.apply({
        path: screenshotPath,
        markerPath,
        stepIndex,
        toolName: type,
        capture: screenshotOptions.capture,
        reason: visualAfter.reason || `${type} after screenshot`,
      }, visualAfter);
      screenshots.push({ title: `${type} ${screenshotOptions.capture} after`, path: screenshotPath, kind: frame.role === 'pinned' ? 'pinned' : 'current' });
      if (markerPath) screenshots.push({ title: `${type} marker map`, path: markerPath, kind: 'marker' });
      await onVisualContextChange?.(visualContext.snapshot());
    } catch (error) {
      result = {
        ...result,
        actual: `${result.actual} Visual-after screenshot failed, so the action is kept and will not be retried: ${infrastructureError(error)}`,
      };
    }
  } else if (!result.ok && visualContext) {
    const current = visualContext.current();
    if (current?.path) {
      screenshots.push({ title: `${type} failure evidence`, path: current.path, kind: 'other' });
      if (current.markerPath) screenshots.push({ title: `${type} marker map`, path: current.markerPath, kind: 'marker' });
    }
  }

  const trace = { name: type, input: normalizedParams, result, visualAfter, screenshots };
  traces.push(trace);
  try {
    await onToolTrace?.(trace);
  } catch {
    // Progress persistence failures must not make a browser action look unexecuted.
  }
  return { text: '', executed: true };
}

async function executeRecordedFlow(testCase: TestCaseRecord, runId: string, recordedFlow: RecordedFlowStep[], options: ExecutionOptions) {
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
  const session = new BrowserSession(browserModeOf(testCase), { isMarked: visualMarkersEnabledFor(testCase), runId });
  const steps: StepExecutionResult[] = [];
  let selectedScreenshotReferences: SelectedScreenshotReference[] = [];
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
        '- Do not reuse old recorded candidate ids, DOM paths, coordinates, or scroll area ids. Treat them only as historical clues.',
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
          liveToolTraces.push(trace);
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
          screenshotPath: afterScreenshotPath,
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
          observation: decision.observation,
          findings: Array.from(new Set([...(decision.findings || []), 'AI 修复过程中触发人工校验等待点，已在用户确认后继续。'])),
          memoryItems: decision.memoryItems,
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
        observation: decision.observation,
        findings: Array.from(new Set([
          ...(decision.findings || []),
          decision.status === 'passed' ? `AI 已接管并尝试修复回放工具 ${flow.name} 的失败。` : `AI 接管修复回放工具 ${flow.name} 后仍未通过。`,
        ])),
        memoryItems: decision.memoryItems,
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

      const pageContext = await session.getPageContext({
        includeDomTree: false,
        includeText: true,
        includeManualVerification: true,
        includeInteractiveCandidates: false,
      });
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
            findings: ['回放流程包含人工校验等待点，已在用户确认后继续。'],
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

      const result = await runRecordedTool(session, testCase.targetUrl, flow).catch((error) => ({
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
        beforeScreenshotPath,
        afterScreenshotPath,
        screenshotPath: afterScreenshotPath,
        tools: [{ name: flow.name, input: flow.input, reason: flow.reason, ok: result.ok, result: result.actual }],
        findings: result.ok ? undefined : [`固定回放工具 ${flow.name} 执行失败，AI 将基于当前页面接管修复。错误：${concise(result.actual, 220)}`],
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

export async function executeTestCase(testCase: TestCaseRecord, runId: string, options: ExecutionOptions = {}) {
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
  const session = new BrowserSession(runtimeMode, { isMarked: visualMarkersEnabledFor(testCase), runId });
  const steps: StepExecutionResult[] = [...(initialSteps || [])];
  // Each runtime step now performs a single browser action, so allow more steps overall.
  const maxRuntimeSteps = Number(process.env.AI_TEST_RUNTIME_MAX_STEPS || 30);
  const startStepIndex = Math.max(0, ...steps.map((step) => step.index)) + 1;
  const finalStepIndex = startStepIndex + maxRuntimeSteps - 1;
  const manuallyResumedSteps = new Set<number>();
  let selectedScreenshotReferences: SelectedScreenshotReference[] = [];
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

  try {
    await onDebug?.({ phase: 'browser:start', message: 'Starting visible browser.' });
    await session.start();
    await session.startTrace(runId);
    await onDebug?.({ phase: 'browser:ready', message: 'Browser is ready; AI will decide each next action from the current page.' });

    for (let stepIndex = startStepIndex; stepIndex <= finalStepIndex; stepIndex += 1) {
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
      let beforeScreenshotPath = await session.takeScreenshot(runId, stepIndex, 'before');
      const runningStep: StepExecutionResult = {
        index: stepIndex,
                action: 'AI is choosing the next browser action from the current screenshot',
                expected: 'AI should call a browser tool to advance the requirement or decide the requirement is complete.',
        actual: 'AI is choosing the next browser action from the current page context.',
        status: 'running',
        beforeScreenshotPath,
      };
      await onProgress?.(runningStep);
      await onDebug?.({
        phase: 'perf:before-screenshot',
        stepIndex,
        message: `操作前截图耗时 ${elapsedSince(beforeScreenshotStartedAt)}ms`,
        details: { elapsedMs: elapsedSince(beforeScreenshotStartedAt), screenshotPath: beforeScreenshotPath },
      });

      if (await waitWhilePaused(stepIndex)) {
        clearStepAbortController(runId, stepIndex);
        stepIndex -= 1;
        continue;
      }

      let skippedDuringManualIntervention = false;
      const pageContext = await session.getPageContext();
      if (pageContext.isManualVerification && manuallyResumedSteps.has(stepIndex)) {
        await onDebug?.({
          phase: 'manual:still-detected-after-resume',
          stepIndex,
                    message: 'User confirmed manual intervention; page still looks like verification, so continue with AI judgment without prompting again.',
          details: { url: pageContext.url, title: pageContext.title, screenshotPath: beforeScreenshotPath },
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
        manuallyResumedSteps.add(stepIndex);
        const manualScreenshotStartedAt = Date.now();
        beforeScreenshotPath = await session.takeScreenshot(runId, stepIndex, 'before');
        await onDebug?.({
          phase: 'perf:manual-resume-screenshot',
          stepIndex,
          message: `Manual-resume screenshot took ${elapsedSince(manualScreenshotStartedAt)}ms`,
          details: { elapsedMs: elapsedSince(manualScreenshotStartedAt), screenshotPath: beforeScreenshotPath },
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
        beforeScreenshotPath,
        completedSteps: steps,
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
          liveToolTraces.push(trace);
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

      const afterScreenshotStartedAt = Date.now();
      const afterScreenshotPath = await session.takeScreenshot(runId, stepIndex, 'after');
      await onDebug?.({
        phase: 'perf:after-screenshot',
        stepIndex,
        message: `操作后截图耗时 ${elapsedSince(afterScreenshotStartedAt)}ms`,
        details: { elapsedMs: elapsedSince(afterScreenshotStartedAt), screenshotPath: afterScreenshotPath },
      });

      if (await shouldSkipStep?.(stepIndex)) {
        const skippedStep = createSkippedStep(stepIndex, beforeScreenshotPath, afterScreenshotPath);
        steps.push(skippedStep);
        await onProgress?.(skippedStep);
        clearStepAbortController(runId, stepIndex);
        continue;
      }

      let decision = normalizeRuntimeDecision(deriveDecision(actionResult.text, actionResult.traces, requirementOf(testCase)));

      if (decision.done && completionVerifyEnabled()) {
        const verifyPageContext = await session.getPageContext({
          includeDomTree: false,
          includeText: false,
          includeManualVerification: true,
        });
        const verificationStartedAt = Date.now();
        const verification = await verifyRuntimeCompletion({
          testCase,
          screenshotPath: afterScreenshotPath,
          proposed: decision,
          completedSteps: steps,
          pageContext: verifyPageContext,
          abortSignal: abortController.signal,
        });
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
        if (manuallyResumedSteps.has(stepIndex)) {
          await onDebug?.({
            phase: 'manual:retry-after-user-resume',
            stepIndex,
                        message: 'User confirmed manual intervention; AI still returned verification block, retrying this step instead of ending.',
            details: { decision, screenshotPath: afterScreenshotPath },
          });
          await onManualInterventionCleared?.(stepIndex);
          clearStepAbortController(runId, stepIndex);
          stepIndex -= 1;
          continue;
        }

        const reason = decision.actual || 'AI 判断当前截图需要用户完成验证码、登录验证或安全校验。';
        await onManualIntervention?.({ stepIndex, reason, screenshotPath: afterScreenshotPath });
        await onDebug?.({
          phase: 'manual:ai-detected',
          stepIndex,
                    message: 'AI detected manual verification in the screenshot; run paused.',
          details: { decision, screenshotPath: afterScreenshotPath },
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
        manuallyResumedSteps.add(stepIndex);
        clearStepAbortController(runId, stepIndex);
        stepIndex -= 1;
        continue;
      }

      const completedStep: StepExecutionResult = {
        index: stepIndex,
        action: decision.action,
        expected: decision.expected,
        actual: decision.actual,
        status: decision.status,
        note: decision.note,
        observation: decision.observation,
        findings: decision.findings,
        memoryItems: decision.memoryItems,
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

    const timeoutStep: StepExecutionResult = {
      index: steps.length + 1,
            action: 'Reached maximum AI runtime steps',
      expected: `AI should complete or clearly block within ${maxRuntimeSteps} runtime steps.`,
      actual: `Executed ${maxRuntimeSteps} runtime steps, but AI has not marked the requirement complete.`,
      status: 'failed',
    };
    steps.push(timeoutStep);
    await onProgress?.(timeoutStep);
    allowBrowserClose = true;

    return {
      status: 'failed' as const,
      result: {
        steps,
        consoleErrors: session.getConsoleErrors(),
        networkErrors: session.getNetworkErrors(),
        tracePath,
      },
    };
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
