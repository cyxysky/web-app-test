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

type PrepareStepPromptInput = {
  requestPrompt: string;
  compressionNote?: string;
  workingMemoryText: string;
  visualContextText: string;
  currentToolAttemptsText: string;
  turnIndex: number;
  maxTurns: number;
  traceLimit: number;
  allowTextResponse?: boolean;
  browserMode?: 'dom' | 'visual-markers';
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
  const visualMode = allowedTypes.includes('clickCandidate');
  const domMode = allowedTypes.includes('clickDomNode') || allowedTypes.includes('getDomNodeText');
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
    '- Do not include separate state summaries, memory notes, finding lists, task frames, ledger JSON, old tool params, or tool input JSON.',
    '- In message/reason/action/expected/actual, do not output candidate ids as business meaning, area ids, coordinates, deltas, screenshot ids/file names, or tool input JSON.',
    visualMode ? '- For candidate actions, include targetVisual and make reason describe the current screenshot visible target text/icon/position/role before choosing id.' : '',
    domMode ? '- DOM mode: use the current Codex-style full DOM snapshot plus full page text, including accessible iframe and shadow DOM content. Use getDomNodeText(id) for complete text under a returned DOM node; use clickDomNode(id,text?) with a fresh numeric node_id. Use findByText(targetText,scopeId?) only as a read-only recovery step, then clickLocator(locatorId,text?) using a returned locatorId in a later turn.' : '',
    '- For scrollArea, put the scrollable area id in params.areaId, not params.id. Do not scroll in a direction whose latest state says atBottom/atTop/atLeft/atRight or remaining distance is 0.',
    '- For getDomNodeText/clickDomNode, put the fresh DOM numeric node_id in params.id. The numeric id may be copied with or without square brackets.',
    '- For a browser action, set type to the tool name and put the original tool arguments in params, including reason.',
    answerAllowed
      ? '- For browser chat completion, clarification, blocked state, failure, or pure text response, set type="answer" and put the complete Chinese Markdown answer in message. Do not use reportState.'
      : '- For completion, manual verification, failure, or pure status update, use type="reportState".',
  ].join('\n');
}

export function buildPrepareStepPrompt(input: PrepareStepPromptInput) {
  const domMode = input.browserMode === 'dom';
  return [
    input.requestPrompt,
    '',
    'Agent Loop / prepareStep context:',
    domMode
      ? '- Current turn delta: use Runtime DOM Context for fresh node_ids/text; RunState.nextObjective guides the goal only.'
      : '- Current turn delta: use only the current screenshot/marker map for actionable ids; RunState.nextObjective guides the goal only.',
    domMode
      ? '- DOM Context Manager below is the current actionable DOM/page state; scroll only if the full DOM/text context lacks lazy-loaded or viewport-dependent content.'
      : '- Visual Context Manager below is the current actionable visual state; historical screenshot ids remain context only.',
    '- Current step tool attempts below are authoritative recent tool feedback; desktop=... means a local process/window change was detected outside the browser.',
    input.compressionNote,
    '',
    input.workingMemoryText,
    '',
    input.visualContextText,
    '',
    `Current step tool attempts (last ${input.traceLimit}):\n${input.currentToolAttemptsText}`,
    `Loop turn: ${input.turnIndex + 1}/${input.maxTurns}`,
  ].filter(Boolean).join('\n');
}
