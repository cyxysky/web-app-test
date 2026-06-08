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
    '- Return exactly one object with shape: { "type": string, "message"?: string, "params": object }.',
    '- message is optional short Chinese progress text for the user. Put explanation there, not inside tool params.',
    '- All user-facing strings such as message/reason/action/expected/actual must be Chinese.',
    `- type must be one of: ${allowedTypes.join(', ')}.`,
    '- params should include only keys required by that tool plus a concise reason.',
    '- Do not include separate state summaries, memory notes, finding lists, task frames, ledger JSON, old tool params, or tool input JSON.',
    '- In message/reason/action/expected/actual, do not output candidate ids as business meaning, area ids, coordinates, deltas, screenshot ids/file names, or tool input JSON.',
    '- For candidate actions, include targetVisual and make reason describe the current screenshot visible target text/icon/position/role before choosing id.',
    '- For scrollArea, put the S scrollable area id in params.areaId, not params.id; scroll about one visible viewport/container height per call.',
    '- For a browser action, set type to the tool name and put the original tool arguments in params, including reason.',
    '- For completion, manual verification, failure, or pure status update, use type="reportState".',
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
    '- Tool params are minimal: reason, exact tool arguments, and optional visualAfter. Do not add separate state summaries, memory notes, finding lists, task frames, or ledger JSON.',
    '- If RunState/ledgerDigest already covers a requirement area, do not restart it by habit; continue only with missing or contradicted work.',
    '- Follow RunState.nextObjective, but choose operation/id from current screenshot only.',
    '- Call exactly one tool. You may include short ordinary assistant text for progress. Candidate action reason should name the visible target. visualAfter defaults to replace; use append only for explicit comparison/continuity with the previous screenshot.',
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
