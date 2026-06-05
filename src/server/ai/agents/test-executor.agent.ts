import { readFile } from 'node:fs/promises';
import { generateObject, generateText, stepCountIs, tool } from 'ai';
import sharp from 'sharp';
import { z } from 'zod';
import type { AiRequestSnapshot, RecordedFlowStep, RuntimeWorkingMemory, StepExecutionResult, StepToolCall, TestCaseRecord, TestRunRecord, VisualFrameRecord } from '@/server/ai/schemas/test-case.schema';
import { getModel, getModelSettings } from '@/server/ai/model';
import { buildCodexObjectPrompt, buildCompletionPromptLines, buildCompletionVerificationPrompt, buildPrepareStepPrompt, buildVerificationPromptLines } from '@/server/ai/prompts/runtime-agent.prompt';
import { clearStepAbortController, registerStepAbortController } from '@/server/ai/run-control.registry';
import { BrowserSession, type BrowserActionResult, type BrowserSessionMode, type ScreenshotCaptureMode, type ScreenshotRegion } from '@/server/browser/browser-session';
import { richTextToPlainText } from '@/lib/rich-text';

type ExecutionProgress = (step: StepExecutionResult) => void | Promise<void>;
type ExecutionDebug = (event: { phase: string; message: string; stepIndex?: number; details?: unknown }) => void | Promise<void>;
type ManualIntervention = { stepIndex: number; reason: string; screenshotPath?: string };
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

type VisualAfterPolicy = {
  capture?: 'auto' | 'viewport' | 'fullPage' | 'region' | 'none';
  retention?: 'auto' | 'replace' | 'append' | 'appendScrollSequence' | 'keepBeforeAfter' | 'clearAndReplace' | 'pinEvidence';
  reason?: string;
  region?: ScreenshotRegion;
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
};

type RunMemory = NonNullable<NonNullable<TestRunRecord['result']>['memory']>;

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
    observation: z.string().nullable(),
    findings: z.string().nullable(),
    memory: z.string().nullable(),
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
  return process.env.VISUAL_MARKER_SEPARATE_MAP === 'true';
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

function recentScrollContinuityContext(steps: StepExecutionResult[], limit = 8) {
  return steps
    .flatMap((step) => (step.tools || [])
      .filter((toolCall) => toolCall.name === 'scrollArea' || toolCall.name === 'scrollViewport')
      .map((toolCall) => {
        const input = toolCall.input && typeof toolCall.input === 'object' ? toolCall.input as Record<string, unknown> : {};
        return [
          `Step ${step.index}: ${toolCall.name}`,
          input.areaId ? `area=${input.areaId}` : '',
          input.deltaY !== undefined ? `deltaY=${input.deltaY}` : '',
          input.deltaX !== undefined ? `deltaX=${input.deltaX}` : '',
          toolCall.result ? `result=${trimDebugText(toolCall.result, 260)}` : '',
        ].filter(Boolean).join(' ');
      }))
    .slice(-limit);
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

function buildAvailableScreenshotReferences(steps: StepExecutionResult[], limit = Number(process.env.AI_PROMPT_SCREENSHOT_REFERENCE_LIMIT || 8)): ScreenshotReference[] {
  const refs: ScreenshotReference[] = [];
  for (const step of steps) {
    const entries: Array<{ phase: ScreenshotReference['phase']; path?: string }> = [
      { phase: 'before', path: step.beforeScreenshotPath },
      { phase: 'after', path: step.afterScreenshotPath },
      { phase: 'screenshot', path: step.screenshotPath },
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
        description: [
          `Step ${step.index} ${screenshotPhaseLabel(entry.phase)}`,
          `status=${step.status}`,
          step.tools?.length ? `tools=${step.tools.map((toolCall) => toolCall.name).join(',')}` : '',
          step.observation ? `observation=${concise(step.observation, 90)}` : '',
          step.note ? `note=${concise(step.note, 90)}` : '',
          group ? `sameInterfaceGroup=${group}; likely same page with different scroll offset around this step` : '',
        ].filter(Boolean).join(' | '),
      });
    }
  }
  return refs.slice(-limit);
}

function formatScreenshotReferences(refs: ScreenshotReference[]) {
  if (!refs.length) return '[none]';
  return refs.map((ref) => [
    `- id=${ref.id}`,
    `step=${ref.stepIndex}`,
    `phase=${ref.phase}`,
    ref.sameInterfaceGroup ? `sameInterfaceGroup=${ref.sameInterfaceGroup}` : '',
    `description=${ref.description}`,
  ].filter(Boolean).join(' | ')).join('\n');
}

function concise(value?: string, max = 220) {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function formatCurrentToolAttemptSummary(traces: ToolTrace[], limit = 5) {
  const recent = traces.slice(-limit);
  if (!recent.length) return '[none]';
  return recent.map((trace, index) => {
    const { reason } = splitToolInputAndReason(trace.input);
    const status = trace.result.ok ? 'ok' : `failed: ${concise(trace.result.actual, 180)}`;
    const shots = trace.screenshots?.length ? `; screenshots=${trace.screenshots.length}` : '';
    const why = reason ? `; reason=${concise(reason, 140)}` : '';
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

function stepTimelineItem(step: StepExecutionResult) {
  const toolReasons = (step.tools || [])
    .map((toolCall) => toolCall.reason)
    .filter((value): value is string => Boolean(value && value.trim()));
  const toolNames = (step.tools || []).map((toolCall) => toolCall.name).filter(Boolean).join(', ');
  const parts = [
    step.observation ? `observation=${concise(step.observation, 120)}` : '',
    step.note ? `note=${concise(step.note, 120)}` : '',
    toolReasons.length ? `reason=${concise(toolReasons.join('; '), 160)}` : '',
    step.findings?.length ? `findings=${concise(step.findings.join('; '), 160)}` : '',
    step.status === 'failed' || step.status === 'blocked' ? `issue=${concise(step.actual, 180)}` : '',
  ].filter(Boolean);
  return `Step ${step.index} [${step.status}${toolNames ? `/${toolNames}` : ''}]: ${parts.join(' | ') || concise(step.action || step.actual)}`;
}

function buildRunMemory(steps: StepExecutionResult[], previous?: RunMemory): RunMemory {
  const usefulSteps = steps.filter(isUsefulHistoryStep);
  const timeline = usefulSteps.map(stepTimelineItem).slice(-Number(process.env.RUN_MEMORY_TIMELINE_LIMIT || 10));
  const findings = Array.from(new Set([
    ...(previous?.findings || []),
    ...steps.flatMap((step) => step.findings || []),
  ].map((item) => concise(item, 220)).filter((item) => item && !isInfrastructureNoise(item)))).slice(-16);
  const failedAttempts = Array.from(new Set([
    ...(previous?.failedAttempts || []),
    ...steps
      .filter((step) => step.status === 'failed' || step.status === 'blocked')
      .filter((step) => !isInfrastructureNoise(`${step.action}\n${step.actual}`))
      .map((step) => `Step ${step.index}: ${concise(step.action, 90)} -> ${concise(step.actual, 160)}`),
  ].filter((item) => !isInfrastructureNoise(item)))).slice(-6);
  const durableItems = Array.from(new Set([
    ...steps.flatMap((step) => step.memoryItems || []),
    ...failedAttempts,
  ].map((item) => concise(item, 220)).filter((item) => item && !isInfrastructureNoise(item)))).slice(-10);
  const completed = steps.filter((step) => step.status === 'passed').length;
  const failed = steps.filter((step) => step.status === 'failed').length;
  const blocked = steps.filter((step) => step.status === 'blocked').length;
  const latest = usefulSteps.slice(-5).map((step) => `S${step.index}:${concise(step.observation || step.note || step.action, 80)}`).join('; ');
  const summary = [
    `已执行 ${steps.length} 步：通过 ${completed}，失败 ${failed}，阻塞 ${blocked}。`,
    latest ? `最近有效进展：${latest}` : '',
    findings.length ? `重要发现：${findings.slice(-5).join('；')}` : '',
    durableItems.length ? `后续记忆：${durableItems.slice(-5).join('；')}` : '',
  ].filter(Boolean).join('\n').slice(0, Number(process.env.RUN_MEMORY_SUMMARY_MAX_CHARS || 1000));

  return {
    summary,
    timeline,
    findings,
    failedAttempts,
    updatedAt: new Date().toISOString(),
  };
}

function formatRunMemory(steps: StepExecutionResult[]) {
  const memory = buildRunMemory(steps);
  const includeTimeline = process.env.AI_PROMPT_INCLUDE_FULL_TIMELINE === 'true';
  return [
    `Run memory:\n${memory.summary || '[none]'}`,
    memory.findings.length ? `Findings:\n${memory.findings.slice(-8).map((item, index) => `${index + 1}. ${item}`).join('\n')}` : '',
    memory.failedAttempts.length ? `Ineffective business attempts:\n${memory.failedAttempts.slice(-4).map((item, index) => `${index + 1}. ${item}`).join('\n')}` : '',
    includeTimeline ? `Useful recent timeline:\n${memory.timeline.join('\n') || '[none]'}` : '',
  ].filter(Boolean).join('\n\n');
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

function defaultVisualAfterForTool(name: string): VisualAfterPolicy {
  if (name === 'reportState' || name === 'selectReferenceScreenshots' || name === 'manageVisualContext' || name === 'listTabs' || name === 'waitForHumanVerification') {
    return { capture: 'none', retention: 'auto' };
  }
  if (name === 'scrollArea') return { capture: 'viewport', retention: 'appendScrollSequence' };
  if (name === 'openPage' || name === 'switchTab') return { capture: 'viewport', retention: 'clearAndReplace' };
  if (name === 'hoverCandidate') return { capture: 'viewport', retention: 'keepBeforeAfter' };
  return { capture: 'viewport', retention: 'replace' };
}

function parseScreenshotRegion(value: unknown): ScreenshotRegion | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const width = Number(raw.width);
  const height = Number(raw.height);
  if (![x, y, width, height].every(Number.isFinite)) return undefined;
  if (width <= 0 || height <= 0) return undefined;
  return {
    x: Math.max(0, Math.floor(x)),
    y: Math.max(0, Math.floor(y)),
    width: Math.max(1, Math.floor(width)),
    height: Math.max(1, Math.floor(height)),
  };
}

function visualAfterFromInput(name: string, input: unknown): VisualAfterPolicy {
  const fallback = defaultVisualAfterForTool(name);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fallback;
  const raw = (input as Record<string, unknown>).visualAfter;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
  const visualAfter = raw as Record<string, unknown>;
  const region = parseScreenshotRegion(visualAfter.region);
  return {
    capture: typeof visualAfter.capture === 'string' ? visualAfter.capture as VisualAfterPolicy['capture'] : fallback.capture,
    retention: typeof visualAfter.retention === 'string' ? visualAfter.retention as VisualAfterPolicy['retention'] : fallback.retention,
    reason: typeof visualAfter.reason === 'string' ? visualAfter.reason : undefined,
    region,
  };
}

function screenshotOptionsFromVisualAfter(visualAfter: VisualAfterPolicy): { capture: ScreenshotCaptureMode; region?: ScreenshotRegion } {
  if (visualAfter.capture === 'fullPage') return { capture: 'fullPage' };
  if (visualAfter.capture === 'region' && visualAfter.region) return { capture: 'region', region: visualAfter.region };
  return { capture: 'viewport' };
}

function updateWorkingMemoryFromTrace(memory: RuntimeWorkingMemory, trace: ToolTrace) {
  const input = trace.input && typeof trace.input === 'object' && !Array.isArray(trace.input)
    ? trace.input as Record<string, unknown>
    : {};
  const next: RuntimeWorkingMemory = { ...memory };
  const observation = typeof input.observation === 'string' ? input.observation.trim() : '';
  const findings = typeof input.findings === 'string' ? parseListLike(input.findings) : [];
  const remembered = typeof input.memory === 'string' ? parseListLike(input.memory) : [];
  next.lastAction = `${trace.name}${summarizeToolInput(input)}`;
  next.lastResult = concise(trace.result.actual, 240);
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
  next.nextStep = trace.name === 'reportState' ? '根据报告状态决定是否结束' : '基于最新 current 截图继续判断下一步';
  return next;
}

function formatWorkingMemory(memory: RuntimeWorkingMemory) {
  return [
    `任务目标：${memory.taskGoal}`,
    `当前阶段：${memory.phase || '尚未开始'}`,
    `已完成：${memory.completed.length ? memory.completed.join('；') : '暂无'}`,
    `重要发现：${memory.findings.length ? memory.findings.join('；') : '暂无'}`,
    `阻塞点：${memory.blockers.length ? memory.blockers.join('；') : '暂无'}`,
    `最近动作：${memory.lastAction || '暂无'}`,
    `最近结果：${memory.lastResult || '暂无'}`,
    `当前页面理解：${memory.pageUnderstanding || '暂无'}`,
    `滚动阅读摘要：${memory.scrollSummary || '暂无'}`,
    `用户限制条件：${memory.userConstraints.length ? memory.userConstraints.join('；') : '暂无'}`,
    `下一步建议：${memory.nextStep || '暂无'}`,
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
    const retention = policy.retention || 'auto';
    if (retention === 'clearAndReplace') {
      const record = this.createFrame(frame, 'current');
      this.frames = [record];
      this.currentId = record.id;
      return record;
    }
    if (retention === 'pinEvidence') {
      const record = this.createFrame(frame, 'pinned');
      this.frames.push(record);
      this.trim();
      return record;
    }
    if (retention === 'append' || retention === 'appendScrollSequence' || retention === 'keepBeforeAfter') {
      this.demoteCurrent();
      const record = this.createFrame({
        ...frame,
        group: retention === 'appendScrollSequence' ? frame.group || 'scroll-sequence' : frame.group,
      }, 'current');
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
    const frameSummary = (frame: VisualFrameRecord) => {
      const region = frame.region ? ` region=${JSON.stringify(frame.region)}` : '';
      return `${frame.id} ${frame.reason} path=${frame.path}${frame.markerPath ? ` marker=${frame.markerPath}` : ''}${frame.capture ? ` capture=${frame.capture}` : ''}${region}`;
    };
    return [
      'Visual Context Manager:',
      `current: ${current ? frameSummary(current) : '[none]'}`,
      'current 是唯一允许使用编号进行点击、输入、hover、drag 定位的截图。',
      history.length
        ? `history 仅供参考，不能使用其中编号操作：\n${history.map((frame) => `- ${frameSummary(frame)} role=${frame.role} group=${frame.group || '-'}`).join('\n')}`
        : 'history: [none]',
    ].join('\n');
  }

  imagePaths() {
    const paths: string[] = [];
    const current = this.current();
    if (current) paths.push(current.path);
    if (current?.markerPath) paths.push(current.markerPath);
    for (const frame of this.frames.filter((item) => item.id !== this.currentId)) {
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
  },
) {
  // Enforce a single executed tool per AI request. makeBrowserTools is created fresh for each
  // request, so this flag guarantees that even if the model emits several tool calls in one
  // response (parallel/chained), only the first one actually runs. The rest are ignored, which
  // keeps every browser action paired with a fresh screenshot on the next step and prevents the
  // duplicate-operation problem seen when a request was retried mid-chain.
  let toolExecutedThisRequest = false;
  const toolReasonInput = z.string().min(1).max(300).describe('Required: concise Chinese reason for this exact tool call. Name the visible target and the observable page change expected; do not merely repeat a candidate ID.');
  const toolContextShape = {
    reason: toolReasonInput,
    observation: z.string().min(1).max(800).describe('Required Chinese observation of the current page/task state. Include visible errors, requirement content, business state, or "无明显新增观察".'),
    findings: z.string().min(1).max(1000).describe('Required Chinese findings from this step. Include product errors, requirements, rules, risks, or summaries. Use "无" if none. Separate multiple items with semicolons.'),
    memory: z.string().min(1).max(1000).describe('Required Chinese memory for later steps. Include facts that may affect future actions. Use "无" if none. Separate multiple items with semicolons.'),
    visualAfter: z.object({
      capture: z.enum(['auto', 'viewport', 'fullPage', 'region', 'none']).optional().describe('How to capture visual context after this tool. Use viewport/auto for most browser-changing actions; none for report-only tools.'),
      retention: z.enum(['auto', 'replace', 'append', 'appendScrollSequence', 'keepBeforeAfter', 'clearAndReplace', 'pinEvidence']).optional().describe('How Visual Context Manager should retain the after screenshot.'),
      reason: z.string().optional().describe('Short Chinese reason for the visual retention decision.'),
      region: z.object({
        x: z.number().describe('Viewport x coordinate in CSS pixels. Required when capture=region; negative values will be clamped by the browser runner.'),
        y: z.number().describe('Viewport y coordinate in CSS pixels. Required when capture=region; negative values will be clamped by the browser runner.'),
        width: z.number().describe('Region width in CSS pixels. Required when capture=region; non-positive values fall back to viewport capture.'),
        height: z.number().describe('Region height in CSS pixels. Required when capture=region; non-positive values fall back to viewport capture.'),
      }).optional().describe('Optional viewport clip rectangle for capture=region. Coordinates must come from the current screenshot.'),
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
    const result = await action();
    const visualAfter = visualAfterFromInput(name, input);
    const screenshots: ToolTrace['screenshots'] = [];
    if (result.ok && visualAfter.capture !== 'none' && referenceOptions?.runId && referenceOptions.stepIndex && referenceOptions.visualContext) {
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
        region: screenshotOptions.region,
        reason: visualAfter.reason || `${name} after screenshot`,
      }, visualAfter);
      screenshots.push({ title: `${name} ${screenshotOptions.capture} after`, path: screenshotPath, kind: frame.role === 'pinned' ? 'pinned' : 'current' });
      if (markerPath) screenshots.push({ title: `${name} marker map`, path: markerPath, kind: 'marker' });
      await referenceOptions.onVisualContextChange?.(referenceOptions.visualContext.snapshot());
    } else if (!result.ok && referenceOptions?.visualContext) {
      const current = referenceOptions.visualContext.current();
      if (current?.path) {
        screenshots.push({ title: `${name} failure evidence`, path: current.path, kind: 'other' });
        if (current.markerPath) screenshots.push({ title: `${name} marker map`, path: current.markerPath, kind: 'marker' });
      }
    }
    const trace = { name, input, result, visualAfter, screenshots };
    traces.push(trace);
    await onToolTrace?.(trace);
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
      description: 'Scroll a visible scrollable area by its area id from current scrollableAreas, such as S1 for page viewport or S2 for a table/list/panel/modal.',
      inputSchema: browserToolInput({
        areaId: z.string().describe('Scrollable area id from current scrollableAreas, such as S1, S2, or S3.'),
        deltaY: z.number().describe('Vertical scroll delta. Positive scrolls down, negative scrolls up.'),
        deltaX: z.number().optional().describe('Horizontal scroll delta. Positive scrolls right, negative scrolls left.'),
      }),
      execute: (input) => record('scrollArea', input, () => session.scrollArea(input.areaId, input.deltaY, input.deltaX || 0)),
    }),
    clickCandidate: tool({
      description: 'Click a visible candidate by its numbered label from the current step screenshot snapshot. Choose the smallest/tightest candidate that directly encloses the intended visible text, icon, or control; avoid larger containing wrapper boxes. A successful tool result only confirms the click was delivered, not that the UI changed. The same visible target may be attempted at most twice because the first click can dismiss an overlay while the second activates the target. If text is provided, type it immediately after the click.',
      inputSchema: browserToolInput({
        id: z.string().describe('Candidate id such as 1 or 12. Must come from the current visual labels or interactive candidate list. Never choose a larger overlapping wrapper when a tighter candidate represents the same visible target.'),
        text: z.string().optional().describe('Optional text to type immediately after clicking, useful when the click focuses an input or editable control.'),
      }),
      execute: (input) => record('clickCandidate', input, () => session.clickCandidate(input.id, input.text)),
    }),
    hoverCandidate: tool({
      description: 'Move the mouse over a visible candidate by its numbered label. Use this to reveal hover menus, tooltips, dropdown panels, or controls that only appear on hover.',
      inputSchema: browserToolInput({
        id: z.string().describe('Candidate id such as 1 or 12. Must come from the current visual labels or interactive candidate list.'),
      }),
      execute: (input) => record('hoverCandidate', input, () => session.hoverCandidate(input.id)),
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
      }),
      execute: (input) => record('doubleClickCandidate', input, () => session.doubleClickCandidate(input.id)),
    }),
    rightClickCandidate: tool({
      description: 'Visual mode: right-click a visible candidate by its numbered label. The backend clicks the candidate visible center.',
      inputSchema: browserToolInput({
        id: z.string().describe('Candidate id such as 1 or 12. Must come from the current screenshot labels or interactive candidate list.'),
      }),
      execute: (input) => record('rightClickCandidate', input, () => session.rightClickCandidate(input.id)),
    }),
    dragCandidate: tool({
      description: 'Visual mode: drag from one numbered candidate center to another numbered candidate center.',
      inputSchema: browserToolInput({
        fromId: z.string().describe('Start candidate id such as 1.'),
        toId: z.string().describe('End candidate id such as 2.'),
      }),
      execute: (input) => record('dragCandidate', input, () => session.dragCandidate(input.fromId, input.toId)),
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
  stepIndex: number;
  beforeScreenshotPath: string;
  hasMarkerScreenshot?: boolean;
  markerOverlayInScreenshot?: boolean;
  availableScreenshotReferences?: ScreenshotReference[];
  selectedScreenshotReferences?: SelectedScreenshotReference[];
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
  const caseSystemPrompt = systemPromptOf(testCase);
  const requirement = requirementOf(testCase);
  const recentNotes = recentProgressNotes(completedSteps, 3);
  const recentScrollContinuity = recentScrollContinuityContext(completedSteps, 4);
  const runMemoryContext = formatRunMemory(completedSteps);
  const availableScreenshotReferences = input.availableScreenshotReferences || [];
  const selectedScreenshotReferences = input.selectedScreenshotReferences || [];
  const strategyMemory = (testCase.strategyMemory || [])
    .filter((hint) => !isInfrastructureNoise(hint))
    .map((hint) => concise(hint, 220))
    .slice(-4);
  const recentFailures = completedSteps
    .filter((step) => step.status === 'failed' || step.status === 'blocked')
    .filter((step) => !isInfrastructureNoise(`${step.action}\n${step.actual}`))
    .slice(-2)
    .map((step) => `Step ${step.index}: ${concise(step.action, 90)} -> ${concise(step.actual, 160)}`);
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
    ? '- Image 1 is the source of truth for what the page means. Image 2 only maps visible regions to candidate IDs.'
    : markerOverlayInScreenshot
      ? '- The attached screenshot is the source of truth and already contains marker labels overlaid on visible candidate regions.'
      : '- The attached screenshot is the source of truth for what the page means.';
  const markerTargetRules = mode === 'visual-markers' && attachScreenshot && markerEnabled
    ? [
        '',
        'Visual target selection and no-progress recovery:',
        markerSourceRule,
        '- A tool result with ok=true only confirms that the browser received the action. It does NOT prove the target was correct or that the page changed.',
        '- Candidate ids in attached reference screenshots are historical only. For the next action, use only ids that are visible in the current screenshot/marker map.',
        '- For overlapping boxes, choose the smallest/tightest box that directly encloses the intended visible text/icon/control.',
        '- Count repeated attempts by visible target + action, not only by id. After two ineffective attempts, choose another evidence-based path.',
        '- Never issue two clicks from one screenshot. Re-inspect the new screenshot before a second attempt.',
      ]
    : [];
  const modeActionRules = [
    '- Candidate IDs belong only to the CURRENT step screenshot snapshot. In visual-markers mode, every click/hover/drag id must be re-read from the current screenshot evidence; never carry over an id from a previous screenshot even if the visible control looks similar.',
    '- For text entry on a numbered candidate, use clickCandidate(id,text) in one tool call. Use typeText only after a fallback click already focused the field.',
    '- For hover-only menus, call hoverCandidate on the visible trigger, then act on the revealed target in the next step.',
    '- When the current screenshot/scrollableAreas show a scrollbar and the next needed content or control may be outside the visible area, consider scrollArea(areaId) instead of assuming the content is absent.',
    '- Green dashed S-labels mark scrollable regions. If a target likely belongs inside a table, list, panel, modal, or page viewport with more content, choose the relevant S area from current scrollableAreas.',
    '- Previous screenshots are not visible unless they are attached as selected references. Use current screenshot ids for actions; use selected references, Recent scroll continuity, pageScrollState, and scrollableAreas only as background context.',
  ];

  return [
    'You are an AI browser testing agent. You MUST call exactly ONE tool on every AI request. Use reportState when no browser action is needed.',
    `Requirement: ${requirement}`,
    `Target URL: ${testCase.targetUrl}`,
    `Target host: ${targetHost}`,
    `Current URL: ${pageContext.url}`,
    '',
    'Hard rules:',
    '- Call exactly ONE tool. Extra tool calls are ignored. Never respond with only text or only JSON.',
    '- All user-facing tool fields must be Chinese.',
    '- You are both a test executor and a continuous AI browser assistant; every tool call must include reason, observation, findings, and memory.',
    '- Record visible product errors, requirements, business rules, warnings, state changes, and constraints in findings or memory even when the flow can continue.',
    `- Use ${evidence} as the current page state.`,
    '- Use recent notes/tools as attempt memory. The same visible target and action may be tried at most twice; after two ineffective attempts, do not repeat it again.',
    '- Failure self-healing: when the previous action did not visibly change the page, do not repeat the same visible target again. Re-observe the page and choose a different selector, a tighter child candidate, keyboard input, scrolling, hover, tab switching, or a different navigation path.',
    '- Do not mark the run failed just because one action failed. First try a reasonable corrective path unless the page is unreachable, the requirement is impossible, or manual verification is required.',
    '- If a historical strategy hint conflicts with the current screenshot, trust the current screenshot and explain the updated choice in reason.',
    '- If a white mouse-pointer marker is visible in the screenshot, it indicates the last browser action location only. Do not treat it as a page control, candidate marker, tooltip, cursor state, or evidence that the target remains selected.',
    '- If recent progress notes contain "[完成校验未通过]", do not finish again immediately. Re-observe the new screenshot; a previously attempted visual target may be tried only if it has fewer than two attempts and the screenshot shows a plausible overlay-dismissal or state-change reason. Otherwise perform a different corrective action.',
    '- If page is loading/transitioning, call waitForPage once.',
    ...modeActionRules,
    '- After a click may open a tab/window, call listTabs; switchTab if the relevant page is in another tab.',
    '- Block only for empty captcha/OTP/security/manual verification. If captchaAppearsFilled=true, submit/login and continue.',
    '- If the current page requires user-side captcha/OTP/security/manual verification, call waitForHumanVerification. It pauses the run for user intervention and no further AI tool should be requested from that screenshot.',
    '- Finish only when EVERY requirement clause is satisfied; use reportState with done=true/status=passed. Otherwise call one more useful browser tool or reportState with done=false when only recording observations.',
    attachScreenshot
      ? separateMarkerScreenshot
        ? '- Visual mode: image 1 is the clean viewport screenshot. Image 2 is a pixel-aligned marker map containing numbered candidate outlines. Understand the page from image 1, then choose a candidate ID from image 2. getInteractiveCandidates/getDomTree are unavailable.'
        : markerOverlayInScreenshot
          ? '- Visual mode: the attached screenshot is the current page with marker labels overlaid. Marker numbers may appear as white text with a dark shadow and no filled background. Choose a numbered candidate id from the screenshot. getInteractiveCandidates/getDomTree are unavailable.'
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
    '- Always call exactly ONE tool.',
    '- To act: call exactly ONE browser tool and include reason/observation/findings/memory grounded in current context.',
    '- For clickCandidate/hoverCandidate, reason must name the visible control, explain why this is the most specific current candidate, and state the expected observable page change.',
    '- Tool arguments must carry assistant state: reason, observation, findings, memory. Use "无" for empty findings/memory.',
    '- To finish/block/fail or only record an observation, call reportState. Do not return standalone JSON.',
    '- To inspect earlier scroll positions on the NEXT request, call selectReferenceScreenshots with ids from Available previous screenshot references. Its result is text only; selected images are attached on the next AI request.',
    '',
    'Current context:',
    `Open tabs JSON: ${JSON.stringify(pageContext.tabs)}`,
    `Page scroll state JSON: ${JSON.stringify(pageContext.pageScrollState)}`,
    `Scrollable areas JSON: ${JSON.stringify(pageContext.scrollableAreas)}`,
    visualMode ? '' : `Focused element JSON: ${JSON.stringify(pageContext.focusedElement)}`,
    visualMarkersWithoutOverlay ? `Visible interactive elements:
${candidateContext}` : '',
    visualMode ? '' : `Interactive candidates JSON:
${candidateContext}`,
    visualMode ? '' : `Simplified DOM tree:
${domTree}`,
    `Recent progress notes (last 3, oldest first):
${recentNotes.join('\n') || '[none]'}`,
    recentFailures.length ? `Recent business failed/blocked steps:
${recentFailures.join('\n')}` : '',
    `Recent scroll continuity:
${recentScrollContinuity.join('\n') || '[none]'}`,
    `Available previous screenshot references (text index only; not images unless selected):
${formatScreenshotReferences(availableScreenshotReferences)}`,
    `Selected reference screenshots attached after the current screenshot images:
${formatScreenshotReferences(selectedScreenshotReferences)}`,
    selectedScreenshotReferences.length
      ? 'Reference screenshot rule: selected reference images help connect scroll continuity or compare earlier page state. They may show the same interface at different scroll offsets when sameInterfaceGroup matches, but their candidate ids are historical and must never be used for the current action.'
      : '',
    runMemoryContext,
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
      .filter(([key, value]) => key !== 'reason' && value !== undefined && value !== null && value !== '')
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

function extractAssistantStepInfoFromToolInputs(traces: ToolTrace[]): Pick<RuntimeDecision, 'observation' | 'findings' | 'memoryItems'> {
  const observations: string[] = [];
  const findings: string[] = [];
  const memoryItems: string[] = [];
  for (const trace of traces) {
    if (!trace.input || typeof trace.input !== 'object' || Array.isArray(trace.input)) continue;
    const input = trace.input as Record<string, unknown>;
    if (typeof input.observation === 'string' && input.observation.trim() && !/^无$|^none$/i.test(input.observation.trim())) {
      observations.push(input.observation.trim());
    }
    if (typeof input.findings === 'string') findings.push(...parseListLike(input.findings));
    if (typeof input.memory === 'string') memoryItems.push(...parseListLike(input.memory));
  }
  return {
    observation: observations.length ? observations.at(-1)?.slice(0, 800) : undefined,
    findings: Array.from(new Set(findings)).slice(0, 8),
    memoryItems: Array.from(new Set(memoryItems)).slice(0, 8),
  };
}

function deriveDecision(text: string, traces: ToolTrace[]): RuntimeDecision {
  // When a tool actually executed this step, the step result is derived from the action itself. We
  // never trust JSON done/status in the same response as a tool call, so the model cannot accidentally
  // declare the requirement complete before seeing the next screenshot.
  if (traces.length > 0) {
    const executed = traces.filter((trace) => trace.name);
    const last = executed.at(-1);
    const failed = executed.find((trace) => !trace.result.ok);
    const names = executed.map((trace) => `${trace.name}${summarizeToolInput(trace.input)}`).join('; ');
    const note = extractProgressNote(text);
    const assistantInfo = extractAssistantStepInfoFromToolInputs(executed);
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
  onToolTrace?: (trace: ToolTrace) => void | Promise<void>;
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
    const requestPrompt = codexMode ? buildCodexObjectPrompt(prompt, allowedToolTypes) : prompt;
    const visualContext = new VisualContextManager();
    visualContext.init({ path: beforeScreenshotPath, markerPath: markerScreenshotPath, stepIndex, capture: 'viewport', reason: 'Initial current screenshot for this agent loop' });
    let workingMemory: RuntimeWorkingMemory = {
      taskGoal: requirementOf(testCase), phase: 'Entering Agent Loop; choose one tool from the current visual frame.', completed: [], findings: [], blockers: [],
      pageUnderstanding: '', scrollSummary: '', userConstraints: systemPromptOf(testCase) ? [systemPromptOf(testCase)] : [], nextStep: 'Choose one tool from the current visual context.',
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
      const buildContextText = () => {
        const compressionNote = compressionDetails
          ? [
              'Context budget manager:',
              `- Estimated context exceeded ${Math.round(Number(compressionDetails.thresholdRatio) * 100)}%; historical visual frames and working memory were compressed.`,
              '- This request is a fresh dialogue turn built from current visual context, compact memory, and recent tool summaries.',
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
          message: `Context estimate ${estimatedTokens}/${windowTokens} tokens after compression; opened fresh prepareStep turn ${contextCompressionTurns}.`,
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
      const result = await generateObjectWithTimeout({ model: getModel(), messages: await prepareStep(0), schema: codexRuntimeObjectSchema, temperature: 0.1, maxRetries: 0, abortSignal });
      const object = result.object as z.infer<typeof codexRuntimeObjectSchema>;
      const execution = await executeCodexRuntimeObject({ session, targetUrl: testCase.targetUrl, stepIndex, type: object.type, params: object.params, allowedTypes: allowedToolTypes, traces, onToolTrace, onSelectReferenceScreenshots: async (selection) => { const validIds = selection.ids.filter((id) => availableReferenceIds.has(id)); await onSelectReferenceScreenshots?.({ ...selection, ids: validIds, availableReferences: availableScreenshotReferences }); } });
      await onDebug?.({ phase: 'ai:runtime:object', stepIndex, message: 'Codex object -> ' + object.type + '; AI+tool ' + elapsedSince(aiStartedAt) + 'ms', details: jsonSafe({ object, traces, elapsedMs: elapsedSince(aiStartedAt) }) });
      return { text: execution.text, traces, aiRequest, visualContext: visualContext.snapshot(), workingMemory };
    }

    const maxTurns = Math.max(1, Number(process.env.AI_AGENT_LOOP_MAX_TURNS || process.env.AI_TEST_AGENT_MAX_STEPS || 6));
    for (let turnIndex = 0; turnIndex < maxTurns; turnIndex += 1) {
      const aiStartedAt = Date.now();
      const traceStart = traces.length;
      try {
        const result = await generateTextWithTimeout({
          model: getModel(), messages: await prepareStep(turnIndex),
          tools: makeBrowserTools(session, testCase.targetUrl, mode, traces, async (trace) => { workingMemory = updateWorkingMemoryFromTrace(workingMemory, trace); await onToolTrace?.(trace); await onDebug?.({ phase: 'ai:tool', stepIndex, message: trace.name + ' -> ' + (trace.result.ok ? 'ok' : 'failed'), details: { trace, visualContext: visualContext.snapshot(), workingMemory } }); }, { availableReferenceIds, runId: input.runId, stepIndex, visualContext, onVisualContextChange: async (snapshot) => { await onDebug?.({ phase: 'ai:visual-context', stepIndex, message: 'Visual Context Manager updated.', details: snapshot }); }, onSelectReferenceScreenshots: async (selection) => { await onSelectReferenceScreenshots?.({ ...selection, availableReferences: availableScreenshotReferences }); } }),
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

  // Only retry when nothing executed yet (pure request failure). The runAgent catch above guarantees
  // a retry can never re-run an already-executed browser action.
  const attempts = screenshot ? [true, true] : [false];
  let lastError: unknown;

  for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
    const includeImage = attempts[attemptIndex];
    try {
      if (attemptIndex > 0) {
        await onDebug?.({
          phase: 'ai:runtime:retry',
          stepIndex,
                    message: 'AI request failed before any tool executed; retrying once.',
          details: lastError instanceof Error ? lastError.message : String(lastError),
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

function infrastructureError(error: unknown) {
  if (!(error instanceof Error)) return 'Unknown execution error';
  return error.message;
}

function serializeError(error: unknown) {
  if (!(error instanceof Error)) return { message: String(error) };
  return {
    name: error.name,
    message: error.message,
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
}): Promise<StepExecutionResult> {
  const { session, runId, stepIndex, beforeScreenshotPath, error, tools, aiRequest } = input;
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

async function waitAfterRecordedTool(session: BrowserSession) {
  await session.waitForPage().catch(() => undefined);
  const configuredDelay = Number(process.env.REPLAY_STEP_DELAY_MS || 0);
  const delayMs = Number.isFinite(configuredDelay) ? configuredDelay : 0;
  if (delayMs > 0) await session.wait(delayMs).catch(() => undefined);
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
      return session.scrollArea(
        String(input.areaId || ''),
        typeof input.deltaY === 'number' ? input.deltaY : 0,
        typeof input.deltaX === 'number' ? input.deltaX : 0,
      );
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
  stepIndex: number;
  type: string;
  params: Record<string, unknown>;
  allowedTypes: string[];
  traces: ToolTrace[];
  onToolTrace?: (trace: ToolTrace) => void | Promise<void>;
  onSelectReferenceScreenshots?: (selection: {
    ids: string[];
    selectionReason: string;
    sameInterfaceGroup?: string;
  }) => void | Promise<void>;
}) {
  const { session, targetUrl, stepIndex, type, params, allowedTypes, traces, onToolTrace, onSelectReferenceScreenshots } = input;
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

  const result = await runRecordedTool(session, targetUrl, {
    index: stepIndex,
    name: type,
    input: params,
    reason: typeof params.reason === 'string' ? params.reason : undefined,
  });
  const trace = { name: type, input: params, result };
  traces.push(trace);
  await onToolTrace?.(trace);
  return { text: '', executed: true };
}

async function executeRecordedFlow(testCase: TestCaseRecord, runId: string, recordedFlow: RecordedFlowStep[], options: ExecutionOptions) {
  const {
    onProgress,
    onDebug,
    shouldSkipStep,
    shouldPauseRun,
    onPaused,
    onResumed,
  } = options;
  const session = new BrowserSession(browserModeOf(testCase), { isMarked: visualMarkersEnabledFor(testCase) });
  const steps: StepExecutionResult[] = [];
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

  try {
    await onDebug?.({ phase: 'recorded:start', message: `Using recorded flow with ${recordedFlow.length} tool calls; AI runtime requests are skipped.` });
    await session.start();

    for (let index = 0; index < recordedFlow.length; index += 1) {
      const flow = recordedFlow[index];
      const stepIndex = index + 1;
      await waitWhilePaused(stepIndex);

      if (await shouldSkipStep?.(stepIndex)) {
        const skippedStep = createSkippedStep(stepIndex);
        steps.push(skippedStep);
        await onProgress?.(skippedStep);
        continue;
      }

      const beforeScreenshotPath = await session.takeScreenshot(runId, stepIndex, 'before');
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
  const session = new BrowserSession(runtimeMode, { isMarked: visualMarkersEnabledFor(testCase) });
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
        onToolTrace: async (trace) => {
          liveToolTraces.push(trace);
          await onProgress?.({
            ...runningStep,
            beforeScreenshotPath,
                          actual: 'AI called a browser tool; waiting for page feedback.',
            tools: summarizeToolTraces(liveToolTraces),
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

      let decision = normalizeRuntimeDecision(deriveDecision(actionResult.text, actionResult.traces));

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
