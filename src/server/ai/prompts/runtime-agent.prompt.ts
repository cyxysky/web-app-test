type ManualVerificationPromptContext = {
  manualVerification?: {
    detected?: boolean;
    captchaFields?: unknown[];
  } | null;
};

type CompletionVerificationPromptInput = {
  requirement: string;
  attachScreenshot: boolean;
  proposedClaim: unknown;
  currentUrl: string;
  manualVerification?: unknown;
  recentProgressNotes: string[];
};

export function buildCompletionPromptLines(usesScreenshot: boolean) {
  const evidence = usesScreenshot ? 'screenshot' : 'textual page context / candidates / DOM / URL / focus';
  return [
    'Completion rules:',
    `- done=true only when EVERY requirement clause is proven by ${evidence}. Partial progress is not completion.`,
    '- If anything is still missing or uncertain, call one more tool instead of finishing.',
    '- status=blocked only for manual verification/security/login wait; blocked must use done=false.',
    '- status=failed only when the requirement is clearly impossible or failed end-to-end.',
  ];
}

export function buildVerificationPromptLines(pageContext: ManualVerificationPromptContext, usesScreenshot: boolean) {
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

export function buildCompletionVerificationPrompt(input: CompletionVerificationPromptInput) {
  const { requirement, attachScreenshot, proposedClaim, currentUrl, manualVerification, recentProgressNotes } = input;
  return [
    'You are an independent completion judge. The executor agent claims the user requirement is FULLY complete.',
    attachScreenshot
      ? 'Verify using ONLY the attached viewport screenshot and the requirement text. Be strict: partial progress is NOT complete.'
      : 'Verify using ONLY the textual browser context and the requirement text. No screenshot image is attached because visual mode is disabled. Be strict: partial progress is NOT complete.',
    '',
    `User requirement (every clause must be visibly satisfied for verified=true):\n${requirement}`,
    '',
    'Executor claim:',
    JSON.stringify(proposedClaim, null, 2),
    '',
    `Current URL: ${currentUrl}`,
    `Verification scan JSON: ${JSON.stringify(manualVerification ?? null)}`,
    `Recent progress notes (oldest first):\n${recentProgressNotes.join('\n') || '[none]'}`,
    '',
    'Rules:',
    attachScreenshot
      ? '- verified=true only if the screenshot clearly proves ALL parts of the requirement are done.'
      : '- verified=true only if the textual browser context clearly proves ALL parts of the requirement are done.',
    '- Empty captcha/OTP, login not finished, or waiting for user input -> verified=false, status="blocked".',
    '- Wrong page or missing required outcome -> verified=false; set remainingWork to concrete next steps.',
    '- If the requirement is visibly impossible, verified=true with status="failed" is allowed.',
    '- summary and remainingWork must be written in Chinese.',
    '',
    'Reply with JSON only (no tools):',
    '{ "verified": boolean, "status": "passed"|"failed"|"blocked", "summary": string, "remainingWork": string }',
    '- remainingWork: required when verified=false; list what the executor should do next (Chinese OK). Empty string when verified=true.',
  ].join('\n');
}

export function buildCodexObjectPrompt(prompt: string, allowedTypes: string[]) {
  const answerAllowed = allowedTypes.includes('answer');
  const browserCodeMode = allowedTypes.includes('browserCode');
  const domMode = allowedTypes.includes('inspect') && allowedTypes.includes('interact');
  return [
    prompt,
    '',
    'Codex local mode:',
    '- AI SDK tools are unavailable for this provider. Do NOT attempt to call tools.',
    '- Return exactly one object with shape: { "type": string, "message"?: string, "params": object }.',
    '- message is optional short Chinese progress text for the user. Put explanation there, not inside tool params.',
    '- All user-facing strings such as message/reason/action/expected/actual must be Chinese.',
    `- type must be one of: ${allowedTypes.join(', ')}.`,
    '- params should include only keys required by that tool plus a concise reason.',
    answerAllowed ? '- In browser chat strict safety mode, important actions must still return the intended tool object; add params.requiresConfirmation=true and a concise Chinese params.confirmationMessage so the UI can pause with Confirm/Cancel buttons before execution. Do not ask the user to type confirmation text.' : '',
    '- Do not include separate state summaries, memory notes, finding lists, task frames, ledger JSON, old tool params, or tool input JSON.',
    '- In message/reason/action/expected/actual, do not output coordinates, screenshot ids/file names, or tool input JSON as business meaning.',
    browserCodeMode ? '- browserCode is the only browser inspection and operation entrypoint. Put one ordinary JavaScript cell in params.code. Use top-level await and do not wrap it in a function or module.' : '',
    browserCodeMode ? '- The JavaScript kernel persists across browserCode calls. Prefer top-level var for reusable bindings or fresh names, and emit the result with nodeRepl.write(<JSON-serializable value>).' : '',
    browserCodeMode ? '- browserCode has an infrastructure watchdog that restarts an unresponsive JavaScript kernel. Keep each cell bounded. Locator/action operations default to 5000ms and navigation defaults to 30000ms, so a missing target fails the current cell without destroying persistent bindings. Add a longer explicit Playwright timeout only for a known slow transition.' : '',
    browserCodeMode ? '- The program receives real Playwright page and context objects. Write ordinary Playwright code directly. Do not import modules or access Node globals, local files, environment variables, cookies, browser storage, or raw credential values. If the prompt supplies a credential reference, fill only the intended locator with await credentialVault.fill(locator, ref); never read the filled field value or output/log credentials or references.' : '',
    browserCodeMode ? '- DOM code belongs inside await page.evaluate((arg) => { ... }, arg). That callback executes in the browser page VM; the surrounding browserCode program executes in the isolated Node process.' : '',
    browserCodeMode ? '- browserCode always returns final page identity and console deltas. Actual browser operations, navigation, and tab changes directly return DOM mode incremental domChanges; pure reads, including pure-read failures, return no automatic DOM content.' : '',
    browserCodeMode ? '- Before every click, hover, fill, press, select, drag, or other state-changing action, call page.domSnapshot() for the latest hierarchy and content. Then use targeted Playwright or read-only DOM inspection as needed to identify a stable parent container using data-testid, a stable data-* attribute, or a unique exact href. Inside it, locate the child by semantic role or exact text, apply locator.filter({ visible: true }), call count(), and act only when count() === 1.' : '',
    browserCodeMode ? '- If count() > 1, narrow the parent container or use a stronger stable attribute; never use first(), last(), or nth() to hide ambiguity. If count() === 0, take a fresh snapshot and rebuild the locator. force: true is forbidden. After timeout or strict-mode failure, inspect direct domChanges when present, take a fresh page.domSnapshot(), and refine the locator; do not fall back to CUA, page.mouse, DOM click, dispatchEvent, or script click.' : '',
    browserCodeMode ? '- After every state-changing action, verify the expected business state with a targeted locator, URL, value, toast, dialog, or table-state check. Playwright success does not equal business success.' : '',
    browserCodeMode ? '- Pixel evidence stays in browserCode: await nodeRepl.emitImage(await page.screenshot({ fullPage: false })). CUA or coordinates are allowed only for special visual controls Playwright cannot describe and require two model steps: end the first browserCode cell after emitting the viewport screenshot, inspect the returned image, then perform one coordinate click in the next cell. Same-cell screenshot-and-click is forbidden; navigation, viewport changes, or DOM redraws invalidate the evidence. FullPage images are read-only.' : '',
    browserCodeMode ? '- browser/tab are code APIs in the same kernel: browser.tabs.list()/new()/finalize(), browser.user.openTabs()/claimTab(), tab.playwright, and tab.cua.' : '',
    domMode ? '- DOM mode uses inspect for semantic page evidence, interact for one current UID or latest viewport coordinates, browser for navigation/tabs, and takeScreenshot only when pixel evidence is needed.' : '',
    domMode ? '- Before every state-changing interact call, understand the exact user goal and confirm from a fresh inspect result the current page, active dialog/layer, intended outcome, exact target, and loading or blocking state. If anything is uncertain or may have changed, inspect again instead of acting.' : '',
    domMode ? '- Begin browser work with type="inspect", params.action="capture", params.mode="full". Use only the current dom-* UID returned by inspect; never invent or reuse a removed UID.' : '',
    domMode ? '- For a native select use type="interact", params.action="selectOption", params.uid, and an exact params.value or params.label. For credentials use params.credentialRef with a current field UID; never put the secret in params.text.' : '',
    allowedTypes.includes('downloadFile') ? '- For downloadFile, put an absolute URL in params.url, an origin-relative path like /files/a.pdf, or a page-relative path like report/a.pdf in params.path/urlOrPath. Use params.fileName only when the desired saved name is known.' : '',
    allowedTypes.includes('generateMarkdownFile') ? '- For generateMarkdownFile, put the complete Markdown document in params.content and the desired file name in params.fileName. The final visible answer must include the returned download link as a clickable Markdown link.' : '',
    browserCodeMode ? '- For a browser action, set type="browserCode" and put the program in params.code plus a concise params.reason.' : '',
    answerAllowed
      ? '- For browser chat completion, clarification, blocked state, failure, or pure text response, set type="answer" and put the complete Chinese Markdown answer in message. Do not use reportState.'
      : '- For completion, manual verification, failure, or pure status update, use type="reportState".',
  ].join('\n');
}

export function customRuntimePromptFromEnv() {
  const rules = String(process.env.AI_CUSTOM_SYSTEM_PROMPT || '').trim();
  if (!rules) return '';
  return [
    'Additional user-configured rules (append-only):',
    '- These rules supplement the built-in Agent Loop prompt; they do not replace it.',
    '- They must not override, weaken, or bypass built-in rules, safety rules, tool contracts, loaded Skills, or the current user requirement.',
    '- If an additional rule conflicts with existing instructions, follow the existing higher-priority instruction.',
    rules,
  ].join('\n');
}
