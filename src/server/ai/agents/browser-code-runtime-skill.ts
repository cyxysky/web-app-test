export const browserCodeRuntimeSkillId = 'system-browser-code-runtime';

export const browserCodeRuntimeSkillSummary = [
  '<system_skill>',
  `<id>${browserCodeRuntimeSkillId}</id>`,
  '<title>Browser Code Runtime</title>',
  '<description>Hidden built-in operating manual for browserCode. Reading it is mandatory before the first browserCode call in every Agent run.</description>',
  '<required>true</required>',
  '</system_skill>',
].join('\n');

export const browserCodeRuntimeSkillContent = `# Browser Code Runtime

This is a hidden built-in Skill. It is authoritative for the browserCode JavaScript runtime and must be read before the first browserCode call in every Agent run.

## Required sequence

1. Read this Skill with \`skill({ action: "read", skillId: "${browserCodeRuntimeSkillId}" })\`.
2. Call \`readBrowserState\` in a separate model step for every new or resumed browser request.
3. Use browserCode only after those two prerequisites have completed.

## Runtime objects

- \`page\`: the currently selected Playwright Page.
- \`context\`: the selected Playwright BrowserContext.
- \`browser\`: the controlled browser runtime.
- \`tab\`: the currently selected tab wrapper.
- \`agent.browsers.getDefault()\`: returns the browser runtime.
- \`nodeRepl.write(value)\`: returns compact JSON-safe evidence. Do not use console.log as the tool result.
- \`nodeRepl.emitImage(buffer)\`: emits an image for the next model step.
- \`attachmentVault.setInputFiles(locator, attachmentId)\`: uploads a registered user attachment without exposing a filesystem path.
- \`credentialVault.fill(locator, ref)\`: fills a registered credential without exposing its raw value.

Top-level JavaScript bindings persist between cells. Prefer \`var\` or fresh binding names. Use top-level await; do not wrap code in a function, module, export, or Markdown fence.

## Tabs and navigation

\`browser.tabs.list()\` lists tabs owned by the current conversation group.

\`browser.tabs.new()\` creates and selects a blank tab. \`browser.tabs.new("https://example.com/")\` and \`browser.tabs.new({ url: "https://example.com/" })\` create, select, and navigate a new tab.

\`browser.tabs.use(tab)\` or \`tab.use()\` selects a tab and updates the global \`page\`/\`tab\` bindings.

\`browser.tabs.finalize({ keep: [{ tab, status: "deliverable" }] })\` closes Agent-created tabs except the explicitly retained deliverable or handoff tabs.

\`browser.user.openTabs()\` returns the current conversation group's tab ids, active state, URLs, titles, group ids, and group titles. \`browser.user.claimTab(tab)\` claims an allowed existing tab.

Each tab wrapper provides \`tab.playwright\` (the Playwright Page), \`tab.goto(url, options?)\`, \`tab.url()\`, \`tab.title()\`, \`tab.screenshot(options?)\`, \`tab.close()\`, \`tab.use()\`, and \`tab.cua\`.

Use \`await page.goto(url)\` for same-tab navigation. Wait for concrete URL, DOM, or navigation state instead of routine fixed sleeps.

## Inspection

\`await page.domSnapshot()\` returns one string containing page-state metadata and a Playwright accessibility tree scoped to the active surface. Use \`await page.domSnapshot({ scope: "all" })\` only when background context is required.

\`await page.activeSurface()\` returns structured \`activeSurface\`, \`surfaces\`, \`surfaceStack\`, and \`topSurfaceIds\` data.

Use ordinary Playwright reads such as \`locator.count()\`, \`innerText()\`, \`textContent()\`, \`getAttribute()\`, \`inputValue()\`, and \`ariaSnapshot()\`. Keep DOM-only code inside \`page.evaluate(...)\`; browser-page code cannot access Node globals, files, or environment variables.

## Locators and actions

Use current observed role, name, text, label, placeholder, test id, id, href, or attribute values verbatim. Do not invent selectors. Page and Locator factories automatically exclude CSS-hidden and zero-rectangle matches.

Use Playwright actions such as \`click\`, \`dblclick\`, \`hover\`, \`fill\`, \`type\`, \`press\`, \`selectOption\`, \`check\`, \`uncheck\`, and \`dragTo\`. Actions require exactly one fully actionable rendered candidate. Do not use scripted DOM clicks. Do not bypass a failed action with \`force: true\` unless fresh evidence proves the exact unique target and the governing safety policy permits it.

For text selection in an input, textarea, contenteditable, or iframe editor, call \`await targetPage.setTextSelection(locator, spec)\`, then use \`targetPage.keyboard.insertText(...)\` or \`targetPage.keyboard.press(...)\` in the same cell.

Use \`await page.expectNavigation(() => action(), { url, timeoutMs, waitUntil })\` around actions expected to navigate. Use \`await page.verifyState(...)\` for optional explicit URL, locator-state, or active-surface verification.

## Surfaces and blocked actions

Surface metadata is evidence, not permission. If a failure reports \`coveredBySurfaceId\` or \`activeSurfaceId\`, run a separate read-only cell that returns \`await page.activeSurface()\` and a targeted snapshot/read. Find that exact surface id, inspect its label, descriptor, selector, and stack, then wait for a loading surface to disappear or close/dismiss an observed dialog, menu, popover, or backdrop before retrying the original locator.

Never scroll or retry blindly after an actionability failure. Preserve the original locator and error, refresh evidence, and follow the tool result's \`requiredNextAction\`.

## Images, coordinates, uploads, and credentials

Emit a viewport screenshot with \`await nodeRepl.emitImage(await page.screenshot({ fullPage: false }))\`. Coordinate/CUA clicks require a fresh viewport image from the previous model step; same-cell screenshot-and-click is forbidden. Full-page screenshots are read-only evidence.

Upload only through \`attachmentVault.setInputFiles(locator, attachmentId)\`. Fill secrets only through \`credentialVault.fill(locator, ref)\`. Never read or return cookies, browser storage, credential values, or local filesystem paths.

## Completion

After an operation, verify the business outcome using URL, field value, table state, toast, dialog, or another direct page fact. Inspect remaining active surfaces before claiming completion. Report unresolved tool failures and follow every returned \`requiredNextAction\`.
`;

export function browserCodeToolRequiresRuntimeSkill(toolName: string, loaded: boolean) {
  return toolName === 'browserCode' && !loaded;
}

export function browserCodeRuntimeSkillWasRead(traces: ReadonlyArray<{
  name?: string;
  input?: unknown;
  result?: { ok?: boolean };
}>) {
  return traces.some((trace) => {
    if (trace.name !== 'skill' || !trace.result?.ok) return false;
    const input = trace.input && typeof trace.input === 'object' && !Array.isArray(trace.input)
      ? trace.input as Record<string, unknown>
      : undefined;
    return input?.skillId === browserCodeRuntimeSkillId;
  });
}
