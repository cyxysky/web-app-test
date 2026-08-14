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
    browserCodeMode ? '- The JavaScript kernel persists across browserCode calls. Prefer top-level var for reusable bindings or fresh names, and emit the result with nodeRepl.write(<JSON-serializable value>). Once repeated rows or fields are exactly observed, update the deterministic batch in one bounded cell instead of spending one model cycle per item; wait for concrete DOM/navigation state instead of routine fixed waitForTimeout delays.' : '',
    browserCodeMode ? '- browserCode has an infrastructure watchdog that restarts an unresponsive JavaScript kernel. Keep each cell bounded. Locator/action operations default to 5000ms and navigation defaults to 30000ms, so a missing target fails the current cell without destroying persistent bindings. Add a longer explicit Playwright timeout only for a known slow transition.' : '',
    browserCodeMode ? '- The program receives real Playwright page and context objects. Write ordinary Playwright code directly. Do not import modules or access Node globals, local files, environment variables, cookies, browser storage, or raw credential values. If the prompt supplies a credential reference, fill only the intended locator with await credentialVault.fill(locator, ref); never read the filled field value or output/log credentials or references.' : '',
    browserCodeMode ? '- Every session Playwright Page exposes setTextSelection. For precise text editing in an input, textarea, or contenteditable, including frameLocator targets, call await targetPage.setTextSelection(locator, selection) on the Page that owns the locator, then use targetPage.keyboard.insertText()/press() in the same cell for insert, replace, delete, or selection extension. Do not use coordinates or direct DOM text mutation, and verify the resulting value/text.' : '',
    browserCodeMode ? '- User attachments are registered by attachmentId. For an upload-only request, do not call readFile and never reconstruct bytes, base64, Blob, File, Buffer, or a local path. Place and verify the editor caret first when the requested destination matters, then call attachmentVault.setInputFiles(exactFileInputLocator, attachmentId); direct Locator/Page.setInputFiles() and FileChooser.setFiles() are forbidden. Verify exactly one attachment remains at the requested destination.' : '',
    browserCodeMode ? '- DOM code belongs inside await page.evaluate((arg) => { ... }, arg). That callback executes in the browser page VM; the surrounding browserCode program executes in the isolated Node process.' : '',
    browserCodeMode ? '- The Playwright browser is server-side. page.evaluate Blob/object URLs, window.open, HTML download attributes, and page download clicks cannot deliver a file to the user browser. Use generateFile for new content, fillDocumentTemplate for an uploaded .docx template, or downloadFile for an existing HTTP(S) resource. Only a successful current-session Artifact download URL proves user delivery.' : '',
    browserCodeMode ? '- At the beginning of every new or resumed user request, before changing the browser, use a separate read-only browserCode cell to return await browser.user.openTabs(), page.url(), await page.title(), and enough current evidence chosen through page.domSnapshot() or targeted Playwright/DOM reads. Confirm the existing active tab, tab group, page identity, and relevant rendered state instead of acting from conversation history.' : '',
    browserCodeMode ? '- page.domSnapshot() is an explicit read API returning one string containing [page-state] with the full surfaces set, parallel topSurfaceIds, the active surfaceStack, plus a Playwright AX tree scoped to the most recently active top-level surface when one exists. Never access .surfaces/.topSurfaceIds/.surfaceStack on that string; use await page.activeSurface() for structured surface fields. Sibling IDs in topSurfaceIds are parallel operation scopes, not a nested stack. Use page.domSnapshot({ scope: "all" }) only when background-page context is genuinely required. Operation, navigation, and tab-change results automatically return actual.finalPage and incremental actual.domChanges, but never an automatic axTree or a separate console payload. Page console errors appear once in domChanges.extra.errors. Use nodeRepl.write(...), not console.log, to return a code result.' : '',
    browserCodeMode ? '- Use exact attributes and hierarchy from the latest explicit AX/DOM/Playwright read or incremental domChanges to plan a bounded operation sequence. Before every element action, every locator-defining role, name, text, test id, id, href, label, placeholder, or other attribute must appear verbatim in that latest evidence. If it does not, a targeted read-only inspection is mandatory; trying a plausible selector first is forbidden. Multiple operations may run in one cell. If an earlier action can change later locator assumptions, use targeted Playwright reads before continuing. After switching tabs or frames and before clipboard or keyboard input, re-establish and verify the intended editable target and focus. Current evidence wins over older tool output.' : '',
    browserCodeMode ? '- Never infer an element control type, editability, interaction sequence, or completion state from labels, appearance, or prior experience; use exact current tags, attributes, hierarchy, and newly mounted structure. An explicit ARIA role overrides the native tag for role locators: for example, <button role="treeitem"> is a treeitem, not a button. For credentialVault.fill and every Playwright Locator/Page element action, build a targeted locator from current evidence. Page and Locator factory methods automatically remove CSS-hidden matches and matches without a non-empty rendered rectangle, so count(), first(), last(), and nth() operate on the rendered set. aria-hidden changes accessibility exposure but does not by itself make a geometrically rendered target invisible or unactionable; use an exact current DOM locator when a role locator omits it. Runtime then independently runs full actionability checks on every remaining candidate and executes only the unique passing candidate. Pointer checks use the target final computed style, real hit testing, and an action-specific Playwright trial; an ancestor pointer-events:none alone does not reject the target. Other checks reject detached, disabled, inert, covered, opacity-hidden, readonly/non-editable, or otherwise invalid targets. Hidden file inputs used by setInputFiles are the sole rendered-existence exception at the action boundary. first(), last(), and nth() are allowed when the model intentionally selects a positional candidate; the selected locator still receives normal validation.' : '',
    browserCodeMode ? '- After every cell, inspect its direct result, dependencyFailures, and incremental domChanges. dependencyFailures is a once-only queue of request failures plus HTTP 408/429/5xx observed since the previous browserCode result, including failures that completed between cells. Treat each newly opened nonmodal surface as a bounded interaction transaction: before targeting outside it, verify that it closed; otherwise close it with an observed Done/Close control, its observed trigger, or Escape and verify with page.activeSurface(). Autonomously decide whether to run an explicit page.domSnapshot(), URL, DOM, value, text, or network read before the next operation. Before claiming completion, make a final read-only check of business success and page.activeSurface(), resolve or disclose unexpected residual top surfaces, and report every failed tool call. Playwright delivery alone is not business success, but no specific verification helper is mandatory.' : '',
    browserCodeMode ? '- Prefer normal Playwright actionability. If fresh AX/DOM/Playwright evidence identifies one exact rendered target and proves an overlay or backdrop is intentionally blocking the normal action, use that unique Locator with force:true and verify the resulting surface state afterward. Never force an ambiguous, hidden, detached, disabled, or unobserved target. After timeout, strict-mode, zero-match, or other actionability failure, preserve the failed locator and actual count/error, obtain fresh evidence, and refine it. Never use DOM click, dispatchEvent, or script click. Coordinates remain limited to the separately authorized visual-control flow.' : '',
    browserCodeMode ? '- Pixel evidence stays in browserCode: await nodeRepl.emitImage(await page.screenshot({ fullPage: false })). CUA or coordinates are allowed only for special visual controls Playwright cannot describe and require two model steps: end the first browserCode cell after emitting the viewport screenshot, inspect the returned image, then perform one coordinate click in the next cell. Same-cell screenshot-and-click is forbidden; document, URL, viewport, zoom, or scroll-position changes invalidate the evidence. FullPage images are read-only.' : '',
    browserCodeMode ? '- browser/tab are code APIs in the same kernel: browser.tabs.list()/new()/use()/finalize(), browser.user.openTabs()/claimTab(), tab.playwright, tab.cua, and tab.use(). browser.tabs.use(tab) or tab.use() switches the global page/tab binding. openTabs returns only current-conversation-group tabs with active, groupId, groupTitle, URL, and title metadata; ungrouped and other-group tabs are excluded.' : '',
    domMode ? '- DOM mode uses inspect for semantic page evidence, interact for exactly one operation on one current dom-* ref, browser for navigation/tabs, and takeScreenshot only when pixel evidence is needed. Its inspect results include [page-state].activeSurface facts.' : '',
    domMode ? '- Enforce OBSERVE -> ONE ACTION -> RE-OBSERVE -> VERIFY BUSINESS STATE. Before every interact, use a fresh inspect result to confirm the exact user goal, current page, [page-state].activeSurface, expected result, exact target, and loading state. Surface data is an informational overlay hint, not an action restriction. Treat each newly opened nonmodal surface as a bounded transaction and verify it closes before targeting outside it. Before claiming completion, inspect business success and activeSurface, resolve or disclose unexpected residual surfaces, and report every failed tool call. After interact, treat verification.status="failed" as a hard failure, inspect again, and do not claim completion or repeat the same action.' : '',
    domMode ? '- Begin browser work with type="inspect", params.action="capture", params.mode="full". Every DOM interaction target contains only kind="ref" and the exact dom-* ref copied from that latest inspect result. Do not send role, name, attributes, scope, target evidence, or an older ref. The backend checks current snapshot ownership only and does not compare element text, attributes, or semantic fingerprints. Use a fresh viewport screenshot and coordinates only for a purely visual control.' : '',
    domMode ? '- Ordinary ref clicks still use Playwright actionability and covering-layer checks. Only when a fresh inspect proves the exact intended action is to close the currently visible overlay may you send action="click" with params.force=true. Force skips only actionability and cover checks; current snapshot ownership remains mandatory. Never use force to make an uncertain target succeed; inspect again immediately afterward.' : '',
    domMode ? '- For a native select use type="interact", params.action="selectOption", the current select dom-* ref, and an exact params.value or params.label. For a virtualized="possible" container, use the same action with that container ref so the backend scans and selects the exact option. For credentials use params.credentialRef with the current field dom-* ref; never put the secret in params.text.' : '',
    domMode ? '- For precise text editing, use type="interact", params.action="editText", the current editable or rich-text iframe dom-* ref, params.selection, and params.operation="setSelection"|"insert"|"delete"|"replace". Use exactText+occurrence for an exact range, start without end for a caret, or start+end for a range; include text only for insert/replace, then inspect again to verify the result.' : '',
    allowedTypes.includes('downloadFile') ? '- For downloadFile, put an absolute URL in params.url, an origin-relative path like /files/a.pdf, or a page-relative path like report/a.pdf in params.path/urlOrPath. Use params.fileName only when the desired saved name is known.' : '',
    allowedTypes.includes('generateFile') ? '- For generateFile, provide params.fileName with the real extension and a coherent visual theme. LibreOffice UNO performs all Office/PDF layout. Use params.content for Word/report PDF, structured params.sheets for Excel/spreadsheet PDF, and params.slides for PowerPoint/presentation PDF; set params.documentType for PDF. Use spreadsheet formatting, formulas, freezing, filters, merges, and charts only when they improve the result. Inspect the returned rendered pages, perform at most one intentional regeneration when a visible layout defect remains, and put only the final verified download link in the answer.' : '',
    allowedTypes.includes('readFile') ? '- For readFile, provide exactly one params.attachmentId or params.artifactId. The original file is preserved while semantic text/package structure and visual pages are derived on demand. Omit params.offset/pages on the first read; use params.offset only for the exact next text segment and params.pages with up to six 1-based page numbers for later visual pages. Do not request every page at once.' : '',
    allowedTypes.includes('readSkill') ? '- For readSkill, provide the exact params.skillId from one available <skill> summary. Load a relevant Skill before performing the browser actions it governs, and do not read it again while it remains loaded.' : '',
    allowedTypes.includes('fillDocumentTemplate') ? '- For an uploaded .docx template, first use readFile and inspect its DOCX structure, then call fillDocumentTemplate with the exact templateAttachmentId, an output .docx fileName, and operations anchored to exact visible template text. Use nextCell for a table label, followingParagraph for a section heading followed by a blank paragraph, and replaceText for an exact placeholder. Do not use generateFile for template-based work because it creates a new package.' : '',
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
