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

export function currentRuntimeTimePromptLine(now = new Date()) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const localTime = new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'full',
    timeStyle: 'long',
    timeZone,
  }).format(now);
  return `Current time: ${localTime} (${timeZone}; ISO ${now.toISOString()}).`;
}

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

export function buildCodexObjectPrompt(
  prompt: string,
  allowedTypes: string[],
) {
  const answerAllowed = allowedTypes.includes('answer');
  const browserStateGatePending = allowedTypes.includes('readBrowserState')
    && !allowedTypes.includes('browserCode');
  const browserCodeEnabled = allowedTypes.includes('browserCode');
  const browserCodeMode = browserCodeEnabled;
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
    '- Do not include separate state summaries, old tool params, or tool input JSON.',
    '- In message/reason/action, do not output coordinates, screenshot ids/file names, or tool input JSON as business meaning.',
    browserStateGatePending ? '- If the request can be answered without the live browser, return type="answer" directly and do not call readBrowserState. If live browser evidence or interaction is needed, return type="readBrowserState" with only a concise Chinese params.reason; it must be the first browser tool before any browser operation becomes available.' : '',
    browserCodeMode ? '- browserCode is the real browser inspection and operation entrypoint. It can navigate with page.goto(url), open tabs with browser.tabs.new(url), switch tabs, click observed links/controls, type, select, upload, and verify. Never claim navigation/clicking is unavailable, substitute file action=download for opening a page, or ask the user to navigate manually while browserCode is available unless an actual browserCode call proves the requested operation remains unavailable. Put one ordinary JavaScript cell in params.code.' : '',
    browserCodeMode ? '- The JavaScript kernel persists across browserCode calls but may be recycled. Prefer top-level var or fresh names for temporary bindings; save non-secret JSON-safe values needed by later cells or turns with agent.state, and emit results with nodeRepl.write(<JSON-serializable value>). Once repeated rows or fields are exactly observed, update the deterministic batch in one bounded cell instead of spending one model cycle per item; wait for concrete DOM/navigation state instead of routine fixed waitForTimeout delays.' : '',
    browserCodeMode ? '- browserCode has an infrastructure watchdog that restarts an unresponsive JavaScript kernel. Keep each cell bounded. Locator/action operations default to 5000ms and navigation defaults to 30000ms, so a missing target fails the current cell without destroying persistent bindings. Add a longer explicit Playwright timeout only for a known slow transition.' : '',
    browserCodeMode ? '- The program receives real Playwright page and context objects. Write ordinary Playwright code directly. Do not import modules or access Node globals, local files, environment variables, cookies, browser storage, or raw credential values. If the prompt supplies a credential reference, fill only the intended locator with await credentialVault.fill(locator, ref); never read the filled field value or output/log credentials or references.' : '',
    browserCodeMode ? '- Every session Playwright Page exposes setTextSelection. For precise text editing in an input, textarea, or contenteditable, including frameLocator targets, call await targetPage.setTextSelection(locator, selection) on the Page that owns the locator, then use targetPage.keyboard.insertText()/press() in the same cell for insert, replace, delete, or selection extension. Do not use coordinates or direct DOM text mutation, and verify the resulting value/text.' : '',
    browserCodeMode ? '- User attachments are registered by attachmentId. For an upload-only request, do not call file and never reconstruct bytes, base64, Blob, File, Buffer, or a local path. Place and verify the editor caret first when the requested destination matters, then call attachmentVault.setInputFiles(exactFileInputLocator, attachmentId); direct Locator/Page.setInputFiles() and FileChooser.setFiles() are forbidden. Verify exactly one attachment remains at the requested destination.' : '',
    browserCodeMode ? '- DOM code belongs inside await page.evaluate((arg) => { ... }, arg). That callback executes in the browser page VM; the surrounding browserCode program executes in the isolated Node process.' : '',
    browserCodeMode ? '- The Playwright browser is server-side. page.evaluate Blob/object URLs, window.open, HTML download attributes, and page download clicks cannot deliver a file to the user browser. Use file action=download for an existing HTTP(S) resource. Create new files through action=plan → one action=generate → action=edit as needed → action=render. Generate creates one saved editable source buffer; validation failures keep that source and require further edits, never a replacement document or fallback render of an older source. Choose a stable semantic documentId on the first plan of each distinct output and reuse it exactly for every plan, generation, edit, render, and visual correction. PDF is a first-class LibreOffice-backed output. Only a rendered current-session Artifact download URL proves user delivery.' : '',
    browserCodeMode ? '- The successful readBrowserState result is the required initial read-only observation for a new or resumed browser request. It already contains the conversation tabs, active tab/group, URL/title, and current snapshot; use it directly instead of repeating the same inventory in another browserCode cell. Add a targeted read-only browserCode cell only when the exact locator/frame/surface evidence needed for the next action is absent or stale.' : '',
    browserCodeMode ? '- page.domSnapshot() is an explicit read API returning one string containing [page-state] with the full surfaces set, parallel topSurfaceIds, the active surfaceStack, plus a Playwright AX tree scoped to the most recently active top-level surface when one exists. Never access .surfaces/.topSurfaceIds/.surfaceStack on that string; use await page.activeSurface() for structured surface fields. Sibling IDs in topSurfaceIds are parallel operation scopes, not a nested stack. Use page.domSnapshot({ scope: "all" }) only when background-page context is genuinely required. Operation, navigation, and tab-change results automatically return actual.finalPage and incremental actual.domChanges, but never an automatic axTree or a separate console payload. Page console errors appear once in domChanges.extra.errors. Use nodeRepl.write(...), not console.log, to return a code result.' : '',
    browserCodeMode ? '- Use exact attributes and hierarchy from the latest explicit AX/DOM/Playwright read or incremental domChanges to plan a bounded operation sequence. Before every element action, every locator-defining role, name, text, test id, id, href, label, placeholder, or other attribute must appear verbatim in that latest evidence. If it does not, a targeted read-only inspection is mandatory; trying a plausible selector first is forbidden. Multiple operations may run in one cell. If an earlier action can change later locator assumptions, use targeted Playwright reads before continuing. After switching tabs or frames and before clipboard or keyboard input, re-establish and verify the intended editable target and focus. Current evidence wins over older tool output.' : '',
    browserCodeMode ? '- Never infer an element control type, editability, interaction sequence, or completion state from labels, appearance, or prior experience; use exact current tags, attributes, hierarchy, and newly mounted structure. An explicit ARIA role overrides the native tag for role locators: for example, <button role="treeitem"> is a treeitem, not a button. For credentialVault.fill and every Playwright Locator/Page element action, build a targeted locator from current evidence. Page and Locator factory methods automatically remove CSS-hidden matches and matches without a non-empty rendered rectangle, so count(), first(), last(), and nth() operate on the rendered set. aria-hidden changes accessibility exposure but does not by itself make a geometrically rendered target invisible or unactionable; use an exact current DOM locator when a role locator omits it. Runtime then independently runs full actionability checks on every remaining candidate and executes only the unique passing candidate. Pointer checks use the target final computed style, real hit testing, and an action-specific Playwright trial; an ancestor pointer-events:none alone does not reject the target. Other checks reject detached, disabled, inert, covered, opacity-hidden, readonly/non-editable, or otherwise invalid targets. Hidden file inputs used by setInputFiles are the sole rendered-existence exception at the action boundary. first(), last(), and nth() are allowed when the model intentionally selects a positional candidate; the selected locator still receives normal validation.' : '',
    browserCodeMode ? '- After every cell, inspect its direct result, dependencyFailures, and incremental domChanges. dependencyFailures is a once-only queue of request failures plus HTTP 408/429/5xx observed since the previous browserCode result, including failures that completed between cells. Treat each newly opened nonmodal surface as a bounded interaction transaction: before targeting outside it, verify that it closed; otherwise close it with an observed Done/Close control, its observed trigger, or Escape and verify with page.activeSurface(). Autonomously decide whether to run an explicit page.domSnapshot(), URL, DOM, value, text, or network read before the next operation. Before claiming completion, make a final read-only check of business success and page.activeSurface() and resolve unexpected residual top surfaces. Playwright delivery alone is not business success, but no specific verification helper is mandatory.' : '',
    browserCodeMode ? '- Prefer normal Playwright actionability. If fresh AX/DOM/Playwright evidence identifies one exact rendered target and proves an overlay or backdrop is intentionally blocking the normal action, use that unique Locator with force:true and verify the resulting surface state afterward. Never force an ambiguous, hidden, detached, disabled, or unobserved target. After timeout, strict-mode, zero-match, or other actionability failure, preserve the failed locator and actual count/error, obtain fresh evidence, and refine it. Never use DOM click, dispatchEvent, or script click. Coordinate actions require either valid screenshot evidence or a point inside an exact visible actionable Locator.boundingBox() rect; never guess x/y.' : '',
    browserCodeMode ? '- Pixel evidence stays in browserCode: await nodeRepl.emitImage(await page.screenshot({ fullPage: false })). A vision model must end that cell, inspect the returned viewport image, and may then perform multiple coordinate/CUA clicks while document, URL, viewport, zoom, scroll position, and five-minute validity remain unchanged; same-cell screenshot-and-click is forbidden and FullPage images are read-only. A non-visual model may resolve one exact visible actionable Locator, call boundingBox(), and click only inside the returned rect in the same or a later cell.' : '',
    browserCodeMode ? '- browser/tab are code APIs in the same kernel: browser.tabs.list()/new()/use()/finalize(), browser.user.openTabs()/claimTab(), tab.playwright, tab.cua, and tab.use(). browser.tabs.use(tab) or tab.use() switches the global page/tab binding. openTabs returns only current-conversation-group tabs with active, groupId, groupTitle, URL, and title metadata; ungrouped and other-group tabs are excluded.' : '',
    allowedTypes.includes('file') ? '- The first file call automatically loads and returns system-file-artifact-runtime while continuing the original call. Follow it for every list/read/download/plan/generate/edit/render/convert/jsApi/unoApi call and preserve the same documentId across retries.' : '',
    allowedTypes.includes('skill') ? '- For skill, set params.action="read" and provide the exact params.skillId from an available <system_skill> or user Skill summary before the governed tool action.' : '',
    allowedTypes.includes('subagent') ? '- The first subagent action="spawn" automatically loads and returns system-subagent-runtime while continuing the spawn. action="read" is ungated and accepts exactly one returned UUID in the required order.' : '',
    browserCodeEnabled ? '- For a browser action, set type="browserCode" and put the program in params.code plus a concise params.reason.' : '',
    '- Never create a dedicated failure log, verification log, transparency disclosure, or similarly named section in the final answer. Keep recovered or irrelevant low-level failures in process logs. Mention only unresolved failures that materially limit the requested outcome, briefly alongside the affected result or limitation.',
    answerAllowed
      ? '- For browser chat completion, clarification, blocked state, failure, or pure text response, set type="answer" and put the complete Chinese Markdown answer in message.'
      : '- A final answer is not available in this constrained step. Execute the required allowed tool and continue from its result.',
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
