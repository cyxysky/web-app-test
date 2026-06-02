import { readFile } from 'node:fs/promises';
import { generateText, stepCountIs, tool } from 'ai';
import sharp from 'sharp';
import { z } from 'zod';
import type { AiRequestSnapshot, RecordedFlowStep, StepExecutionResult, StepToolCall, TestCaseRecord } from '@/server/ai/schemas/test-case.schema';
import { getModel, getModelSettings } from '@/server/ai/model';
import { clearStepAbortController, registerStepAbortController } from '@/server/ai/run-control.registry';
import { BrowserSession, type BrowserActionResult } from '@/server/browser/browser-session';
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
};

type RuntimeDecision = {
  action: string;
  expected: string;
  actual: string;
  status: 'passed' | 'failed' | 'blocked';
  done: boolean;
  note?: string;
};

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

function isVisualClickMode() {
  const raw = process.env.isClick ?? process.env.IS_CLICK ?? process.env.AI_BROWSER_MODE;
  return /^(true|1|yes|visual|vision|click)$/i.test(String(raw || ''));
}

// 只有视觉点击模式才允许把截图作为 AI 输入；DOM 模式即使模型支持图片也不会发送。
function shouldSendScreenshotToAi() {
  return isVisualClickMode() && modelSupportsScreenshotInput();
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

function trimDebugText(value: string, max = 4000) {
  return value.length > max ? `${value.slice(0, max)}...` : value;
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
      result: trimDebugText(trace.result.actual, 800),
    };
  });
}

function recentToolCallContext(steps: StepExecutionResult[], limit = 5) {
  const calls = steps.flatMap((step) => (step.tools || []).map((tool) => ({
    name: tool.name,
    input: tool.input,
    reason: tool.reason,
    result: { ok: tool.ok, actual: tool.result },
  })));
  return calls.slice(-limit);
}

function recentProgressNotes(steps: StepExecutionResult[], limit = 5) {
  return steps
    .filter((step) => step.note && step.note.trim())
    .slice(-limit)
    .map((step) => `Step ${step.index}: ${step.note}`);
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

function makeBrowserTools(
  session: BrowserSession,
  targetUrl: string,
  traces: ToolTrace[],
  onToolTrace?: (trace: ToolTrace) => void | Promise<void>,
) {
  // Enforce a single executed tool per AI request. makeBrowserTools is created fresh for each
  // request, so this flag guarantees that even if the model emits several tool calls in one
  // response (parallel/chained), only the first one actually runs. The rest are ignored, which
  // keeps every browser action paired with a fresh screenshot on the next step and prevents the
  // duplicate-operation problem seen when a request was retried mid-chain.
  let toolExecutedThisRequest = false;
  const toolReasonInput = z.string().min(1).max(300).describe('Required: concise reason for this exact tool call, based on the current page context, requirement, and recent progress.');

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
    const trace = { name, input, result };
    traces.push(trace);
    await onToolTrace?.(trace);
    return result;
  }

  const sharedTools = {
    openPage: tool({
      description: 'Open or navigate to a URL in the browser.',
      inputSchema: z.object({
        reason: toolReasonInput,
        url: z.string().optional().describe('The URL to open. Defaults to the test target URL.'),
      }),
      execute: ({ url, reason }) => record('openPage', { url, reason }, () => session.open(url || targetUrl)),
    }),
    scrollViewport: tool({
      description: 'Scroll a selected scroll container. Pass domPath for the table/list/panel or one of its visible children. Use this for virtual scroll containers instead of blindly scrolling the page.',
      inputSchema: z.object({
        reason: toolReasonInput,
        deltaY: z.number().describe('Vertical scroll delta. Positive scrolls down, negative scrolls up.'),
        deltaX: z.number().optional().describe('Horizontal scroll delta.'),
        domPath: z.string().optional().describe('Bracket path for the scrollable element or one of its children, such as 0.1.2.'),
      }),
      execute: ({ deltaY, deltaX, domPath, reason }) => record('scrollViewport', { deltaY, deltaX, domPath, reason }, () => session.scroll(deltaY, deltaX || 0, { domPath })),
    }),
    clickCandidate: tool({
      description: 'Click a visible candidate by its numbered label from the current candidate list or visual labels. If text is provided, type it immediately after the click.',
      inputSchema: z.object({
        reason: toolReasonInput,
        id: z.string().describe('Candidate id such as 1, 12. Must come from the current visual labels or interactive candidate list.'),
        text: z.string().optional().describe('Optional text to type immediately after clicking, useful when the click focuses an input or editable control.'),
      }),
      execute: ({ id, text, reason }) => record('clickCandidate', { id, text, reason }, () => session.clickCandidate(id, text)),
    }),
    focusCandidate: tool({
      description: 'Focus a visible input/control candidate by its numbered label. If text is provided, type it immediately after focusing.',
      inputSchema: z.object({
        reason: toolReasonInput,
        id: z.string().describe('Candidate id such as 1, 12. Must come from the current visual labels or interactive candidate list.'),
        text: z.string().optional().describe('Optional text to type immediately after focusing the input or editable control.'),
      }),
      execute: ({ id, text, reason }) => record('focusCandidate', { id, text, reason }, () => session.focusCandidate(id, text)),
    }),
    hoverCandidate: tool({
      description: 'Move the mouse over a visible candidate by its numbered label. Use this to reveal hover menus, tooltips, dropdown panels, or controls that only appear on hover.',
      inputSchema: z.object({
        reason: toolReasonInput,
        id: z.string().describe('Candidate id such as 1, 12. Must come from the current visual labels or interactive candidate list.'),
      }),
      execute: ({ id, reason }) => record('hoverCandidate', { id, reason }, () => session.hoverCandidate(id)),
    }),
    typeText: tool({
      description: 'Type text into the currently focused element. First use focusCandidate/clickCandidate or focusDomNode to focus the intended field.',
      inputSchema: z.object({
        reason: toolReasonInput,
        text: z.string().describe('Text to enter.'),
      }),
      execute: ({ text, reason }) => record('typeText', { text, reason }, () => session.typeText(text)),
    }),
    pressKey: tool({
      description: 'Press a keyboard key on the currently focused element or page.',
      inputSchema: z.object({
        reason: toolReasonInput,
        key: z.string().describe('Keyboard key, for example Enter, Escape, Tab.'),
      }),
      execute: ({ key, reason }) => record('pressKey', { key, reason }, () => session.press(key)),
    }),
    waitForPage: tool({
      description: 'Wait for the page to settle after navigation or UI changes.',
      inputSchema: z.object({
        reason: toolReasonInput,
        ms: z.number().optional().describe('Optional wait time in milliseconds.'),
      }),
      execute: ({ ms, reason }) => record('waitForPage', { ms, reason }, () => (ms ? session.wait(ms) : session.waitForPage())),
    }),
    waitForHumanVerification: tool({
      description: 'Wait while the user completes a visible CAPTCHA, login verification, or security check in the non-headless browser.',
      inputSchema: z.object({
        reason: toolReasonInput,
        maxMs: z.number().optional().describe('Maximum wait time in milliseconds. Defaults to MANUAL_VERIFICATION_TIMEOUT_MS or 180000.'),
      }),
      execute: ({ maxMs, reason }) => record('waitForHumanVerification', { maxMs, reason }, () => session.waitForManualVerification(maxMs)),
    }),
    listTabs: tool({
      description: 'List all currently open browser tabs with their index and URL.',
      inputSchema: z.object({
        reason: toolReasonInput,
      }),
      execute: (input) => record('listTabs', input, () => session.listTabs()),
    }),
    switchTab: tool({
      description: 'Switch to a browser tab by index when the workflow opened a new tab.',
      inputSchema: z.object({
        reason: toolReasonInput,
        index: z.number().describe('The tab index from listTabs.'),
      }),
      execute: ({ index, reason }) => record('switchTab', { index, reason }, () => session.switchTab(index)),
    }),
  };

  const domTools = {
    getInteractiveCandidates: tool({
      description: 'Fallback only (DOM mode): return visible interactable candidates as JSON when the candidate context needs refresh. Each candidate has id (1...), tag/role/name/text, href/host, visible box/center, and nearbyText.',
      inputSchema: z.object({
        reason: toolReasonInput,
      }),
      execute: (input) => record('getInteractiveCandidates', input, () => session.getInteractiveCandidates()),
    }),
    getDomTree: tool({
      description: 'Return the current tab simplified DOM tree of currently visible elements. Each line is "[path] tag#id.class * @x,y,w,h {attrs} \\"text\\"": "*" marks clickable elements, @ is the visible viewport box, {attrs} holds key attributes (placeholder/aria-label/role/href/value...), and "text" is the node\'s own text. Hidden nodes are removed, so paths line up with what is on screen.',
      inputSchema: z.object({
        reason: toolReasonInput,
      }),
      execute: (input) => record('getDomTree', input, () => session.getSimplifiedDomTree()),
    }),
    clickDomNode: tool({
      description: 'Fallback only: click a node from the simplified DOM tree by its bracket path, for example "0.1.2". Prefer clickCandidate when a numbered candidate exists.',
      inputSchema: z.object({
        reason: toolReasonInput,
        path: z.string().describe('The bracket path shown in the simplified DOM tree, such as 0.1.2.'),
      }),
      execute: ({ path, reason }) => record('clickDomNode', { path, reason }, () => session.clickDomNode(path)),
    }),
    focusDomNode: tool({
      description: 'Fallback only: focus a node from the simplified DOM tree by its bracket path before typing. Prefer focusCandidate when a numbered candidate exists.',
      inputSchema: z.object({
        reason: toolReasonInput,
        path: z.string().describe('The bracket path shown in the simplified DOM tree, such as 0.1.2.'),
      }),
      execute: ({ path, reason }) => record('focusDomNode', { path, reason }, () => session.focusDomNode(path)),
    }),
  };

  const visualTools = {
    doubleClickCandidate: tool({
      description: 'Visual mode: double-click a visible candidate by its numbered label. The backend clicks the candidate visible center.',
      inputSchema: z.object({
        reason: toolReasonInput,
        id: z.string().describe('Candidate id such as 1, 12. Must come from the current screenshot labels or interactive candidate list.'),
      }),
      execute: ({ id, reason }) => record('doubleClickCandidate', { id, reason }, () => session.doubleClickCandidate(id)),
    }),
    rightClickCandidate: tool({
      description: 'Visual mode: right-click a visible candidate by its numbered label. The backend clicks the candidate visible center.',
      inputSchema: z.object({
        reason: toolReasonInput,
        id: z.string().describe('Candidate id such as 1, 12. Must come from the current screenshot labels or interactive candidate list.'),
      }),
      execute: ({ id, reason }) => record('rightClickCandidate', { id, reason }, () => session.rightClickCandidate(id)),
    }),
    dragCandidate: tool({
      description: 'Visual mode: drag from one numbered candidate center to another numbered candidate center.',
      inputSchema: z.object({
        reason: toolReasonInput,
        fromId: z.string().describe('Start candidate id such as 1.'),
        toId: z.string().describe('End candidate id such as 2.'),
      }),
      execute: ({ fromId, toId, reason }) => record('dragCandidate', { fromId, toId, reason }, () => session.dragCandidate(fromId, toId)),
    }),
  };

  return isVisualClickMode() ? { ...sharedTools, ...visualTools } : { ...sharedTools, ...domTools };
}

// 构造完成判定规则；视觉模式用截图作证据，DOM 模式用文本化页面上下文作证据。
function buildCompletionPromptLines(requirement: string, usesScreenshot = shouldSendScreenshotToAi()) {
  const evidence = usesScreenshot ? 'screenshot' : 'textual page context / candidates / DOM / URL / focus';
  return [
    'Completion rules:',
    `- Requirement: ${requirement}`,
    `- done=true only when EVERY requirement clause is proven by ${evidence}. Partial progress is not completion.`,
    '- If anything is still missing or uncertain, call one more tool instead of finishing.',
    '- status=blocked only for manual verification/security/login wait; blocked must use done=false.',
    '- status=failed only when the requirement is clearly impossible or failed end-to-end.',
  ];
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
  const attachScreenshot = shouldSendScreenshotToAi();
  const prompt = [
    'You are an independent completion judge. The executor agent claims the user requirement is FULLY complete.',
    attachScreenshot
      ? 'Verify using ONLY the attached viewport screenshot and the requirement text. Be strict — partial progress is NOT complete.'
      : 'Verify using ONLY the textual browser context and the requirement text. No screenshot image is attached because visual mode is disabled. Be strict — partial progress is NOT complete.',
    '',
    `User requirement (every clause must be visibly satisfied for verified=true):\n${requirement}`,
    '',
    'Executor claim:',
    JSON.stringify(
      { action: proposed.action, expected: proposed.expected, actual: proposed.actual, status: proposed.status },
      null,
      2,
    ),
    '',
    `Current URL: ${pageContext.url}`,
    `Verification scan JSON: ${JSON.stringify(pageContext.manualVerification ?? null)}`,
    `Recent progress notes (oldest first):\n${recentProgressNotes(completedSteps, 5).join('\n') || '[none]'}`,
    '',
    'Rules:',
    attachScreenshot
      ? '- verified=true only if the screenshot clearly proves ALL parts of the requirement are done.'
      : '- verified=true only if the textual browser context clearly proves ALL parts of the requirement are done.',
    '- Empty captcha/OTP, login not finished, or waiting for user input → verified=false, status="blocked".',
    '- Wrong page or missing required outcome → verified=false; set remainingWork to concrete next steps.',
    '- If the requirement is visibly impossible, verified=true with status="failed" is allowed.',
    '',
    'Reply with JSON only (no tools):',
    '{ "verified": boolean, "status": "passed"|"failed"|"blocked", "summary": string, "remainingWork": string }',
    '- remainingWork: required when verified=false; list what the executor should do next (Chinese OK). Empty string when verified=true.',
  ].join('\n');

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
      summary: '完成校验响应无法解析，视为未完成并继续执行。',
      remainingWork: '根据截图与用户需求继续推进，直至全部条款在截图上可见完成。',
    };
  }
}

// 根据当前模式生成验证码/安全校验规则，DOM 模式不要求 AI 读取截图。
function buildVerificationPromptLines(pageContext: Awaited<ReturnType<BrowserSession['getPageContext']>>, usesScreenshot = shouldSendScreenshotToAi()) {
  const mv = pageContext.manualVerification;
  if (!mv?.detected && !mv?.captchaFields?.length) return [];
  const source = usesScreenshot ? 'screenshot' : 'page context';
  return [
    'Verification rules:',
    `- Verification scan: ${JSON.stringify(mv)}`,
    '- If captchaAppearsFilled=true, do not block; submit/login and continue.',
    `- If ${source} shows an empty captcha/OTP/security challenge that cannot proceed, return done=false status=blocked.`,
  ];
}

function runtimePrompt(input: {
  testCase: TestCaseRecord;
  pageContext: Awaited<ReturnType<BrowserSession['getPageContext']>>;
  completedSteps: StepExecutionResult[];
  stepIndex: number;
  beforeScreenshotPath: string;
  screenshotMetrics?: ReturnType<BrowserSession['getLastScreenshotMetrics']>;
}) {
  const { testCase, pageContext, completedSteps } = input;
  const targetHost = hostOf(testCase.targetUrl) || '[unknown target host]';
  const visualMode = isVisualClickMode();
  const attachScreenshot = shouldSendScreenshotToAi();
  const caseSystemPrompt = systemPromptOf(testCase);
  const requirement = requirementOf(testCase);
  const recentNotes = recentProgressNotes(completedSteps, 5);
  const recentTools = recentToolCallContext(completedSteps, 5);
  const domTree = visualMode ? '[disabled because visual mode is enabled]' : trimDebugText(pageContext.domTree || '[empty DOM tree]', 12000);
  const candidateLimit = Math.max(10, Number(process.env.SCREENSHOT_ELEMENT_LABEL_LIMIT || process.env.INTERACTIVE_CANDIDATE_LIMIT || 160));
  const candidateContext = visualMode ? '[disabled because visual mode uses screenshot labels]' : formatInteractiveCandidates(pageContext.interactiveCandidates, candidateLimit);
  const evidence = attachScreenshot ? 'the attached annotated screenshot' : 'Interactive candidates JSON, DOM tree, URL, tabs, and focused element';

  return [
    'You are an AI browser testing agent. Choose exactly ONE next browser action, or finish with JSON only when the full requirement is complete.',
    `Requirement: ${requirement}`,
    `Target URL: ${testCase.targetUrl}`,
    `Target host: ${targetHost}`,
    `Current URL: ${pageContext.url}`,
    '',
    'Hard rules:',
    '- Call at most ONE tool. Extra tool calls are ignored.',
    `- Use ${evidence} as the current page state.`,
    '- Do not repeat successful prior actions; use recent notes/tools to continue.',
    '- If page is loading/transitioning, call waitForPage once.',
    '- For text entry on a numbered candidate, prefer focusCandidate(id,text) or clickCandidate(id,text) in one tool call. Use typeText only after a DOM-path focus fallback.',
    '- For hover-only menus, call hoverCandidate on the visible trigger, then act on the revealed target in the next step.',
    '- For scrollable tables/lists/panels, call scrollViewport with the relevant domPath when available.',
    '- After a click may open a tab/window, call listTabs; switchTab if the relevant page is in another tab.',
    '- Block only for empty captcha/OTP/security/manual verification. If captchaAppearsFilled=true, submit/login and continue.',
    '- Finish only when EVERY requirement clause is satisfied; otherwise call one more useful tool.',
    attachScreenshot
      ? '- Visual mode: use screenshot number labels as primary targets. getInteractiveCandidates/getDomTree are unavailable.'
      : '- DOM mode: no screenshot image/path is attached. Use candidates first; use DOM tree as fallback. Do not infer from screenshots.',
    caseSystemPrompt ? `Test-case-specific instructions:
${caseSystemPrompt}` : '',
    '',
    ...buildVerificationPromptLines(pageContext, attachScreenshot),
    ...buildCompletionPromptLines(requirement, attachScreenshot),
    '',
    'Response:',
    '- To act: call exactly ONE tool and include reason grounded in current context.',
    '- When acting, also output: PROGRESS: <what changed / observed> NEXT: <next intended action>.',
    '- To finish/block/fail: call NO tool and return JSON: {"action":string,"expected":string,"actual":string,"status":"passed"|"failed"|"blocked","done":true}.',
    '',
    'Current context:',
    `Open tabs JSON: ${JSON.stringify(pageContext.tabs)}`,
    `Focused element JSON: ${JSON.stringify(pageContext.focusedElement)}`,
    `Interactive candidates JSON:
${candidateContext}`,
    `Simplified DOM tree:
${domTree}`,
    `Recent progress notes (last 5, oldest first):
${recentNotes.join('\n') || '[none]'}`,
    `Recent tool calls (last 5, oldest first):
${JSON.stringify(recentTools, null, 2)}`,
    attachScreenshot
      ? 'Screenshot image is attached.'
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

function runtimeToolNames() {
  const tools = [
    'openUrl',
    'waitForPage',
    'listTabs',
    'switchTab',
    'clickCandidate',
    'focusCandidate',
    'hoverCandidate',
    'doubleClickCandidate',
    'rightClickCandidate',
    'dragCandidate',
    'typeText',
    'pressKey',
    'scrollViewport',
  ];
  if (isVisualClickMode()) return tools;
  return [...tools, 'getInteractiveCandidates', 'getDomTree', 'clickDomNode', 'focusDomNode'];
}

// 记录一次 AI 请求的可展示上下文；图片只在真实发送给 AI 时写入 messages。
function createAiRequestSnapshot(input: {
  kind: AiRequestSnapshot['kind'];
  stepIndex: number;
  prompt: string;
  screenshotPath?: string;
  imageAttached: boolean;
  tools?: string[];
  options?: Record<string, unknown>;
}): AiRequestSnapshot {
  const { provider, model } = getModelSettings();
  const imageContent = input.imageAttached && input.screenshotPath
    ? [{ type: 'image' as const, imagePath: input.screenshotPath, attached: true }]
    : [];
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

function deriveDecision(text: string, traces: ToolTrace[]): RuntimeDecision {
  // When a tool actually executed this step, the step result is derived from the action itself. We
  // never trust JSON done/status in the same response as a tool call, so the model cannot accidentally
  // declare the requirement complete before seeing the next screenshot.
  if (traces.length > 0) {
    const executed = traces.filter((trace) => trace.name);
    const last = executed.at(-1);
    const failed = executed.find((trace) => !trace.result.ok);
    const names = executed.map((trace) => `${trace.name}${summarizeToolInput(trace.input)}`).join('、');
    const note = extractProgressNote(text);
    const toolReason = executed.map((trace) => splitToolInputAndReason(trace.input).reason).find(Boolean);
    return {
      action: note || toolReason || `AI 执行操作：${names || last?.name || '浏览器操作'}`,
      expected: '本步操作推进用户需求；操作结果将在下一步的最新截图中确认。',
      actual: last?.result.actual || '已完成本步工具调用，等待下一步截图确认效果。',
      status: failed ? 'failed' : 'passed',
      done: false,
      note,
    };
  }

  // No tool executed: the model is reporting completion/blocked/failed via JSON.
  try {
    return z.object({
      action: z.string().min(1),
      expected: z.string().min(1),
      actual: z.string().min(1),
      status: z.enum(['passed', 'failed', 'blocked']),
      done: z.boolean(),
    }).parse(extractJson(text));
  } catch {
    return {
      action: 'AI 观察当前页面状态',
      expected: '本轮操作能够推进用户需求，或确认需求是否已经完成。',
      actual: text || 'AI 既没有调用工具，也没有返回可解析的步骤总结。',
      status: 'failed',
      done: false,
    };
  }
}

// 执行单个运行时步骤：采集页面上下文，调用 AI 选择一个动作，并记录请求快照。
async function executeRuntimeStep(input: {
  session: BrowserSession;
  testCase: TestCaseRecord;
  runId: string;
  stepIndex: number;
  beforeScreenshotPath: string;
  completedSteps: StepExecutionResult[];
  abortSignal?: AbortSignal;
  onDebug?: ExecutionDebug;
  onToolTrace?: (trace: ToolTrace) => void | Promise<void>;
}) {
  const { session, testCase, stepIndex, beforeScreenshotPath, completedSteps, abortSignal, onDebug, onToolTrace } = input;
  const pageContext = await session.getPageContext({
    includeDomTree: !isVisualClickMode(),
    includeText: false,
    includeManualVerification: false,
    useCachedInteractiveCandidates: true,
  });
  const prompt = runtimePrompt({
    testCase,
    pageContext,
    completedSteps,
    stepIndex,
    beforeScreenshotPath,
    screenshotMetrics: session.getLastScreenshotMetrics(),
  });
  const screenshot = shouldSendScreenshotToAi() ? await readScreenshotForAi(beforeScreenshotPath) : undefined;
  let lastAiRequest: AiRequestSnapshot | undefined;

  async function runAgent(includeImage: boolean) {
    const traces: ToolTrace[] = [];
    const messageContent: Array<{ type: 'text'; text: string } | { type: 'image'; image: Buffer }> = [{ type: 'text', text: prompt }];
    if (includeImage && screenshot) messageContent.push({ type: 'image', image: screenshot });
    const aiRequest = createAiRequestSnapshot({
      kind: 'runtime',
      stepIndex,
      prompt,
      screenshotPath: beforeScreenshotPath,
      imageAttached: Boolean(includeImage && screenshot),
      tools: runtimeToolNames(),
      options: {
        temperature: 0.1,
        maxRetries: 0,
        stopWhenStepCount: Number(process.env.AI_TEST_AGENT_MAX_STEPS || 1),
        includeImage,
        modelSupportsScreenshotInput: modelSupportsScreenshotInput(),
        screenshotInputEnabled: shouldSendScreenshotToAi(),
        visualClickMode: isVisualClickMode(),
      },
    });
    lastAiRequest = aiRequest;

    try {
      const result = await generateTextWithTimeout({
        model: getModel(),
        messages: [{ role: 'user', content: messageContent }],
        tools: makeBrowserTools(session, testCase.targetUrl, traces, async (trace) => {
          await onToolTrace?.(trace);
          await onDebug?.({
            phase: 'ai:tool',
            stepIndex,
            message: `${trace.name} -> ${trace.result.ok ? 'ok' : 'failed'}`,
            details: trace,
          });
        }),
        // One model round per step so each browser action is always paired with a fresh screenshot
        // on the next step. The record() guard additionally enforces a single executed tool.
        stopWhen: stepCountIs(Number(process.env.AI_TEST_AGENT_MAX_STEPS || 1)),
        temperature: 0.1,
        maxRetries: 0,
        abortSignal,
      });

      await onDebug?.({
        phase: 'ai:runtime:response',
        stepIndex,
        message: trimDebugText(result.text || 'AI 没有返回文本内容，仅完成了工具调用。', 300),
        details: jsonSafe({
          text: result.text || '',
          toolCalls: (result as unknown as { toolCalls?: unknown }).toolCalls,
          toolResults: (result as unknown as { toolResults?: unknown }).toolResults,
          steps: (result as unknown as { steps?: unknown }).steps,
          traces,
        }),
      });

      return { text: result.text || '', traces, aiRequest };
    } catch (error) {
      // If a browser tool already ran before the request failed (e.g. response/parse timeout after
      // the action completed), do NOT rethrow. Rethrowing would trigger a retry that re-executes the
      // same browser action — the exact duplicate-operation bug. Keep the executed result and let the
      // next step continue from the fresh screenshot.
      if (traces.length > 0 && !abortSignal?.aborted) {
        await onDebug?.({
          phase: 'ai:runtime:partial',
          stepIndex,
          message: 'AI 请求在工具执行后中断，已保留本步已执行的操作并继续下一步，不重试以避免重复操作。',
          details: { error: error instanceof Error ? error.message : String(error), traces },
        });
        return { text: '', traces, aiRequest };
      }
      if (error && typeof error === 'object') {
        (error as { aiRequest?: AiRequestSnapshot }).aiRequest = aiRequest;
      }
      throw error;
    }
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
          message: 'AI 请求失败且未执行任何操作，立即重试一次。',
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

function shouldKeepBrowserOpenAfterError(error: unknown) {
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
    expected: '当前步骤被手动跳过后，流程继续进入下一轮 AI 判断。',
    actual: '用户手动跳过了该步骤。',
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
    action: 'AI 本轮请求或响应处理失败，已自动继续下一轮',
    expected: '单次 AI 请求、工具调用或响应解析失败不应暂停测试流程；下一轮会基于最新浏览器截图继续判断。',
    actual: `${infrastructureError(error)}。本次失败已记录为可恢复失败，流程会继续；只有检测到真实验证或测试已完成时才会暂停或结束。`,
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
  const configuredDelay = Number(process.env.REPLAY_STEP_DELAY_MS || 1000);
  const delayMs = Number.isFinite(configuredDelay) ? configuredDelay : 1000;
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
    case 'clickCandidate':
      return session.clickCandidate(String(input.id || ''), text);
    case 'focusCandidate':
      return session.focusCandidate(String(input.id || ''), text);
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
      return session.focusDomNode(String(input.path || ''));
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
    case 'getInteractiveCandidates':
      return session.getInteractiveCandidates();
    case 'getDomTree':
      return session.getSimplifiedDomTree();
    default:
      return { ok: false, actual: `Unsupported recorded tool: ${flow.name}.${reason}` };
  }
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
  const session = new BrowserSession();
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
        expected: '固定流程工具应按录制时的参数成功执行。',
        actual: '正在执行录制工具调用。',
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
        expected: '固定流程工具应按录制时的参数成功执行。',
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
      expected: '录制的工具流程可以稳定回放。',
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
  const session = new BrowserSession();
  const steps: StepExecutionResult[] = [...(initialSteps || [])];
  // Each runtime step now performs a single browser action, so allow more steps overall.
  const maxRuntimeSteps = Number(process.env.AI_TEST_RUNTIME_MAX_STEPS || 30);
  const startStepIndex = Math.max(0, ...steps.map((step) => step.index)) + 1;
  const finalStepIndex = startStepIndex + maxRuntimeSteps - 1;
  const manuallyResumedSteps = new Set<number>();
  let keepBrowserOpen = false;
  let allowBrowserClose = false;

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
    await onDebug?.({ phase: 'browser:start', message: '正在启动可见浏览器' });
    await session.start();
    await onDebug?.({ phase: 'browser:ready', message: '浏览器已启动，AI 将根据用户需求动态决定每一步操作' });

    for (let stepIndex = startStepIndex; stepIndex <= finalStepIndex; stepIndex += 1) {
      await waitWhilePaused(stepIndex);
      const abortController = registerStepAbortController(runId, stepIndex);
      await onDebug?.({ phase: 'step:start', stepIndex, message: `开始运行时步骤 ${stepIndex}` });

      if (await shouldSkipStep?.(stepIndex)) {
        const skippedStep = createSkippedStep(stepIndex);
        steps.push(skippedStep);
        await onProgress?.(skippedStep);
        clearStepAbortController(runId, stepIndex);
        continue;
      }

      let beforeScreenshotPath = await session.takeScreenshot(runId, stepIndex, 'before');
      const runningStep: StepExecutionResult = {
        index: stepIndex,
        action: 'AI 正在根据用户需求和当前截图判断下一步',
        expected: 'AI 应调用浏览器工具推进需求，或判断需求已经完成。',
        actual: 'AI 正在观察页面、选择 E 标识并调用工具。',
        status: 'running',
        beforeScreenshotPath,
      };
      await onProgress?.(runningStep);
      await onDebug?.({ phase: 'step:before-screenshot', stepIndex, message: '已采集当前 viewport 截图' });

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
          message: '用户已确认人工介入完成；当前页仍命中验证特征，本轮不再重复弹出人工介入确认，继续交给 AI 基于新截图判断。',
          details: { url: pageContext.url, title: pageContext.title, screenshotPath: beforeScreenshotPath },
        });
      } else if (pageContext.isManualVerification) {
        const reason = '当前页面出现验证码、登录验证或安全校验，需要用户在可见浏览器中手动处理。';
        await onManualIntervention?.({ stepIndex, reason, screenshotPath: beforeScreenshotPath });
        await onDebug?.({
          phase: 'manual:required',
          stepIndex,
          message: '检测到需要用户介入的验证页面，运行已暂停，等待用户点击“执行完毕”。',
          details: { url: pageContext.url, title: pageContext.title, screenshotPath: beforeScreenshotPath },
        });
        await onProgress?.({
          ...runningStep,
          actual: `${reason} 完成后请回到运行报告点击“执行完毕”，AI 会立即重新观察页面并继续。`,
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
        await onDebug?.({ phase: 'manual:resumed', stepIndex, message: '用户确认验证已完成，立即重新采集截图并发起 AI 请求。' });
        manuallyResumedSteps.add(stepIndex);
        await session.waitForPage();
        await sleep(1200);
        beforeScreenshotPath = await session.takeScreenshot(runId, stepIndex, 'before');
        await onProgress?.({
          ...runningStep,
          beforeScreenshotPath,
          actual: '用户已完成验证，AI 正在基于新的页面截图继续执行。',
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
        abortSignal: abortController.signal,
        onDebug,
        onToolTrace: async (trace) => {
          liveToolTraces.push(trace);
          await onProgress?.({
            ...runningStep,
            beforeScreenshotPath,
            actual: 'AI 已调用浏览器工具，正在等待页面反馈。',
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
          message: '本轮 AI 请求或响应处理失败，已记录为失败步骤并继续下一轮。',
          details: {
            error: serializeError(error),
            screenshotPath: recoverableStep.screenshotPath,
            aiRequest: recoverableStep.aiRequest,
          },
        });
        clearStepAbortController(runId, stepIndex);
        await session.wait(500).catch(() => undefined);
        continue;
      }

      const afterScreenshotPath = await session.takeScreenshot(runId, stepIndex, 'after');
      await onDebug?.({ phase: 'step:after-screenshot', stepIndex, message: '已采集操作后 viewport 截图' });

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
            ? '完成校验通过，结束运行'
            : `完成校验未通过，继续执行：${verification.remainingWork || verification.summary}`,
          details: { verification, proposed: decision },
        });

        if (!verification.verified) {
          decision = {
            ...decision,
            done: false,
            status: verification.status === 'blocked' ? 'blocked' : 'passed',
            actual: `${decision.actual}\n\n[完成校验] ${verification.summary}${
              verification.remainingWork ? `\n待继续：${verification.remainingWork}` : ''
            }`,
            note: verification.remainingWork || verification.summary,
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
            message: '用户已确认人工介入完成；AI 仍返回验证阻塞，重新采集截图并重试本步骤，不终止运行、不二次弹出人工介入。',
            details: { decision, screenshotPath: afterScreenshotPath },
          });
          await onManualInterventionCleared?.(stepIndex);
          await session.waitForPage();
          await sleep(1200);
          clearStepAbortController(runId, stepIndex);
          stepIndex -= 1;
          continue;
        }

        const reason = decision.actual || 'AI 判断当前截图需要用户完成验证码、登录验证或安全校验。';
        await onManualIntervention?.({ stepIndex, reason, screenshotPath: afterScreenshotPath });
        await onDebug?.({
          phase: 'manual:ai-detected',
          stepIndex,
          message: 'AI 判断截图中存在需要人工介入的验证，运行已暂停。',
          details: { decision, screenshotPath: afterScreenshotPath },
        });
        await onProgress?.({
          ...runningStep,
          beforeScreenshotPath,
          afterScreenshotPath,
          screenshotPath: afterScreenshotPath,
          actual: `${reason} 完成后请回到运行报告点击“执行完毕”，AI 会立即重新请求并继续。`,
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
        await onDebug?.({ phase: 'manual:resumed', stepIndex, message: '用户确认验证已完成，立即重新发起本步骤 AI 请求。' });
        manuallyResumedSteps.add(stepIndex);
        await session.waitForPage();
        await sleep(1200);
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
        aiRequest: actionResult.aiRequest,
        beforeScreenshotPath,
        afterScreenshotPath,
        screenshotPath: afterScreenshotPath,
        tools: summarizeToolTraces(actionResult.traces),
      };
      steps.push(completedStep);
      await onProgress?.(completedStep);
      await onDebug?.({
        phase: 'step:done',
        stepIndex,
        message: `运行时步骤 ${stepIndex} 完成：${decision.status}${decision.done ? '，AI 判定需求已结束' : ''}`,
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
          },
        };
      }
    }

    const timeoutStep: StepExecutionResult = {
      index: steps.length + 1,
      action: '达到 AI 最大运行步数',
      expected: `AI 应在 ${maxRuntimeSteps} 步内完成或明确阻塞用户需求。`,
      actual: `已执行 ${maxRuntimeSteps} 个运行时步骤，但 AI 尚未判定需求完成。`,
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
      },
    };
  } catch (error) {
    keepBrowserOpen = shouldKeepBrowserOpenAfterError(error);
    const blockedStep: StepExecutionResult = {
      index: steps.length + 1,
      action: 'AI 浏览器运行中断',
      expected: 'AI 能够根据用户需求继续操作浏览器。',
      actual: `${infrastructureError(error)}${keepBrowserOpen ? '。浏览器已保留现场，便于继续排查。' : ''}`,
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
    await session.close({ keepOpen: keepBrowserOpen || !allowBrowserClose });
  }
}
