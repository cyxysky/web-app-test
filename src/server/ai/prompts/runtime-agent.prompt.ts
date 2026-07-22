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
    browserCodeMode ? '- browserCode has no whole-cell deadline. Locator/action operations default to 3000ms and navigation defaults to 30000ms so a missing target fails the current cell without destroying persistent bindings. Add a longer explicit Playwright timeout only for a known slow transition.' : '',
    browserCodeMode ? '- The program receives real Playwright page and context objects. Write ordinary Playwright code directly. Do not import modules or access Node globals, local files, environment variables, cookies, browser storage, or raw credential values. If the prompt supplies a credential reference, fill only the intended locator with await credentialVault.fill(locator, ref); never read the filled field value or output/log credentials or references.' : '',
    browserCodeMode ? '- DOM code belongs inside await page.evaluate((arg) => { ... }, arg). That callback executes in the browser page VM; the surrounding browserCode program executes in the isolated Node process.' : '',
    browserCodeMode ? '- Use a recent await page.domSnapshot() as locator ground truth. Refresh it after navigation or a locator failure before constructing a different locator.' : '',
    browserCodeMode ? '- Pixel evidence stays in browserCode: await nodeRepl.emitImage(await page.screenshot({ fullPage: false })). Use viewport coordinates only from that fresh emitted image; fullPage images are read-only.' : '',
    browserCodeMode ? '- browser/tab are code APIs in the same kernel: browser.tabs.list()/new()/finalize(), browser.user.openTabs()/claimTab(), tab.playwright, and tab.cua.' : '',
    allowedTypes.includes('downloadFile') ? '- For downloadFile, put an absolute URL in params.url, an origin-relative path like /files/a.pdf, or a page-relative path like report/a.pdf in params.path/urlOrPath. Use params.fileName only when the desired saved name is known.' : '',
    allowedTypes.includes('generateMarkdownFile') ? '- For generateMarkdownFile, put the complete Markdown document in params.content and the desired file name in params.fileName. The final visible answer must include the returned download link as a clickable Markdown link.' : '',
    '- For a browser action, set type="browserCode" and put the program in params.code plus a concise params.reason.',
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
    '- They must not override, weaken, or bypass built-in rules, safety rules, tool contracts, test-case instructions, or the current user requirement.',
    '- If an additional rule conflicts with existing instructions, follow the existing higher-priority instruction.',
    rules,
  ].join('\n');
}
