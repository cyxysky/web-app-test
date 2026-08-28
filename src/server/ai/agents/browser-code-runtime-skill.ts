export const browserCodeRuntimeSkillId = 'system-browser-code-runtime';

export const browserCodeRuntimeSkillSummary = [
  '<system_skill>',
  `<id>${browserCodeRuntimeSkillId}</id>`,
  '<title>Browser Code Runtime</title>',
  '<description>Hidden built-in API reference and operating manual for browserCode. The first call automatically loads and returns it while continuing the operation.</description>',
  '<required>true</required>',
  '</system_skill>',
].join('\n');

export const browserCodeRuntimeSkillContent = `# Browser Code Runtime

This hidden built-in Skill is the authoritative API reference and operating contract for browserCode. The backend loads it once per Agent run during the first browserCode call and returns it in loadedRuntimeSkill while continuing the original operation.

## Required state machine

1. Call browserCode normally. On the first call, the backend loads and returns this Skill in the same tool transaction. An explicit read remains supported but is not required:

\`\`\`json
{ "action": "read", "skillId": "${browserCodeRuntimeSkillId}", "reason": "读取浏览器代码 API 与运行规范" }
\`\`\`

Provider-neutral call notation: \`skill({ action: "read", skillId: "${browserCodeRuntimeSkillId}" })\`.

2. Call \`browserCode\` directly for every new or resumed browser request. When live-state preflight is pending, the execution layer runs \`readBrowserState\` internally, includes its complete result in \`prerequisiteResults\`, and still executes the supplied browserCode in the same tool call. Call \`readBrowserState\` explicitly only when its snapshot is itself the desired result.
3. Inspect the bundled prerequisite result and the requested browserCode result together. Do not repeat the same tabs/URL/title/snapshot inventory in another browserCode cell. Add a targeted read only when an exact locator, frame, or surface fact needed for the next action is absent or stale.
4. Use browserCode for bounded read or action cells. A cell may contain multiple dependent operations only when each later target is confirmed by an intervening targeted read.
5. Verify the requested business outcome with a final read-only cell. Also inspect \`await page.activeSurface()\` and resolve or disclose any unexpected remaining popup.

If the runtime rejects a governed call, preserve its complete error and any \`requiredSkillId\`, refresh only the evidence that became stale, and continue the same page transaction.

## Host tool boundary

These are model tools, not JavaScript globals:

- \`skill({ action: "read", skillId, reason })\` loads one exact Skill for the current Agent run.
- \`readBrowserState({ reason })\` explicitly returns the non-mutating browser preflight. When another browser tool needs it, the host executes it internally, appends its complete result to \`prerequisiteResults\`, and then executes the requested tool; use the explicit tool only when the snapshot is the requested output.
- \`browserCode({ reason, code, maxOutputChars? })\` executes one JavaScript cell. \`reason\` is a concise description of the exact read/action; \`code\` is 1-40,000 characters; \`maxOutputChars\`, when supplied, is at least 1,000.

The outer browserCode result is \`{ ok, actual, failureCategory?, dependencyFailures?, referenceImagePaths? }\`. \`actual\` is JSON text containing \`{ ok, result, error, aborted, elapsedMs, finalPage, verification?, domChanges?, images, imageErrors }\`. Parse the tool result semantically: \`domChanges\` is only the incremental journal caused by that cell, not a full snapshot; \`dependencyFailures\` is a once-only queue of recent request failures and HTTP 408/429/5xx observations. Failed results preserve the complete error and failure classification without generated recovery prose.

## Cell syntax and result contract

browserCode accepts ordinary JavaScript with top-level await. The bindings \`page\`, \`context\`, \`browser\`, and \`tab\` already exist; do not import Playwright.

- Top-level bindings persist between cells only while the current JavaScript kernel remains alive. Prefer \`var\` for short-lived reusable bindings or use a fresh name in each cell; redeclaring the same top-level \`let\` or \`const\` can fail. Use \`agent.state\` for anything needed after a kernel recycle or in a later turn.
- Do not wrap the cell in an async function, module, export, IIFE, or Markdown fence.
- Call \`nodeRepl.write(value): void\` to return compact JSON-safe evidence. Zero writes returns \`null\`; one write returns that value; multiple writes return an array in write order.
- Call \`await nodeRepl.emitImage(value, options?): Promise<{ bytes, index, mimeType }>\` with a screenshot Buffer, Uint8Array, or base64 image data URL. Supported types are PNG, JPEG, and WebP.
- \`console.log/info/warn/error\` are diagnostics, not the cell result.
- Let failed operations throw. Do not catch an exception and write \`{ ok: false }\`; a top-level result object with \`ok: false\` is treated as a failed tool result. If reporting an observed negative fact rather than an execution failure, use a domain key such as \`{ available: false }\` or \`{ matched: false }\`.
- Return primitives and small plain objects. Convert complex Playwright objects to selected strings/numbers/booleans before writing them; do not serialize Page, Locator, Response, request, or DOM object graphs.

Minimal current-state read:

\`\`\`js
var state = {
  tabs: await browser.user.openTabs(),
  url: page.url(),
  title: await page.title(),
  surface: await page.activeSurface(),
  snapshot: await page.domSnapshot(),
};
nodeRepl.write(state);
\`\`\`

Action with an actual postcondition:

\`\`\`js
var saveButton = page.getByRole('button', { name: 'Save', exact: true });
await saveButton.click();
var saved = await page.getByText('Saved', { exact: true }).isVisible();
if (!saved) throw new Error('Save completed without the observed Saved confirmation.');
nodeRepl.write({ saved, url: page.url() });
\`\`\`

The names above are examples only. Every locator-defining role, name, text, label, placeholder, test id, id, href, or attribute used in a real call must appear verbatim in the latest inspected evidence.

## Runtime API reference

### Global browser bindings

- \`page: Playwright Page\` — the currently selected page.
- \`context: Playwright BrowserContext\` — the selected page's browser context.
- \`tab: RuntimeTab\` — wrapper for the selected page.
- \`browser: BrowserRuntime\` — controlled session and tab lifecycle API.
- \`await agent.browsers.getDefault(): Promise<BrowserRuntime>\` — returns \`browser\`.
- \`await agent.browsers.get(id): Promise<BrowserRuntime>\` and \`await agent.browsers.list(): Promise<BrowserRuntime[]>\` — runtime lookup.
- \`agent.state\` — durable non-secret conversation state described below.
- \`await browser.documentation(): Promise<string>\` — short runtime-generated capability/timeout summary. This Skill remains the full contract.

### Durable conversation state

Top-level JavaScript bindings are temporary: the kernel can be recycled by age, execution count, memory, watchdog, idle release, or backend restart. Save JSON-safe values needed by later cells, later turns, or child Agents with:

\`\`\`ts
type RuntimeStateEntry = {
  key:string; value:unknown; revision:number; updatedAt:string; expiresAt?:string
};

agent.state.get({key:string}): Promise<
  | ({found:true} & RuntimeStateEntry)
  | {found:false;key:string}
>
agent.state.set({
  key:string; value:unknown; expectedRevision?:number; ttlMs?:number
}): Promise<RuntimeStateEntry>
agent.state.set(key:string, value:unknown, options?:{
  expectedRevision?:number; ttlMs?:number
}): Promise<RuntimeStateEntry>
agent.state.delete({
  key:string; expectedRevision?:number
}): Promise<{deleted:boolean;key:string;revision?:number}>
agent.state.delete(key:string, options?:{
  expectedRevision?:number
}): Promise<{deleted:boolean;key:string;revision?:number}>
agent.state.list({
  prefix?:string;limit?:number
} = {}): Promise<{items:RuntimeStateEntry[];count:number;truncated:boolean}>
agent.state.clear({prefix?:string} = {}): Promise<{deleted:number;prefix:string}>

get/delete also accept a key string, while list/clear also accept a prefix string. Object input remains the canonical form; the string overloads are safe convenience forms for ordinary browserCode cells.
\`\`\`

State is stored by the host in SQLite under the current browser conversation. It survives JavaScript-kernel recycling, browser idle release, later conversation turns, and backend restart. The parent Agent and its child Agents share the conversation state, which is deleted with the conversation.

Keys contain 1-120 printable characters. A conversation stores at most 100 keys, 64000 serialized characters per value, and 1000000 serialized characters in total. Values may contain only JSON-safe primitives, arrays, and plain records, with at most 30 nested levels. Optional ttlMs accepts 1000 milliseconds through 30 days. set increments revision; expectedRevision provides optimistic concurrency, where 0 requires a missing key.

Persist only reconstructable task data such as IDs, URLs, selectors, drafts, progress, and verified results. Never store passwords, credential values or references, cookies, authorization headers, access tokens, or other secrets. A restored selector, tab ID, URL, or observation is historical data and must be validated against the live browser before acting.

\`\`\`js
var savedProgress = await agent.state.set({
  key: 'task.progress',
  value: { step: 3, issueId: '30789' },
});
nodeRepl.write(savedProgress);
\`\`\`

### BrowserRuntime and tabs

- \`await browser.tabs.list(): Promise<RuntimeTab[]>\` — conversation-group tabs only.
- \`await browser.tabs.new(): Promise<RuntimeTab>\` — create, select, and own a blank tab.
- \`await browser.tabs.new(url): Promise<RuntimeTab>\` — create, select, and navigate.
- \`await browser.tabs.new({ url }): Promise<RuntimeTab>\` — equivalent object form.
- Concrete forms: \`browser.tabs.new("https://example.com/")\` and \`browser.tabs.new({ url: "https://example.com/" })\`.
- \`await browser.tabs.use(tabOrId): Promise<RuntimeTab>\` — select an allowed tab and update global \`page/context/tab\`.
- \`await browser.tabs.finalize({ keep }): Promise<TabInfo[]>\` — close Agent-created tabs except \`keep: [{ tab, status: "deliverable" | "handoff" }]\`.
- \`await browser.user.openTabs(): Promise<TabInfo[]>\` — returns \`id, active, url, title, groupId, groupTitle, lastOpened\` for the current conversation group.
- \`await browser.user.claimTab(tabOrId?): Promise<RuntimeTab>\` — claim/select an allowed existing tab. Omit the argument to claim the current/latest allowed page.

Each \`RuntimeTab\` exposes:

- \`tab.id: string\`
- \`tab.playwright: Page\`
- \`await tab.use(): Promise<Page>\`
- \`await tab.goto(url, options?): Promise<Response | null>\`
- \`tab.url(): string\`
- \`await tab.title(): Promise<string>\`
- \`await tab.screenshot(options?): Promise<Buffer>\`
- \`await tab.close(): Promise<void>\`
- \`tab.cua.click({ x, y, button?, clickCount? })\`
- \`tab.cua.move({ x, y, steps? })\`
- \`tab.cua.keypress({ keys })\`, \`tab.cua.type({ text })\`, and \`tab.cua.wheel({ deltaX?, deltaY? })\`

Tab examples:

\`\`\`js
var tabsNow = await browser.user.openTabs();
var wantedInfo = tabsNow.find((item) => item.url.includes('/orders'));
if (!wantedInfo) throw new Error('No observed conversation tab matches /orders.');
var wantedTab = await browser.tabs.use(wantedInfo.id);
nodeRepl.write({ id: wantedTab.id, url: page.url(), title: await page.title() });
\`\`\`

\`\`\`js
var researchTab = await browser.tabs.new('https://example.com/');
nodeRepl.write({ id: researchTab.id, url: researchTab.url(), title: await researchTab.title() });
\`\`\`

### Data collection priority

For read-only collection such as lists, searches, details, counts, and export metadata, prefer the current application's authenticated HTTP API when the exact endpoint and request shape are known from current page or network evidence. API responses are usually more complete, structured, and efficient than collecting the same data row by row from rendered UI.

- Use \`context.request.get/post/...\` for an observed same-origin endpoint. Playwright's BrowserContext request client shares the current browser context's cookies, so do not manually read, copy, inject, log, or return cookies or authorization values.
- Never guess an endpoint, method, query, body, pagination contract, or response schema. Derive it from current application/network evidence and return only the required JSON-safe fields through \`nodeRepl.write\`.
- If the API cannot be identified, is unavailable, rejects the request, omits UI-only computed state, or does not provide evidence equivalent to the rendered business state, fall back to Playwright locators and collect the visible interface content.
- This preference applies to read-only data acquisition. It does not authorize create, update, delete, approval, submission, or other state-changing requests through a backend API; perform those through the observed UI unless the user explicitly requests API mutation and the exact contract is verified.
- When API data is used to answer a page-state question, validate any material ambiguity against the rendered UI before claiming the final business result.

After \`observedApiUrl\` has been obtained from current evidence:

\`\`\`js
var apiResponse = await context.request.get(observedApiUrl);
if (!apiResponse.ok()) throw new Error(\`Observed API returned HTTP \${apiResponse.status()}\`);
var apiPayload = await apiResponse.json();
nodeRepl.write({ status: apiResponse.status(), data: apiPayload });
\`\`\`

### Inspection extensions on Page

- \`await page.domSnapshot(options?): Promise<string>\`, where \`options.scope\` is \`"active"\` (default) or \`"all"\`. The returned string contains a \`[page-state]\` JSON line plus an active-surface-scoped accessibility tree. It is a string, so do not read \`.surfaces\` from it.
- \`await page.activeSurface(): Promise<{ activeSurface?, surfaces, surfaceStack, topSurfaceIds }>\` — structured popup/overlay state. Surface records include \`id, kind, label, descriptor, modal, selector?, framePath?, parentId?, depth, zIndex, rect, signals\`.
- Ordinary Playwright reads include \`locator.count()\`, \`isVisible()\`, \`isEnabled()\`, \`isChecked()\`, \`inputValue()\`, \`innerText()\`, \`textContent()\`, \`getAttribute()\`, \`allTextContents()\`, \`ariaSnapshot()\`, and \`boundingBox()\`.
- DOM-only reads belong inside \`page.evaluate(callback, arg?)\`. Browser-page callbacks cannot access Node globals, the local filesystem, environment variables, credentials, or runtime objects such as \`nodeRepl\`.

Targeted read example:

\`\`\`js
var form = page.getByRole('form', { name: 'Booking details' });
nodeRepl.write({
  visible: await form.isVisible(),
  destination: await form.getByLabel('Destination').inputValue(),
  buttons: await form.getByRole('button').allTextContents(),
  surface: await page.activeSurface(),
});
\`\`\`

### Locator factories

Use normal Playwright composition:

- \`page.getByRole(role, { name?, exact? })\`
- \`page.getByLabel(text, { exact? })\`
- \`page.getByPlaceholder(text, { exact? })\`
- \`page.getByText(text, { exact? })\`
- \`page.getByTestId(testId)\`
- \`page.locator(selector)\`
- \`locator.getByRole(...)\`, \`locator.getByText(...)\`, \`locator.locator(...)\`, \`locator.filter(...)\`
- \`page.frameLocator(selector)\` for an observed iframe, then call Page extensions on the Page that owns the resulting locator.

Page and Locator factories automatically exclude CSS-hidden and zero-rectangle candidates before \`count()\` and positional selection. Actions then require exactly one rendered candidate that passes target-style, hit-test diagnostics, and the action-specific Playwright trial. \`first()\`, \`last()\`, and \`nth(index)\` remain validated and are allowed only when current evidence establishes the intended position.

### Actions, waits, and navigation

Normal Locator actions include:

- \`click(options?)\`, \`dblclick(options?)\`, \`hover(options?)\`
- \`fill(value, options?)\`, \`type(text, options?)\`, \`press(key, options?)\`
- \`selectOption(valueOrOptions, options?)\`
- \`check(options?)\`, \`uncheck(options?)\`, \`setChecked(checked, options?)\`
- \`dragTo(target, options?)\`, \`focus(options?)\`

Useful Page waits include \`waitForURL(urlOrRegExp, options?)\`, \`waitForLoadState(state?, options?)\`, \`locator.waitFor({ state, timeout? })\`, and \`waitForResponse(...)\`. Wait for a concrete URL, DOM state, network response, or surface transition; do not use routine fixed sleeps.

- \`await page.expectNavigation(action, options?): Promise<ActionResult>\` starts the navigation wait before invoking \`action\`. Options are \`{ url?: string | RegExp, timeoutMs?: number, waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit" }\`.
- \`await page.verifyState(input): Promise<{ ok: true, description, checks, observation }>\` is an optional assertion helper. \`input.description\` is required. Supply at least one of \`url\`, \`activeSurface\`, or \`locator\` evidence.
- \`activeSurface\` accepts \`"opened" | "closed" | "changed" | "present" | "absent"\`. Transition checks require a preceding action in the same cell.
- Locator verification accepts \`state: "visible" | "hidden" | "attached" | "detached" | "editable" | "enabled" | "checked" | "filled" | "value" | "text" | "attribute"\`, plus \`equals\`, \`includes\`, and \`attribute\` where applicable.

Navigation example:

\`\`\`js
var detailsLink = page.getByRole('link', { name: 'Order details', exact: true });
await page.expectNavigation(
  () => detailsLink.click(),
  { url: /\\/orders\\//, waitUntil: 'domcontentloaded', timeoutMs: 30000 },
);
nodeRepl.write({ url: page.url(), title: await page.title() });
\`\`\`

Form controls example:

\`\`\`js
var formRoot = page.getByRole('form', { name: 'Traveler details' });
await formRoot.getByLabel('Full name').fill('Ada Lovelace');
await formRoot.getByLabel('Seat class').selectOption({ label: 'Business' });
await formRoot.getByLabel('Direct flights only').check();
nodeRepl.write({
  name: await formRoot.getByLabel('Full name').inputValue(),
  seat: await formRoot.getByLabel('Seat class').inputValue(),
  direct: await formRoot.getByLabel('Direct flights only').isChecked(),
});
\`\`\`

## Popups, dropdowns, date/time pickers, and nested surfaces

Treat every newly opened menu, listbox, dialog, popover, calendar, or time panel as a bounded interaction transaction:

1. Click only an observed trigger.
2. Read \`page.activeSurface()\` and a snapshot/targeted state after it opens.
3. Scope choices to the observed surface or stable field container.
4. Select the observed option/date/time.
5. Do not assume selection auto-closes the popup. If it remains open, use its observed Apply/Done/OK/Close control, the observed trigger, or Escape as supported by current evidence.
6. Verify the field value and that the expected surface closed before targeting outside it.

Custom dropdown that stays open:

\`\`\`js
var cabinTrigger = page.getByRole('button', { name: 'Cabin class', exact: true });
await cabinTrigger.click();
nodeRepl.write({ surface: await page.activeSurface(), snapshot: await page.domSnapshot() });
\`\`\`

After that read exposes the exact option and Done labels, use the later action cell:

\`\`\`js
var businessOption = page.getByRole('option', { name: 'Business', exact: true });
await businessOption.click();
var afterChoice = await page.activeSurface();
if (afterChoice.activeSurface) {
  var doneButton = page.getByRole('button', { name: 'Done', exact: true });
  if (await doneButton.count() !== 1) throw new Error('Dropdown remained open and the previously observed Done control is no longer unique.');
  await doneButton.click();
}
nodeRepl.write({ value: await cabinTrigger.innerText(), surface: await page.activeSurface() });
\`\`\`

Date/time picker with an explicit confirmation starts with a read cell:

\`\`\`js
var departureField = page.getByLabel('Departure date and time');
await departureField.click();
nodeRepl.write({ surface: await page.activeSurface(), snapshot: await page.domSnapshot() });
\`\`\`

After the preceding read exposes the exact calendar/time labels, use a later action cell:

\`\`\`js
var dayButton = page.getByRole('button', { name: 'August 28, 2026', exact: true });
await dayButton.click();
var timeOption = page.getByRole('option', { name: '10:30 AM', exact: true });
await timeOption.click();
var applyDateTime = page.getByRole('button', { name: 'Apply', exact: true });
await applyDateTime.click();
var remainingSurface = await page.activeSurface();
if (remainingSurface.activeSurface) throw new Error('Date/time popup remained open after Apply.');
nodeRepl.write({ value: await departureField.inputValue(), surface: remainingSurface });
\`\`\`

These labels are illustrative. Never copy an example label into a real call unless it appears verbatim in the latest evidence.

Surface metadata is evidence, not permission. If an action fails with \`coveredBySurfaceId\` or \`activeSurfaceId\`, run one separate read-only cell returning \`await page.activeSurface()\` plus a targeted snapshot/read. Inspect that exact id, its label/descriptor/selector/stack, then wait for a loading surface to disappear or close the observed surface. Do not scroll, force, or repeat blindly.

## Precise text editing

\`await targetPage.setTextSelection(locator, spec)\` focuses a verified editable and returns \`{ start, end, selectedText, collapsed, direction, editableTextLength, verified }\`.

Selection forms:

- \`{ exactText, occurrence?, direction? }\`
- \`{ start: { offset | afterText | beforeText, occurrence? }, end?: { ... }, direction? }\`

Use the keyboard of the Page that owns the locator in the same cell:

\`\`\`js
var notes = page.getByLabel('Notes');
var selected = await page.setTextSelection(notes, { exactText: 'old date' });
await page.keyboard.insertText('new date');
nodeRepl.write({ selected, value: await notes.inputValue() });
\`\`\`

For a frame locator, determine the owning Page and call that Page's \`setTextSelection\`; do not directly mutate DOM text.

## Images and coordinates

For a vision-capable model, screenshot-to-coordinate interaction is the visual fallback when targeted DOM snapshots, role/text/label locators, frames, and active-surface inspection still cannot expose the intended visible control. Do not keep probing selectors indefinitely. Use this two-step chain:

1. In one read-only browserCode cell, capture the current viewport with \`page.screenshot({ fullPage: false })\`, emit it with \`nodeRepl.emitImage(...)\`, and end the cell without clicking.
2. In the next model step, inspect that exact screenshot and use \`page.mouse\` or \`tab.cua\` to click the visually identified viewport coordinate. The page, tab, URL, viewport, zoom, scroll position, and visible layout must still match the screenshot.
3. After the coordinate action, verify the expected DOM, URL, value, surface, or other business-state result. If the screenshot is stale or the target is not visually unambiguous, take a new screenshot instead of guessing.

Prefer DOM/Locator evidence whenever it exists. Screenshot coordinates are a fallback for controls that are genuinely visible but unavailable through usable DOM evidence, such as canvas content, non-semantic graphics, or inaccessible custom rendering.

Emit visual evidence and end the cell:

\`\`\`js
var viewportImage = await page.screenshot({ fullPage: false });
await nodeRepl.emitImage(viewportImage);
nodeRepl.write({ url: page.url(), viewport: page.viewportSize() });
\`\`\`

For a vision-capable model, a fresh viewport image visible to the model from the previous model step authorizes multiple coordinate/CUA clicks while the document, URL, viewport, zoom, scroll position, and five-minute validity remain unchanged. Screenshot-and-click in the same cell is forbidden. Full-page screenshots are read-only evidence and never authorize coordinates.

For a non-visual model, or whenever exact DOM geometry is more reliable than pixels, derive coordinates from one exact visible actionable Locator. \`boundingBox()\` records runtime rect evidence. Click only inside that returned rect; the rect may be computed and used in the same cell or written for model inspection and reused in a later cell while the page geometry remains unchanged.

\`\`\`js
var menuTrigger = page.getByRole('button', { name: 'Open menu', exact: true });
var menuRect = await menuTrigger.boundingBox();
if (!menuRect) throw new Error('The observed Open menu control has no current viewport rect.');
await page.mouse.click(
  menuRect.x + menuRect.width / 2,
  menuRect.y + menuRect.height / 2,
);
nodeRepl.write({ clickedInsideObservedRect: true });
\`\`\`

To let a non-visual model inspect the numeric rect before choosing a point, return it in one cell and click in the next. A top-level \`var\` preserves the binding only if the kernel remains alive, so reacquire the locator and rect if the result reports \`kernelReset\`:

\`\`\`js
var chart = page.locator('canvas[data-testid="sales-chart"]');
var chartRect = await chart.boundingBox();
if (!chartRect) throw new Error('The observed chart has no current viewport rect.');
nodeRepl.write({ chartRect });
\`\`\`

\`\`\`js
await page.mouse.click(chartRect.x + chartRect.width * 0.75, chartRect.y + chartRect.height * 0.40);
nodeRepl.write({ clicked: true });
\`\`\`

Never use guessed coordinates. Rect-derived clicks must stay inside the recorded rect. Both screenshot and rect evidence become stale after navigation, tab/document change, scroll, zoom, viewport change, or five minutes.

## Attachments and credentials

- \`await attachmentVault.setInputFiles(locator, attachmentId): Promise<{ uploaded, attachmentId, fileName, selectedFiles }>\` uploads one registered user attachment. Direct \`Locator/Page.setInputFiles\`, FileChooser paths, reconstructed bytes, Blob/File/Buffer payloads, and local paths are forbidden.
- \`await credentialVault.fill(locator, ref): Promise<{ filled, origin }>\` fills a registered credential only on an allowed HTTP(S) origin. Never read the filled value or return the reference.

\`\`\`js
var uploadInput = page.locator('input[type="file"][name="attachment"]');
var upload = await attachmentVault.setInputFiles(uploadInput, 'attachment-id-from-runtime-context');
nodeRepl.write(upload);
\`\`\`

\`\`\`js
var username = page.getByLabel('Username');
await credentialVault.fill(username, 'credential-ref-from-runtime-context');
nodeRepl.write({ filled: true, origin: new URL(page.url()).origin });
\`\`\`

## Failure recovery

- Preserve the exact failed code, locator, action, and complete error. Use the error and \`failureCategory\` as evidence, then choose the smallest evidence-backed correction.
- Actionability/zero-match: refresh the target region and active surface, then rebuild the locator from new evidence.
- Screenshot timeout: switch to DOM/locator/value evidence; do not loop through screenshot variants unless pixels are essential.
- Execution context destroyed: wait once for a concrete load state/URL, reacquire locators, and avoid evaluate/reload loops.
- Serialization/output failure: map complex values to primitives and reduce the output; do not inspect private framework object graphs.
- Policy violation: use the documented safe API. Never bypass Playwright with DOM \`.click()\`, \`dispatchEvent('click')\`, or scripted DOM mutation.

Use \`force: true\` only when fresh evidence proves one exact rendered target and an intentional overlay/backdrop is the sole blocker. It is forbidden for ambiguous, hidden, detached, disabled, or unobserved targets.

## Completion contract

Playwright delivery alone is not business success. Before claiming completion, run a final read-only check for the requested URL, value, row/table state, toast, dialog, confirmation identifier, or other direct fact, plus \`page.activeSurface()\`. Report an unresolved failure or residual popup when it materially limits the outcome. Never describe a page as ready for a consequential final click if the latest verified state is on another page or no longer contains that control.
`;
