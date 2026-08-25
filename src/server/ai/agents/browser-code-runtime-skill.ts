export const browserCodeRuntimeSkillId = 'system-browser-code-runtime';

export const browserCodeRuntimeSkillSummary = [
  '<system_skill>',
  `<id>${browserCodeRuntimeSkillId}</id>`,
  '<title>Browser Code Runtime</title>',
  '<description>Hidden built-in API reference and operating manual for browserCode. Read it before the first browserCode call in every Agent run.</description>',
  '<required>true</required>',
  '</system_skill>',
].join('\n');

export const browserCodeRuntimeSkillContent = `# Browser Code Runtime

This hidden built-in Skill is the authoritative API reference and operating contract for browserCode. Read it once in the current Agent run before the first browserCode call.

## Required state machine

1. Read this Skill in its own model step:

\`\`\`json
{ "action": "read", "skillId": "${browserCodeRuntimeSkillId}", "reason": "读取浏览器代码 API 与运行规范" }
\`\`\`

Provider-neutral call notation: \`skill({ action: "read", skillId: "${browserCodeRuntimeSkillId}" })\`.

2. Call \`readBrowserState\` in a separate model step for every new or resumed browser request. It returns the current conversation-owned tabs, selected URL/title, and a current page snapshot.
3. Inspect and use that result as the initial read-only observation. Do not repeat the same tabs/URL/title/snapshot inventory in another browserCode cell. Add a targeted read only when an exact locator, frame, or surface fact needed for the next action is absent or stale.
4. Use browserCode for bounded read or action cells. A cell may contain multiple dependent operations only when each later target is confirmed by an intervening targeted read.
5. Verify the requested business outcome with a final read-only cell. Also inspect \`await page.activeSurface()\` and resolve or disclose any unexpected remaining popup.

If the runtime rejects a governed call, follow its \`requiredSkillId\` and \`requiredNextAction\`, preserve the failed code/locator/error, refresh only the evidence that became stale, and continue the same page transaction.

## Host tool boundary

These are model tools, not JavaScript globals:

- \`skill({ action: "read", skillId, reason })\` loads one exact Skill for the current Agent run.
- \`readBrowserState({ reason })\` performs the non-mutating browser preflight. Its result is sufficient initial tabs/page/snapshot evidence; do not duplicate it automatically in browserCode.
- \`browserCode({ reason, code, maxOutputChars? })\` executes one JavaScript cell. \`reason\` is a concise description of the exact read/action; \`code\` is 1-40,000 characters; \`maxOutputChars\`, when supplied, is at least 1,000.

The outer browserCode result is \`{ ok, actual, requiredNextAction?, failureCategory?, dependencyFailures?, referenceImagePaths? }\`. \`actual\` is JSON text containing \`{ ok, result, error, aborted, elapsedMs, finalPage, verification?, domChanges?, images, imageErrors }\`. Parse the tool result semantically: \`domChanges\` is only the incremental journal caused by that cell, not a full snapshot; \`dependencyFailures\` is a once-only queue of recent request failures and HTTP 408/429/5xx observations.

## Cell syntax and result contract

browserCode accepts ordinary JavaScript with top-level await. The bindings \`page\`, \`context\`, \`browser\`, and \`tab\` already exist; do not import Playwright.

- Top-level bindings persist between cells. Prefer \`var\` for reusable bindings or use a fresh name in each cell; redeclaring the same top-level \`let\` or \`const\` can fail.
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
- \`await browser.documentation(): Promise<string>\` — short runtime-generated capability/timeout summary. This Skill remains the full contract.

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

To let a non-visual model inspect the numeric rect before choosing a point, return it in one cell and click in the next; top-level \`var\` preserves the binding:

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

- Preserve the exact failed code, locator, action, and error. Follow the returned category-specific \`requiredNextAction\` once.
- Actionability/zero-match: refresh the target region and active surface, then rebuild the locator from new evidence.
- Screenshot timeout: switch to DOM/locator/value evidence; do not loop through screenshot variants unless pixels are essential.
- Execution context destroyed: wait once for a concrete load state/URL, reacquire locators, and avoid evaluate/reload loops.
- Serialization/output failure: map complex values to primitives and reduce the output; do not inspect private framework object graphs.
- Policy violation: use the documented safe API. Never bypass Playwright with DOM \`.click()\`, \`dispatchEvent('click')\`, or scripted DOM mutation.

Use \`force: true\` only when fresh evidence proves one exact rendered target and an intentional overlay/backdrop is the sole blocker. It is forbidden for ambiguous, hidden, detached, disabled, or unobserved targets.

## Completion contract

Playwright delivery alone is not business success. Before claiming completion, run a final read-only check for the requested URL, value, row/table state, toast, dialog, confirmation identifier, or other direct fact, plus \`page.activeSurface()\`. Report an unresolved failure or residual popup when it materially limits the outcome. Never describe a page as ready for a consequential final click if the latest verified state is on another page or no longer contains that control.
`;
