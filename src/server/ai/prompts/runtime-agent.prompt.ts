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
  agentStepIndex: number;
  traceLimit: number;
  allowTextResponse?: boolean;
  browserMode?: 'dom' | 'visual-markers';
};

type CustomPromptMode = 'browser-chat' | 'target';

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
    domMode ? '- DOM mode: use getPageState for a fresh full DOM snapshot plus full page text, including accessible iframe and shadow DOM content. Use getDomNodeText(id) for complete text under a returned DOM node; use clickDomNode(id,text?) with a fresh numeric node_id. Use findByText(targetText,scopeId?) only as a read-only recovery step, then clickLocator(locatorId,text?) using a returned locatorId in a later turn.' : '',
    '- For scrollArea, put the scrollable area id in params.areaId, not params.id. Do not scroll in a direction whose latest state says atBottom/atTop/atLeft/atRight or remaining distance is 0.',
    '- For getDomNodeText/clickDomNode, put the fresh DOM numeric node_id in params.id. The numeric id may be copied with or without square brackets.',
    allowedTypes.includes('downloadFile') ? '- For downloadFile, put an absolute URL in params.url, or a relative source path in params.path/urlOrPath. Use params.fileName only when the desired saved name is known.' : '',
    allowedTypes.includes('generateMarkdownFile') ? '- For generateMarkdownFile, put the complete Markdown document in params.content and the desired file name in params.fileName.' : '',
    '- For a browser action, set type to the tool name and put the original tool arguments in params, including reason.',
    answerAllowed
      ? '- For browser chat completion, clarification, blocked state, failure, or pure text response, set type="answer" and put the complete Chinese Markdown answer in message. Do not use reportState.'
      : '- For completion, manual verification, failure, or pure status update, use type="reportState".',
  ].join('\n');
}

function stringifyPromptVariable(value: unknown) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function renderCustomPromptTemplate(template: string, variables: Record<string, unknown>) {
  let rendered = String(template || '');
  for (const [key, value] of Object.entries(variables)) {
    const text = stringifyPromptVariable(value);
    rendered = rendered
      .split(`{{${key}}}`).join(text)
      .split(`{${key}}`).join(text);
  }
  return rendered.trim();
}

export function customRuntimePromptFromEnv(mode: CustomPromptMode, variables: Record<string, unknown>) {
  const enabled = mode === 'browser-chat'
    ? process.env.AI_BROWSER_CHAT_CUSTOM_PROMPT_ENABLED === 'true'
    : process.env.AI_TARGET_MODE_CUSTOM_PROMPT_ENABLED === 'true';
  if (!enabled) return '';
  const template = String(mode === 'browser-chat'
    ? process.env.AI_BROWSER_CHAT_CUSTOM_PROMPT || ''
    : process.env.AI_TARGET_MODE_CUSTOM_PROMPT || '').trim();
  if (!template) return '';
  const rendered = renderCustomPromptTemplate(template, variables);
  if (!rendered) return '';
  return [
    `User-configured ${mode === 'browser-chat' ? 'browser chat' : 'target mode'} prompt (variables rendered):`,
    rendered,
  ].join('\n');
}

export function buildPrepareStepPrompt(input: PrepareStepPromptInput) {
  const domMode = input.browserMode === 'dom';
  return [
    input.requestPrompt,
    '',
    'Agent Loop / prepareStep context:',
    domMode
      ? '- Current turn delta: use the latest getPageState observation for fresh node_ids/text; RunState.nextObjective guides the goal only.'
      : '- Current turn delta: use the latest getPageState screenshot observation/marker map for actionable ids; RunState.nextObjective guides the goal only.',
    domMode
      ? '- DOM observations are explicit tool results. Call getPageState when the current DOM/page state may be stale.'
      : '- Visual observations are explicit getPageState messages. Historical screenshot ids remain context only.',
    '- If a recent tool result saved a large output as observationId=..., call readObservation/searchObservation for omitted details instead of repeating the heavy tool.',
    domMode
      ? ''
      : '- Visual image budget: current screenshot/marker map is the actionable image; selected reference images are comparison context only and must be requested deliberately.',
    '- Current step tool attempts below are authoritative recent tool feedback; desktop=... means a local process/window change was detected outside the browser.',
    input.compressionNote,
    '',
    input.workingMemoryText,
    '',
    input.visualContextText,
    '',
    `Current step tool attempts (last ${input.traceLimit}):\n${input.currentToolAttemptsText}`,
    `Agent step: ${input.agentStepIndex + 1}`,
  ].filter(Boolean).join('\n');
}
