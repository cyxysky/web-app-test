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
  const inspectMode = allowedTypes.includes('inspect');
  const screenshotMode = allowedTypes.includes('takeScreenshot');
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
    '- In message/reason/action/expected/actual, do not output UIDs, coordinates, deltas, screenshot ids/file names, or tool input JSON as business meaning.',
    inspectMode ? '- Use inspect with params={action:"capture",mode:"full"} by default for the complete loaded semantic DOM baseline. This is the fast page-local B chain over normal DOM, open shadow roots, and intercepted closed roots; it never runs full DOMSnapshot or full-page AX collection. action="capture" with mode="text" returns ALL text from that same full DOM, including offscreen content, as a deduplicated reading view; mode="changes" is only the inter-action DOM/request journal. Text pages are fixed at 20,000 characters and full pages at 40,000 characters. changes has no interactive UIDs and does not replace the baseline. Query its request IDs with inspect action="httpRequests". nextCursor pages one frozen result: continue with action="capture", the same mode, and exact cursor; never scroll for pagination.' : '',
    inspectMode ? '- Use inspect with action="search" plus query, tag, or one exact current dom-* uid to search the complete frozen snapshot. includeAx=true adds bounded local AX semantics; includeShadow=true requires one exact uid and performs bounded local CDP shadow piercing plus local AX enrichment. Both preserve the same dom-* UID namespace used by inspect, interact, and marked screenshots. Search is read-only: it does not scroll, consume DOM mutations, invalidate nextCursor, or invoke full DOMSnapshot/full-page AX collection. Use inspect action="httpRequests" to inspect recent network requests or details for request IDs from mode="changes". A frozen cursor survives waiting and arbitrary asynchronous DOM changes; only a UI-affecting browser interaction or an explicit fresh capture invalidates it. Use only UIDs from the latest inspection.' : '',
    inspectMode ? '- domChanges.overflow only means the MutationObserver change queue exceeded capacity. It never means more content exists below. Never scroll or write "scroll to bottom" into a child-Agent instruction because of overflow; scroll only for explicit lazy-load, virtual-list, or infinite-scroll evidence when the target is absent from full/text.' : '',
    inspectMode ? '- Use interact for every page input: pointer actions are click/move/drag/scroll/scrollIntoView, keyboard actions are type/press/shortcut, and native selects use action=selectOption. A UID action scrolls an offscreen target into view automatically.' : '',
    screenshotMode ? '- takeScreenshot is the visual tool. markers=true overlays the current B-chain dom-* UIDs shared with inspect and interact. Only coordinates derived from its latest viewport capture may be used in interact; fullPage captures are read-only evidence.' : '',
    screenshotMode ? '- If accessibility evidence is missing or visual layering is ambiguous, call takeScreenshot before choosing coordinates.' : '',
    allowedTypes.includes('file') ? '- For file action="download", put an absolute URL in params.url, an origin-relative path like /files/a.pdf, or a page-relative path like report/a.pdf in params.path/urlOrPath. For action="writeMarkdown", put the complete Markdown document in params.content and the desired file name in params.fileName. For action="read", provide exactly one attachmentId or artifactId. The final visible answer must include a requested saved file\'s returned download link as a clickable Markdown link.' : '',
    '- For a browser action, set type to the tool name and put the original tool arguments in params, including reason.',
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
