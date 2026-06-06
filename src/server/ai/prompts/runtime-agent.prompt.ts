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
  return [
    prompt,
    '',
    'Codex local mode:',
    '- AI SDK tools are unavailable for this provider. Do NOT attempt to call tools.',
    '- Return exactly one object with shape: { "type": string, "params": object }.',
    '- All user-facing params strings such as reason/action/expected/actual must be Chinese.',
    `- type must be one of: ${allowedTypes.join(', ')}.`,
    '- params MUST include every schema key; set unused values to null.',
    '- taskFrameJson must be a JSON object string; ledgerItemsJson must be a JSON array string. Use [] for no new ledger items.',
    '- In semantic params (reason/currentState/observation/findings/memory/nextGoal/action/expected/actual), do not output candidate ids, area ids, coordinates, deltas, screenshot ids/file names, or tool input JSON.',
    '- nextGoal must describe only the next unfinished target/state for the following request; do not include a tool name, candidate id, button id, or exact operation method.',
    '- For candidate actions, include targetVisual and make reason describe the current screenshot visible target text/icon/position/role before choosing id.',
    '- For scrollArea, put the S scrollable area id in params.areaId, not params.id; scroll about one visible viewport/container height per call.',
    '- For a browser action, set type to the tool name and put the original tool arguments in params, including reason.',
    '- For completion, manual verification, failure, or pure observation, use type="reportState".',
  ].join('\n');
}

export function buildPrepareStepPrompt(input: PrepareStepPromptInput) {
  return [
    input.requestPrompt,
    '',
    'Agent Loop / prepareStep context:',
    '- Current screenshot is the only actionable image; history/reference candidate ids are invalid.',
    '- Screenshot marker labels are only tool target locations. They are not page content, image/page numbers, ordering, progress, status, priority, or business meaning.',
    '- Green dashed boxes/green S labels in the current screenshot mark scrollable regions; use that visible S label for scrollArea and scroll about one visible viewport/container height per call.',
    '- Historical memory contains semantic summaries only; never infer/reuse old candidate ids, area ids, coordinates, deltas, screenshot ids, or tool input JSON.',
    '- Semantic fields must not output candidate ids, area ids, coordinates, deltas, screenshot ids/file names, or tool input JSON.',
    '- If RunState/ledgerDigest already covers a requirement area, do not restart it by habit; continue only with missing or contradicted work.',
    '- Follow RunState.nextObjective, but choose operation/id from current screenshot only.',
    '- Preserve currentState; do not downgrade completed state because the current screen is a recovery/earlier state.',
    '- Call exactly one tool. Candidate action reason should name the visible target. visualAfter defaults to replace; use append only for explicit comparison/continuity with the previous screenshot.',
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
