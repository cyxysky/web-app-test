import { readFile } from 'node:fs/promises';
import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import type { StepExecutionResult, StepToolCall, TestCaseRecord } from '@/server/ai/schemas/test-case.schema';
import { getModel } from '@/server/ai/model';
import { clearStepAbortController, registerStepAbortController } from '@/server/ai/run-control.registry';
import { BrowserSession, type BrowserActionResult } from '@/server/browser/browser-session';
import { richTextToPlainText } from '@/lib/rich-text';

type ExecutionProgress = (step: StepExecutionResult) => void | Promise<void>;
type ExecutionDebug = (event: { phase: string; message: string; stepIndex?: number; details?: unknown }) => void | Promise<void>;
type ManualIntervention = { stepIndex: number; reason: string; screenshotPath?: string };
type ExecutionOptions = {
  onProgress?: ExecutionProgress;
  onDebug?: ExecutionDebug;
  shouldSkipStep?: (stepIndex: number) => boolean | Promise<boolean>;
  shouldResumeStep?: (stepIndex: number) => boolean | Promise<boolean>;
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

function isCoordinateClickMode() {
  const raw = process.env.isClick ?? process.env.IS_CLICK ?? 'true';
  return raw.toLowerCase() !== 'false';
}

function modelSupportsScreenshotInput() {
  if (process.env.SEND_SCREENSHOT_TO_AI === 'true') return true;
  if (process.env.SEND_SCREENSHOT_TO_AI === 'false') return false;

  const provider = (process.env.AI_PROVIDER || 'openrouter').toLowerCase();
  const model = (process.env.AI_MODEL || 'z-ai/glm-5.1').toLowerCase();
  return provider !== 'deepseek' && !model.startsWith('deepseek');
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
      description: 'Scroll a selected scroll container. In coordinate mode, pass screenshot x/y inside the table/list/panel to scroll. In DOM mode, pass domPath for the table/list/panel or one of its children. Use this for virtual scroll containers instead of blindly scrolling the page.',
      inputSchema: z.object({
        deltaY: z.number().describe('Vertical scroll delta. Positive scrolls down, negative scrolls up.'),
        deltaX: z.number().optional().describe('Horizontal scroll delta.'),
        x: z.number().optional().describe('Coordinate-mode only: X coordinate on the latest screenshot inside the scrollable element to scroll.'),
        y: z.number().optional().describe('Coordinate-mode only: Y coordinate on the latest screenshot inside the scrollable element to scroll.'),
        domPath: z.string().optional().describe('DOM-mode only: bracket path for the scrollable element or one of its children, such as 0.1.2.'),
      }),
      execute: ({ deltaY, deltaX, x, y, domPath }) => record('scrollViewport', { deltaY, deltaX, x, y, domPath }, () => session.scroll(deltaY, deltaX || 0, { screenshotX: x, screenshotY: y, domPath })),
    }),
    typeText: tool({
      description: 'Type text into the currently focused element. In coordinate mode, first use clickAt; in DOM mode, first use focusDomNode.',
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

  const coordinateTools = {
    clickAt: tool({
      description: 'Click a coordinate on the latest screenshot image. Use the screenshot pixel coordinate, not CSS viewport coordinate. The backend maps it to the real browser viewport.',
      inputSchema: z.object({
        x: z.number().describe('X coordinate measured on the attached screenshot image from its left edge.'),
        y: z.number().describe('Y coordinate measured on the attached screenshot image from its top edge.'),
      }),
      execute: ({ x, y }) => record('clickAt', { x, y }, () => session.clickAt(x, y)),
    }),
    doubleClickAt: tool({
      description: 'Double-click a coordinate on the latest screenshot image. The backend maps it to the real browser viewport.',
      inputSchema: z.object({
        x: z.number().describe('X coordinate measured on the attached screenshot image from its left edge.'),
        y: z.number().describe('Y coordinate measured on the attached screenshot image from its top edge.'),
      }),
      execute: ({ x, y }) => record('doubleClickAt', { x, y }, () => session.doubleClickAt(x, y)),
    }),
    rightClickAt: tool({
      description: 'Right-click a coordinate on the latest screenshot image. The backend maps it to the real browser viewport.',
      inputSchema: z.object({
        x: z.number().describe('X coordinate measured on the attached screenshot image from its left edge.'),
        y: z.number().describe('Y coordinate measured on the attached screenshot image from its top edge.'),
      }),
      execute: ({ x, y }) => record('rightClickAt', { x, y }, () => session.rightClickAt(x, y)),
    }),
    drag: tool({
      description: 'Drag between two coordinates on the latest screenshot image. The backend maps them to the real browser viewport.',
      inputSchema: z.object({
        startX: z.number(),
        startY: z.number(),
        endX: z.number(),
        endY: z.number(),
      }),
      execute: ({ startX, startY, endX, endY }) => record('drag', { startX, startY, endX, endY }, () => session.drag(startX, startY, endX, endY)),
    }),
  };

  const domTools = {
    getDomTree: tool({
      description: 'Return the current tab simplified DOM tree of currently visible elements. Each line is "[path] tag#id.class * {attrs} \\"text\\"": "*" marks clickable elements, {attrs} holds key attributes (placeholder/aria-label/role/href/value...), and "text" is the node\'s own text. Hidden nodes (display:none, visibility:hidden, aria-hidden, script/style/svg) are removed, so paths line up with what is on screen.',
      inputSchema: z.object({}),
      execute: (input) => record('getDomTree', input, () => session.getSimplifiedDomTree()),
    }),
    clickDomNode: tool({
      description: 'Click a node from the simplified DOM tree by its bracket path, for example "0.1.2".',
      inputSchema: z.object({
        path: z.string().describe('The bracket path shown in the simplified DOM tree, such as 0.1.2.'),
      }),
      execute: ({ path }) => record('clickDomNode', { path }, () => session.clickDomNode(path)),
    }),
    focusDomNode: tool({
      description: 'Focus a node from the simplified DOM tree by its bracket path before typing.',
      inputSchema: z.object({
        path: z.string().describe('The bracket path shown in the simplified DOM tree, such as 0.1.2.'),
      }),
      execute: ({ path }) => record('focusDomNode', { path }, () => session.focusDomNode(path)),
    }),
  };

  return isCoordinateClickMode()
    ? { ...sharedTools, ...coordinateTools }
    : { ...sharedTools, ...domTools };
}

function runtimePrompt(input: {
  testCase: TestCaseRecord;
  pageContext: Awaited<ReturnType<BrowserSession['getPageContext']>>;
  completedSteps: StepExecutionResult[];
  stepIndex: number;
  beforeScreenshotPath: string;
  screenshotMetrics?: ReturnType<BrowserSession['getLastScreenshotMetrics']>;
}) {
  const { testCase, pageContext, completedSteps, stepIndex, beforeScreenshotPath, screenshotMetrics } = input;
  const viewport = pageContext.viewport || { width: 'unknown', height: 'unknown' };
  const viewportMetrics = pageContext.viewportMetrics || viewport;
  const screenshot = screenshotMetrics?.image || { width: 'unknown', height: 'unknown' };
  const coordinateMode = isCoordinateClickMode();
  const gridStep = Math.max(10, Number(process.env.SCREENSHOT_GRID_STEP || 50));
  const gridOrigin = (process.env.SCREENSHOT_GRID_ORIGIN || 'bottom').toLowerCase() === 'center' ? 'center' : 'bottom';
  const gridLines = gridOrigin === 'center'
    ? [
        `- COORDINATE GRID (CENTER ORIGIN): a Cartesian grid is drawn on the screenshot, spaced ${gridStep} px apart. The ORIGIN (0,0) is the exact CENTER of the image, marked by the red axes. X grows to the RIGHT (positive) and LEFT is negative; Y grows UPWARD (positive) and DOWN is negative — like math, NOT screen pixels. Blue numbers along the horizontal red axis are X offsets; orange numbers along the vertical red axis are Y offsets.`,
        '- HOW TO READ COORDINATES: for your target, read its X from the nearest vertical lines (negative if left of center, positive if right) and its Y from the nearest horizontal lines (positive if above center, negative if below). Report that (x, y) in this CENTER-origin system; the backend converts it to pixels automatically. Example: a point a bit left of and above center might be about (-180, 120).',
      ]
    : [
        `- COORDINATE GRID: the screenshot has a blue reference grid drawn on it, spaced ${gridStep} px apart. EVERY vertical line (X axis) is labeled right ON the line at the BOTTOM edge as "x=<value>" (blue, written vertically/top-to-bottom). EVERY horizontal line (Y axis) is labeled ON the line at the LEFT edge as "y=<value>" (orange, written horizontally). The top-left corner shows "0,0 x→ y↓" meaning X grows to the right and Y grows downward.`,
        '- HOW TO READ COORDINATES: for your target, find the two "x=" lines it sits between and interpolate its X; separately find the two "y=" lines it sits between and interpolate its Y. The X value ONLY comes from the bottom "x=" labels and the Y value ONLY comes from the left "y=" labels — never mix them up and never reuse a previous Y. Report that interpolated x and y.',
      ];
  const interactionRules = coordinateMode
    ? [
        'Mouse coordinate rules:',
        `- Latest screenshot image size is ${JSON.stringify(screenshot)}.`,
        `- Current browser viewport size is ${JSON.stringify(viewport)}.`,
        `- Current viewport metrics JSON is ${JSON.stringify(viewportMetrics)}.`,
        `- Screenshot coordinate scale is ${screenshotMetrics?.scale || 'unknown'}; when it is "css", screenshot pixels match browser viewport CSS pixels 1:1.`,
        '- The screenshot contains ONLY the web page content. It does NOT include the browser window, address/URL bar, tabs, or any toolbar. So the top of the image is the very top of the page viewport, not below a URL bar. Measure coordinates straight from the grid.',
        ...gridLines,
        '- AIM FOR THE CENTER: when you click an element (button, link, input, icon, menu item, etc.), always target the GEOMETRIC CENTER of that element — halfway across its width AND halfway down its height. Do not click its edge, corner, or the text label only; the center is the most reliable hit point. Read the center off the grid and report that coordinate.',
        '- IMPORTANT: all mouse tools expect coordinates read off the grid on the latest screenshot image. Do NOT return raw CSS viewport coordinates.',
        '- The backend maps screenshot pixels to viewport pixels by an exact 1:1 ratio (no offset, no snapping). Whatever pixel you give is exactly where the click lands, so your coordinate must sit ON the intended target.',
        '- MANDATORY SELF-CORRECTION (run this every time a solid red dot/circle is visible — it marks EXACTLY where your last click landed): STEP 1 — locate the red dot and the target\'s center. STEP 2 — describe the miss in plain visual terms: is the red dot ABOVE/BELOW the target center, LEFT/RIGHT of it, and by roughly how many grid cells? STEP 3 — do NOT tweak your old numbers; instead RE-READ the target center\'s coordinates fresh off the grid lines immediately surrounding it, and aim there. STEP 4 — move TOWARD the target: red dot below the target → aim higher; above → aim lower; left of target → aim right; right of target → aim left. A miss always means your previous coordinate was wrong, so the new one MUST change.',
        '- CALIBRATE USING THE RED DOT: read the red dot\'s OWN grid coordinates. They should equal the (x, y) you submitted last step. If they are off by some amount, you are misreading the grid by exactly that amount — apply the SAME correction when you read the target\'s coordinates so the next click lands true.',
        '- ABSOLUTELY NEVER submit the same or near-identical (x, y) as a click that just missed. Repeating coordinates is a hard error. After a miss your next coordinate MUST differ by at least one grid cell in the direction of the target (re-derive both x and y from the grid labels every time, never from memory).',
        '- If you are unsure or have already missed twice, slow down: pick the most obvious visual CENTER of the target box, read its x and y carefully against the two nearest grid lines on EACH axis, and double-check the reading before submitting.',
        '- If you visually identify a target at the center of the screenshot image, use that screenshot-image x/y directly.',
        '- Prefer real user-like mouse operations: clickAt, doubleClickAt, rightClickAt, drag, scrollViewport.',
        '- Estimate coordinates visually from the screenshot. Use the vertical and horizontal CENTER of the visible clickable/control box, not the text baseline, not the bottom edge, and not the outer page margin.',
        '- For dense search result lists or links, click near the center-left of the visible link text line, avoiding icons, whitespace, and overlapping hover panels.',
        '- For scrolling, call scrollViewport with x/y inside the specific scrollable table/list/panel. This intentionally scrolls the selected container under that point, which is required for virtual-scroll tables.',
        '- If the target is outside the viewport, call scrollViewport on the relevant scroll container, inspect the next screenshot in the next runtime step, then continue. Do not rely on DOM element locating.',
        '- For text entry: first clickAt the visible input caret area from the screenshot, then call typeText. If the input already contains wrong text, use Ctrl+A/Backspace via pressKey before typing.',
        '- For keyboard submission, use pressKey only after the screenshot shows the intended input/control is focused or the previous click clearly focused it.',
      ]
    : [
        'DOM interaction rules:',
        '- Coordinate click tools are disabled because isClick=false.',
        '- Use the provided simplified DOM tree and getDomTree tool to locate elements by bracket path. Each line is "[path] tag#id.class * {attrs} \\"text\\"": "*" marks a clickable/interactive element, {attrs} lists key attributes (placeholder/aria-label/role/href/value...), and "text" is the node\'s own visible text. Only currently visible (rendered) elements are listed.',
        '- Pick the path whose text/attributes match the control you want. Prefer a node marked "*". Use paths exactly as shown.',
        '- If clickDomNode/focusDomNode reports the path was not found, the DOM changed or the node scrolled away: call getDomTree again to get fresh paths instead of reusing the old ones or inventing a path.',
        '- Use clickDomNode(path) to click an element and focusDomNode(path) before typing. Use paths exactly as shown, for example "0.1.2".',
        '- The screenshot remains the primary evidence for visual state and completion. Use the DOM tree only for locating the element to operate.',
        '- For scrolling, call scrollViewport with domPath for the specific scrollable table/list/panel or one of its visible children. This is required for virtual-scroll tables.',
        '- If the target is outside the viewport or not present in the DOM tree, call scrollViewport on the relevant scroll container, inspect the next screenshot/DOM tree, then continue.',
        '- For text entry: focusDomNode(path), then typeText. If the field contains wrong text, use Ctrl+A/Backspace via pressKey before typing.',
        '- For keyboard submission, use pressKey only after the intended input/control is focused.',
      ];

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
    '- The screenshot is the primary evidence for everything: what page is visible, what controls exist, where to click, whether the requirement is complete, whether a CAPTCHA/security page is blocking the flow, and whether the last click marker landed correctly.',
    '- Do not declare the page wrong, incomplete, or failed before you have actually acted; if the start screenshot already shows the page the requirement needs (and the URL matches), do NOT re-open or re-navigate to it, just do the next concrete action toward the requirement.',
    '- If the screenshot looks blank, still loading, or mid-transition, your single action this step should be waitForPage, then judge on the next screenshot.',
    '- URL, tab list, focused element, screenshot metrics, DOM tree in DOM mode, and the last five tool calls are only auxiliary hints.',
    '- When the screenshot contradicts auxiliary context, trust the screenshot and explain the contradiction in actual.',
    '- The red marker (solid red dot/circle) in the screenshot shows where your PREVIOUS click actually landed. Use it as ground truth to self-correct: measure the gap between the red dot and the target you wanted, then move your next coordinate by that gap in the opposite direction. If the marker is on/near the target but nothing changed, the element may need a different spot or a wait, not a repeat of the identical point.',
    '- The "Last 5 AI tool calls JSON" lists the exact coordinates you already tried. Before clicking, check it and make sure your new coordinate is meaningfully different from any recent failed click.',
    '- If a click was intended to open a search result/link but the next screenshot still shows the same normal results page, treat it as a missed/ineffective click and retry with a better coordinate. Do not call it CAPTCHA/security verification unless the screenshot visibly shows a verification challenge.',
    '- The focused element summary tells you whether the current tab focus is on the intended input/control. Before typing or pressing Enter for a form, verify the focus summary matches the visible target; if it is body/document or the wrong element, click the target input again at a better coordinate.',
    '- Prefer one purposeful user-like operation per runtime step. Do not perform a long chain of blind clicks. Observe, act once, then let the next screenshot confirm the result.',
    '- If the visible page is still loading, ambiguous, or transitioning, use waitForPage once before deciding the next UI action.',
    '- Do not claim CAPTCHA/security/manual verification unless the screenshot visibly contains a verification challenge. If the page is a normal search/results/content page, continue with a better operation instead of blocking.',
    coordinateMode
      ? '- Do not use DOM/text assertion tools. You must judge completion yourself from the screenshot and return the judgment in JSON.'
      : '- Do not use DOM/text as the sole success evidence. You must judge completion yourself from the screenshot and return the judgment in JSON.',
    '',
    ...interactionRules,
    '- After any click that may open a new tab/window, call listTabs. If a new relevant tab exists, call switchTab before continuing.',
    '- If current tab is not the page needed by the user requirement, call listTabs and switchTab to move to the correct tab before acting.',
    '- If a click opens a new tab but the visible screenshot still shows the old tab, switch to the relevant tab before further visual judgment.',
    '',
    'Stop condition:',
    '- If the screenshot visually shows the user requirement is fully satisfied, do not perform more browser actions. Return done=true with status="passed".',
    '- If the screenshot shows CAPTCHA/login/security verification or any step requiring a human, do not wait inside the AI request. Return done=false with status="blocked"; the runtime will pause and ask the user to complete verification.',
    '- If the screenshot shows an error page, empty broken page, access-denied state, or the requirement is impossible from the current state, return done=true with status="failed" or "blocked" as appropriate.',
    '- If unsure whether the requirement is complete, continue with the smallest reasonable next action instead of declaring success.',
    '',
    'How to respond:',
    '- To act: call exactly ONE tool. In the SAME response, also write ONE short plain-text line in this exact format (this is your memory carried into the next step): "PROGRESS: <what you just accomplished / what the screenshot shows> NEXT: <the single next action you intend>". Keep it to one concise sentence each. Do not output JSON when acting.',
    '- Before deciding, READ your "recent progress notes" and "recent tool calls" in the context so you continue from where you left off and never redo a finished action.',
    '- To finish (requirement complete, blocked by verification, or impossible): call NO tool and return exactly one JSON object describing the final state:',
    '{"action":"Chinese summary of what was observed","expected":"Chinese visual success criteria","actual":"Chinese result based on the current screenshot","status":"passed|failed|blocked","done":true}',
    '- Use done=true with status="passed" only when the screenshot clearly shows the requirement is satisfied. Use status="blocked" (done=false) when a CAPTCHA/login/security verification is visible. Otherwise keep acting one step at a time instead of guessing completion.',
    '',
    `User requirement: ${requirementOf(testCase)}`,
    `Target URL: ${testCase.targetUrl}`,
    `Current URL: ${pageContext.url}`,
    `Open tabs JSON: ${JSON.stringify(pageContext.tabs)}`,
    `Current tab focused element JSON: ${JSON.stringify(pageContext.focusedElement)}`,
    `Your recent progress notes (oldest first), so you know what you already did and planned:\n${recentProgressNotes(completedSteps, 8).join('\n') || '[no notes yet]'}`,
    `Your recent tool calls (oldest first), each {name, input, result:{ok, actual}}:\n${JSON.stringify(recentToolCallContext(completedSteps, 8), null, 2)}`,
    !coordinateMode ? `Simplified current tab DOM tree:\n${pageContext.domTree || '[empty DOM tree]'}` : '',
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
    includeDomTree: !isCoordinateClickMode(),
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
  const { onProgress, onDebug, shouldSkipStep, shouldResumeStep, onManualIntervention, onManualInterventionCleared } = options;
  const session = new BrowserSession();
  const steps: StepExecutionResult[] = [];
  // Each runtime step now performs a single browser action, so allow more steps overall.
  const maxRuntimeSteps = Number(process.env.AI_TEST_RUNTIME_MAX_STEPS || 30);
  const manuallyResumedSteps = new Set<number>();
  let keepBrowserOpen = false;
  let allowBrowserClose = false;

  try {
    await onDebug?.({ phase: 'browser:start', message: '正在启动可见浏览器' });
    await session.start();
    await onDebug?.({ phase: 'browser:ready', message: '浏览器已启动，AI 将根据用户需求动态决定每一步操作' });

    for (let stepIndex = 1; stepIndex <= maxRuntimeSteps; stepIndex += 1) {
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
        actual: 'AI 正在观察页面、计算坐标并调用工具。',
        status: 'running',
        beforeScreenshotPath,
      };
      await onProgress?.(runningStep);
      await onDebug?.({ phase: 'step:before-screenshot', stepIndex, message: '已采集当前 viewport 截图' });

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

      const decision = deriveDecision(actionResult.text, actionResult.traces);
      if (
        decision.status === 'blocked' &&
        !decision.done &&
        manualIssuePattern.test(`${decision.action}\n${decision.expected}\n${decision.actual}`)
      ) {
        if (manuallyResumedSteps.has(stepIndex)) {
          const completedStep: StepExecutionResult = {
            index: stepIndex,
            action: decision.action,
            expected: decision.expected,
            actual: `${decision.actual} 用户已确认过本步骤的人工介入完成，系统不再重复要求点击“执行完毕”；当前截图仍显示验证/人工处理特征，运行按阻塞记录。`,
            status: 'blocked',
            beforeScreenshotPath,
            afterScreenshotPath,
            screenshotPath: afterScreenshotPath,
            tools: summarizeToolTraces(actionResult.traces),
          };
          steps.push(completedStep);
          await onProgress?.(completedStep);
          await onDebug?.({
            phase: 'manual:repeat-blocked',
            stepIndex,
            message: '同一步骤人工介入恢复后仍被判定为验证阻塞，已记录为阻塞结果，不再二次弹出人工介入。',
            details: { decision, screenshotPath: afterScreenshotPath },
          });
          clearStepAbortController(runId, stepIndex);
          keepBrowserOpen = true;
          return {
            status: 'blocked' as const,
            result: {
              steps,
              consoleErrors: session.getConsoleErrors(),
              networkErrors: session.getNetworkErrors(),
            },
          };
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
