import { readFile } from 'node:fs/promises';
import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import type { StepExecutionResult, StepToolCall, TestCaseRecord } from '@/server/ai/schemas/test-case.schema';
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

function jsonSafe(value: unknown) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (Buffer.isBuffer(item)) return `[Buffer ${item.length} bytes]`;
    return item;
  }));
}

function trimDebugText(value: string, max = 4000) {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

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

function extractJson(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced?.[1] || text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('AI did not return JSON.');
  return JSON.parse(raw.slice(start, end + 1));
}

function requirementOf(testCase: TestCaseRecord) {
  return richTextToPlainText(testCase.content.userRequirement || testCase.description) || testCase.description || testCase.title;
}

function summarizeToolTraces(traces: ToolTrace[]): StepToolCall[] {
  return traces.map((trace) => ({
    name: trace.name,
    input: jsonSafe(trace.input),
    ok: trace.result.ok,
    result: trimDebugText(trace.result.actual, 800),
  }));
}

function recentToolCallContext(steps: StepExecutionResult[], limit = 8) {
  const calls = steps.flatMap((step) => (step.tools || []).map((tool) => ({
    name: tool.name,
    input: tool.input,
    result: { ok: tool.ok, actual: tool.result },
  })));
  return calls.slice(-limit);
}

function recentProgressNotes(steps: StepExecutionResult[], limit = 8) {
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

function formatInteractiveCandidates(candidates: unknown, limit = 80) {
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
        url: z.string().optional().describe('The URL to open. Defaults to the test target URL.'),
      }),
      execute: ({ url }) => record('openPage', { url }, () => session.open(url || targetUrl)),
    }),
    scrollViewport: tool({
      description: 'Scroll a selected scroll container. Pass domPath for the table/list/panel or one of its visible children. Use this for virtual scroll containers instead of blindly scrolling the page.',
      inputSchema: z.object({
        deltaY: z.number().describe('Vertical scroll delta. Positive scrolls down, negative scrolls up.'),
        deltaX: z.number().optional().describe('Horizontal scroll delta.'),
        domPath: z.string().optional().describe('Bracket path for the scrollable element or one of its children, such as 0.1.2.'),
      }),
      execute: ({ deltaY, deltaX, domPath }) => record('scrollViewport', { deltaY, deltaX, domPath }, () => session.scroll(deltaY, deltaX || 0, { domPath })),
    }),
    clickCandidate: tool({
      description: 'Click a visible candidate by its E-number label from the screenshot/candidate list. Prefer this over DOM paths because the backend validates and clicks the candidate center.',
      inputSchema: z.object({
        id: z.string().describe('Candidate id such as E1, E12. Must come from the current screenshot labels or interactive candidate list.'),
      }),
      execute: ({ id }) => record('clickCandidate', { id }, () => session.clickCandidate(id)),
    }),
    focusCandidate: tool({
      description: 'Focus a visible input/control candidate by its E-number label before typing. Prefer this over DOM paths for text entry.',
      inputSchema: z.object({
        id: z.string().describe('Candidate id such as E1, E12. Must come from the current screenshot labels or interactive candidate list.'),
      }),
      execute: ({ id }) => record('focusCandidate', { id }, () => session.focusCandidate(id)),
    }),
    typeText: tool({
      description: 'Type text into the currently focused element. First use focusCandidate/clickCandidate or focusDomNode to focus the intended field.',
      inputSchema: z.object({
        text: z.string().describe('Text to enter.'),
      }),
      execute: ({ text }) => record('typeText', { text }, () => session.typeText(text)),
    }),
    pressKey: tool({
      description: 'Press a keyboard key on the currently focused element or page.',
      inputSchema: z.object({
        key: z.string().describe('Keyboard key, for example Enter, Escape, Tab.'),
      }),
      execute: ({ key }) => record('pressKey', { key }, () => session.press(key)),
    }),
    waitForPage: tool({
      description: 'Wait for the page to settle after navigation or UI changes.',
      inputSchema: z.object({
        ms: z.number().optional().describe('Optional wait time in milliseconds.'),
      }),
      execute: ({ ms }) => record('waitForPage', { ms }, () => (ms ? session.wait(ms) : session.waitForPage())),
    }),
    waitForHumanVerification: tool({
      description: 'Wait while the user completes a visible CAPTCHA, login verification, or security check in the non-headless browser.',
      inputSchema: z.object({
        maxMs: z.number().optional().describe('Maximum wait time in milliseconds. Defaults to MANUAL_VERIFICATION_TIMEOUT_MS or 180000.'),
      }),
      execute: ({ maxMs }) => record('waitForHumanVerification', { maxMs }, () => session.waitForManualVerification(maxMs)),
    }),
    listTabs: tool({
      description: 'List all currently open browser tabs with their index and URL.',
      inputSchema: z.object({}),
      execute: (input) => record('listTabs', input, () => session.listTabs()),
    }),
    switchTab: tool({
      description: 'Switch to a browser tab by index when the workflow opened a new tab.',
      inputSchema: z.object({
        index: z.number().describe('The tab index from listTabs.'),
      }),
      execute: ({ index }) => record('switchTab', { index }, () => session.switchTab(index)),
    }),
  };

  const domTools = {
    getInteractiveCandidates: tool({
      description: 'Fallback only (DOM mode): return visible interactable candidates as JSON when the screenshot E labels are missing or stale. Each candidate has id (E1...), tag/role/name/text, href/host, visible box/center, and nearbyText.',
      inputSchema: z.object({}),
      execute: (input) => record('getInteractiveCandidates', input, () => session.getInteractiveCandidates()),
    }),
    getDomTree: tool({
      description: 'Return the current tab simplified DOM tree of currently visible elements. Each line is "[path] tag#id.class * @x,y,w,h {attrs} \\"text\\"": "*" marks clickable elements, @ is the visible viewport box, {attrs} holds key attributes (placeholder/aria-label/role/href/value...), and "text" is the node\'s own text. Hidden nodes are removed, so paths line up with what is on screen.',
      inputSchema: z.object({}),
      execute: (input) => record('getDomTree', input, () => session.getSimplifiedDomTree()),
    }),
    clickDomNode: tool({
      description: 'Fallback only: click a node from the simplified DOM tree by its bracket path, for example "0.1.2". Prefer clickCandidate when an E-number candidate exists.',
      inputSchema: z.object({
        path: z.string().describe('The bracket path shown in the simplified DOM tree, such as 0.1.2.'),
      }),
      execute: ({ path }) => record('clickDomNode', { path }, () => session.clickDomNode(path)),
    }),
    focusDomNode: tool({
      description: 'Fallback only: focus a node from the simplified DOM tree by its bracket path before typing. Prefer focusCandidate when an E-number candidate exists.',
      inputSchema: z.object({
        path: z.string().describe('The bracket path shown in the simplified DOM tree, such as 0.1.2.'),
      }),
      execute: ({ path }) => record('focusDomNode', { path }, () => session.focusDomNode(path)),
    }),
  };

  const visualTools = {
    doubleClickCandidate: tool({
      description: 'Visual mode: double-click a visible candidate by its E-number label. The backend clicks the candidate visible center.',
      inputSchema: z.object({
        id: z.string().describe('Candidate id such as E1, E12. Must come from the current screenshot labels or interactive candidate list.'),
      }),
      execute: ({ id }) => record('doubleClickCandidate', { id }, () => session.doubleClickCandidate(id)),
    }),
    rightClickCandidate: tool({
      description: 'Visual mode: right-click a visible candidate by its E-number label. The backend clicks the candidate visible center.',
      inputSchema: z.object({
        id: z.string().describe('Candidate id such as E1, E12. Must come from the current screenshot labels or interactive candidate list.'),
      }),
      execute: ({ id }) => record('rightClickCandidate', { id }, () => session.rightClickCandidate(id)),
    }),
    dragCandidate: tool({
      description: 'Visual mode: drag from one E-number candidate center to another E-number candidate center.',
      inputSchema: z.object({
        fromId: z.string().describe('Start candidate id such as E1.'),
        toId: z.string().describe('End candidate id such as E2.'),
      }),
      execute: ({ fromId, toId }) => record('dragCandidate', { fromId, toId }, () => session.dragCandidate(fromId, toId)),
    }),
  };

  return isVisualClickMode() ? { ...sharedTools, ...visualTools } : { ...sharedTools, ...domTools };
}

function buildCompletionPromptLines(requirement: string) {
  return [
    'Completion rules (done=true) — read carefully:',
    `- Full user requirement to satisfy:\n${requirement}`,
    '- Return JSON with done=true ONLY when EVERY part of the requirement above is visibly completed on the current screenshot — not one step, not halfway, not "in progress".',
    '- Partial progress is NOT completion. Examples that must stay done=false and keep using tools:',
    '  • Only opened the target site or logged in, but later steps in the requirement were not done.',
    '  • Only typed in search box but did not submit, or results not verified as required.',
    '  • Only clicked one item when the requirement asks to browse multiple items or confirm an outcome.',
    '  • Page looks "close enough" but a required assertion (specific text, element, URL, or state) is not yet visible.',
    '- Before done=true, mentally check off each clause in the requirement; if any clause is unchecked, call a tool for the next missing piece.',
    '- When unsure whether everything is done, default to done=false and take one more concrete action.',
    '- done=true with status="passed" only when the screenshot proves all requirement clauses succeeded.',
    '- done=true with status="failed" only when the requirement is impossible or clearly failed end-to-end; not because one sub-step failed while others remain undone.',
    '- NEVER use done=true together with status="blocked". Blocked means waiting for the user; the run must continue with done=false.',
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
  const prompt = [
    'You are an independent completion judge. The executor agent claims the user requirement is FULLY complete.',
    'Verify using ONLY the attached viewport screenshot and the requirement text. Be strict — partial progress is NOT complete.',
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
    `Recent progress notes (oldest first):\n${recentProgressNotes(completedSteps, 8).join('\n') || '[none]'}`,
    '',
    'Rules:',
    '- verified=true only if the screenshot clearly proves ALL parts of the requirement are done.',
    '- Empty captcha/OTP, login not finished, or waiting for user input → verified=false, status="blocked".',
    '- Wrong page or missing required outcome → verified=false; set remainingWork to concrete next steps.',
    '- If the requirement is visibly impossible, verified=true with status="failed" is allowed.',
    '',
    'Reply with JSON only (no tools):',
    '{ "verified": boolean, "status": "passed"|"failed"|"blocked", "summary": string, "remainingWork": string }',
    '- remainingWork: required when verified=false; list what the executor should do next (Chinese OK). Empty string when verified=true.',
  ].join('\n');

  const screenshot = modelSupportsScreenshotInput() ? await readFile(screenshotPath) : undefined;
  const messageContent: Array<{ type: 'text'; text: string } | { type: 'image'; image: Buffer }> = [
    {
      type: 'text',
      text: modelSupportsScreenshotInput()
        ? prompt
        : `${prompt}\n\nScreenshot file path (not attached): ${screenshotPath}`,
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

function buildVerificationPromptLines(pageContext: Awaited<ReturnType<BrowserSession['getPageContext']>>) {
  const mv = pageContext.manualVerification;
  if (!mv?.detected && !mv?.captchaFields?.length) return [];

  const lines = [
    'Verification / login page rules:',
    `Verification scan JSON: ${JSON.stringify(mv)}`,
  ];

  if (mv.captchaAppearsFilled) {
    lines.push(
      '- A captcha/OTP/verification-code input on the page ALREADY HAS TEXT (valueLength > 0). The human has entered the code.',
      '- Do NOT return status="blocked" or done=false because of captcha. Treat verification as handled.',
      '- Your next action should be: click the Login / 登录 / Submit / 确认 / 下一步 button, or press Enter in the code field, then continue the user requirement on the next screenshot.',
    );
  } else {
    lines.push(
      '- If the screenshot shows an EMPTY captcha/OTP input and login cannot proceed, return done=false with status="blocked" so the user can fill it manually.',
      '- If only a slider puzzle or image captcha is shown with no text field, return blocked for manual handling.',
    );
  }

  return lines;
}

function runtimePrompt(input: {
  testCase: TestCaseRecord;
  pageContext: Awaited<ReturnType<BrowserSession['getPageContext']>>;
  completedSteps: StepExecutionResult[];
  stepIndex: number;
  beforeScreenshotPath: string;
  screenshotMetrics?: ReturnType<BrowserSession['getLastScreenshotMetrics']>;
}) {
  const { testCase, pageContext, completedSteps, beforeScreenshotPath } = input;
  const targetHost = hostOf(testCase.targetUrl) || '[unknown target host]';
  const visualMode = isVisualClickMode();
  const candidateRules = [
    'Candidate grounding rules (screenshot-first):',
    '- The annotated screenshot is the PRIMARY and authoritative source for E ids. Colored boxes labeled E1, E2, ... mark visible leaf interactable elements. Blue = link, green = input/control, orange = generic clickable.',
    '- FIRST look at the screenshot and pick the E id that matches the visible target by position, label text, and context. Only if the screenshot shows no usable E label for that target, fall back to the Interactive candidates JSON below.',
    visualMode
      ? '- Visual mode: getInteractiveCandidates is NOT available. Never try to refresh candidates — trust the screenshot E labels and act with clickCandidate/focusCandidate/doubleClickCandidate/rightClickCandidate/dragCandidate.'
      : '- DOM mode fallback: if the screenshot shows no E label for the intended target, call getInteractiveCandidates once, then act. Do not call it repeatedly in a loop.',
    '- Prefer clickCandidate(id) or focusCandidate(id) over DOM paths whenever the intended target has an E id on the screenshot.',
    '- When the user requirement says 双击/double-click, use doubleClickCandidate(id) — NOT clickCandidate and NOT getInteractiveCandidates.',
    '- For links/search results, never choose by title text alone. Cross-check: screenshot label position + candidate text/name + href/host + nearbyText. If a candidate points to the wrong host/URL, do not click it even if its visible text looks right.',
    `- Target URL host is ${targetHost}; treat it as the starting page, not necessarily the final destination. When the user asks for a specific website/domain, prefer candidates whose href host exactly matches or is a credible subdomain of that requested site; avoid ads, mirrors, login traps, and unrelated search results.`,
  ];
  const domInteractionRules = [
    ...candidateRules,
    'DOM interaction rules:',
    '- You still receive the current screenshot. Use BOTH the screenshot and candidate list/DOM tree: screenshot decides what is visually present and intended; candidate id or DOM path is only the handle used to operate that visible element.',
    '- Prefer the Interactive candidates JSON over the full DOM tree. The full DOM tree is fallback context for containers and unusual widgets.',
    '- Use the provided simplified DOM tree and getDomTree tool to locate elements by bracket path. Each line is "[path] tag#id.class * @x,y,w,h {attrs} \\"text\\"": "*" marks a clickable/interactive element, @ gives its visible viewport box, {attrs} lists key attributes (placeholder/aria-label/role/href/value...), and "text" is the node\'s own visible text. Only currently visible (rendered) elements are listed.',
    '- Pick the path whose text/attributes AND @box position match the visible control in the screenshot. Prefer a node marked "*". Use paths exactly as shown.',
    '- For links/search results, cross-check the visible title text, href/domain, and @box location against the screenshot. Do not click a different URL just because the text is similar.',
    '- If clickDomNode/focusDomNode reports the path was not found, the DOM changed or the node scrolled away: call getDomTree again to get fresh paths instead of reusing the old ones or inventing a path.',
    '- Use clickDomNode(path) only as fallback when no E candidate is available. Use paths exactly as shown, for example "0.1.2".',
    '- Clicks target the element’s interactive center (DOM click uses element center when possible).',
    '- The screenshot remains the primary evidence for visual state and completion. Use the DOM tree only for locating the element to operate.',
    '- For scrolling, call scrollViewport with domPath for the specific scrollable table/list/panel or one of its visible children. This is required for virtual-scroll tables.',
    '- If the target is outside the viewport or not present in the candidate list/DOM tree, call scrollViewport on the relevant scroll container, inspect the next screenshot/DOM tree, then continue.',
    '- For text entry: focusCandidate(id) when available, then typeText. If using fallback DOM, focusDomNode(path), then typeText. If the field contains wrong text, use Ctrl+A/Backspace via pressKey before typing.',
    '- For keyboard submission, use pressKey only after the intended input/control is focused.',
  ];
  const visualInteractionRules = [
    ...candidateRules,
    'Visual click mode rules:',
    '- isClick/IS_CLICK is enabled, so DOM-path tools and getInteractiveCandidates are intentionally unavailable.',
    '- Screenshot E labels are your only candidate source. Choose the intended visible E id from the annotated screenshot, then call the matching candidate tool.',
    '- Available E-based actions: clickCandidate(id), focusCandidate(id), doubleClickCandidate(id), rightClickCandidate(id), dragCandidate(fromId,toId).',
    '- Do NOT output raw screenshot coordinates. The backend resolves the chosen E id to the element visible center.',
    '- Do NOT call getInteractiveCandidates — it does not exist in visual mode. If you see the target on the screenshot with an E label, act immediately.',
    '- For 双击/double-click requirements: identify the target link/button on the screenshot and call doubleClickCandidate(id) directly.',
    '- For text entry: focusCandidate(id), then typeText on the next step after focus is confirmed.',
    '- If a candidate click misses, use the red previous-click marker on the next screenshot to choose a better E candidate.',
  ];
  const interactionRules = visualMode ? visualInteractionRules : domInteractionRules;

  return [
    'You are an AI browser testing agent. The test case does NOT contain preset steps.',
    'Your job is to read the user requirement, inspect the current viewport screenshot as the primary source of truth, then take EXACTLY ONE browser action that makes progress, or (only when finished) return a JSON summary.',
    '',
    'CRITICAL one-action protocol (strictly enforced by the system):',
    '- You may call AT MOST ONE tool per response. After your single tool call the system immediately stops you, captures a fresh screenshot, and starts the next step. Any extra tool calls you emit in the same response are ignored and wasted.',
    '- The attached screenshot is the page state at the START of this step. You will NOT see the result of your action until the screenshot at the START of the next step.',
    '- So pick the single most useful next action and call exactly one tool. Do NOT chain actions: even "focus then type" must be split — focus/click the field this step, then type on the next step after you confirm focus from the new screenshot.',
    '- Do NOT repeat an action that already succeeded in a previous step, and do NOT re-open or re-navigate to a page when the current URL and screenshot already show it. Look at the last tool calls and the screenshot first.',
    '',
    'Vision-first decision policy:',
    '- The screenshot is the primary evidence for everything: what page is visible, what controls exist, which E id to click/double-click, whether the requirement is complete, whether a CAPTCHA/security page is blocking the flow, and whether the last click marker landed correctly.',
    '- The annotated E labels on the screenshot take priority over the Interactive candidates JSON. Use the JSON only to confirm href/host/text when the screenshot label is ambiguous.',
    '- Do not declare the page wrong, incomplete, or failed before you have actually acted; if the start screenshot already shows the page the requirement needs (and the URL matches), do NOT re-open or re-navigate to it, just do the next concrete action toward the requirement.',
    '- If the screenshot looks blank, still loading, or mid-transition, your single action this step should be waitForPage, then judge on the next screenshot.',
    '- URL, tab list, focused element, screenshot metrics, candidate list, DOM tree, and the last five tool calls are auxiliary hints.',
    '- When the screenshot contradicts auxiliary context, trust the screenshot and explain the contradiction in actual.',
    '- The red marker (solid red dot/circle) in the screenshot shows where your PREVIOUS click landed. Use it to decide whether the previous candidate was ineffective, then choose a better E candidate or fresh candidate list.',
    '- If a click was intended to open a search result/link but the next screenshot still shows the same normal results page, treat it as a missed/ineffective candidate and retry with a better candidate. Do not call it CAPTCHA/security verification unless the screenshot visibly shows a verification challenge.',
    '- The focused element summary tells you whether the current tab focus is on the intended input/control. Before typing or pressing Enter for a form, verify the focus summary matches the visible target; if it is body/document or the wrong element, focus the target input candidate again.',
    '- Prefer one purposeful user-like operation per runtime step. Do not perform a long chain of blind clicks. Observe, act once, then let the next screenshot confirm the result.',
    '- If the visible page is still loading, ambiguous, or transitioning, use waitForPage once before deciding the next UI action.',
    '- Do not claim CAPTCHA/security/manual verification unless the screenshot visibly contains a verification challenge AND no captcha code input is already filled (see verification rules below). If the page is a normal search/results/content page, continue with a better operation instead of blocking.',
    '- Do not use DOM/text as the sole success evidence. You must judge completion yourself from the screenshot and return the judgment in JSON.',
    '',
    ...buildVerificationPromptLines(pageContext),
    ...buildCompletionPromptLines(requirementOf(testCase)),
    ...interactionRules,
    '- After any click that may open a new tab/window, call listTabs. If a new relevant tab exists, call switchTab before continuing.',
    '- If current tab is not the page needed by the user requirement, call listTabs and switchTab to move to the correct tab before acting.',
    '- If a click opens a new tab but the visible screenshot still shows the old tab, switch to the relevant tab before further visual judgment.',
    '',
    'Stop condition:',
    '- See "Completion rules" above: done=true only when the ENTIRE user requirement is finished — never because a single sub-step succeeded.',
    '- If every clause of the requirement is visibly satisfied on the screenshot, stop tools and return done=true with status="passed".',
    '- If the screenshot shows CAPTCHA/login/security verification with an EMPTY code input (and verification scan says captcha not filled), return done=false with status="blocked" so the runtime can pause for the user.',
    '- If verification scan says captchaAppearsFilled=true, or the screenshot shows a verification input that already contains digits/text, do NOT block — click login/submit and continue.',
    '- If the screenshot shows an error page, empty broken page, access-denied state, or the requirement is impossible from the current state, return done=true with status="failed" or "blocked" as appropriate.',
    '- If ANY part of the requirement is still outstanding, do NOT return done=true — call one more tool instead.',
    '',
    'How to respond:',
    '- To act: call exactly ONE tool. In the SAME response, also write ONE short plain-text line in this exact format (this is your memory carried into the next step): "PROGRESS: <what you just accomplished / what the screenshot shows> NEXT: <the single next action you intend>". Keep it to one concise sentence each. Do not output JSON when acting.',
    '- Before deciding, READ your "recent progress notes" and "recent tool calls" in the context so you continue from where you left off and never redo a finished action.',
    '- To finish (entire requirement complete, blocked by verification, or impossible): call NO tool and return exactly one JSON object:',
    '{"action":"Chinese summary of what was observed","expected":"Chinese visual success criteria","actual":"Chinese result based on the current screenshot — cite evidence for EACH requirement clause","status":"passed|failed|blocked","done":true}',
    '- done=true is allowed ONLY when the full requirement is complete. Mid-task progress must use a tool with done omitted/false — never done=true after doing only part of the job.',
    '- Use done=false with status="blocked" only when verification is still required AND the captcha/code field is empty. Never block when the code field already has content.',
    '',
    `User requirement: ${requirementOf(testCase)}`,
    `Target URL: ${testCase.targetUrl}`,
    `Target host: ${targetHost}`,
    `Current URL: ${pageContext.url}`,
    `Open tabs JSON: ${JSON.stringify(pageContext.tabs)}`,
    `Current tab focused element JSON: ${JSON.stringify(pageContext.focusedElement)}`,
    `Interactive candidates JSON (auxiliary; screenshot E labels are authoritative):\n${formatInteractiveCandidates(pageContext.interactiveCandidates)}`,
    `Your recent progress notes (oldest first), so you know what you already did and planned:\n${recentProgressNotes(completedSteps, 8).join('\n') || '[no notes yet]'}`,
    `Your recent tool calls (oldest first), each {name, input, result:{ok, actual}}:\n${JSON.stringify(recentToolCallContext(completedSteps, 8), null, 2)}`,
    visualMode
      ? 'Simplified current tab DOM tree: [disabled because isClick visual mode is enabled]'
      : `Simplified current tab DOM tree:\n${pageContext.domTree || '[empty DOM tree]'}`,
    modelSupportsScreenshotInput()
      ? 'The current viewport screenshot is attached as an image input.'
      : `Current viewport screenshot path: ${beforeScreenshotPath}`,
  ].join('\n');
}

function summarizeToolInput(input: unknown) {
  if (input && typeof input === 'object') {
    const entries = Object.entries(input as Record<string, unknown>)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
    return entries.length ? ` (${entries.join(', ')})` : '';
  }
  return '';
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
    return {
      action: note || `AI 执行操作：${names || last?.name || '浏览器操作'}`,
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
  });
  const prompt = runtimePrompt({
    testCase,
    pageContext,
    completedSteps,
    stepIndex,
    beforeScreenshotPath,
    screenshotMetrics: session.getLastScreenshotMetrics(),
  });
  const screenshot = modelSupportsScreenshotInput() ? await readFile(beforeScreenshotPath) : undefined;

  async function runAgent(includeImage: boolean) {
    const traces: ToolTrace[] = [];
    const messageContent: Array<{ type: 'text'; text: string } | { type: 'image'; image: Buffer }> = [{ type: 'text', text: prompt }];
    if (includeImage && screenshot) messageContent.push({ type: 'image', image: screenshot });

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

      return { text: result.text || '', traces };
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
        return { text: '', traces };
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

  throw lastError;
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
}): Promise<StepExecutionResult> {
  const { session, runId, stepIndex, beforeScreenshotPath, error, tools } = input;
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
  };
}

export async function executeTestCase(testCase: TestCaseRecord, runId: string, options: ExecutionOptions = {}) {
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
