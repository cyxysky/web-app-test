export function browserCodeRules() {
  return [
    '- browserCode is the only browser inspection and operation tool. Put one ordinary JavaScript cell in params.code.',
    '- The code receives the real Playwright page and context objects. Use ordinary Playwright APIs directly.',
    '- The JavaScript kernel persists for the browser session. Write top-level statements and top-level await; do not wrap the code in a function or module.',
    '- Use top-level var for reusable bindings or choose fresh names because bindings persist across calls. Emit the result with nodeRepl.write(<JSON-serializable value>).',
    '- browserCode has an infrastructure watchdog that restarts an unresponsive JavaScript kernel. Keep each cell bounded. Playwright locator/action operations default to 3000ms and navigation defaults to 30000ms, so a missing target returns control without destroying persistent bindings. Use an explicit per-operation timeout only when the page has a known longer transition.',
    '- Every browserCode result automatically includes a freshly captured full semantic DOM snapshot and the page-console delta produced during that cell, in addition to code-console output. Treat both as post-execution evidence and inspect console errors before deciding the next step.',
    '- Inspect page structure and state inside the same program. Prefer the automatically returned fresh DOM snapshot as the next call\'s locator ground truth; use page.domSnapshot() or page.evaluate only when focused evidence is needed before an action inside the current cell.',
    '- For pixel evidence, stay inside browserCode: const image = await page.screenshot({ fullPage: false }); await nodeRepl.emitImage(image). Full-page images are read-only; use viewport coordinates only from a freshly emitted viewport image.',
    '- The code runtime also exposes browser/tab: browser.tabs.list()/new()/finalize(), browser.user.openTabs()/claimTab(), tab.playwright, and tab.cua. These are JavaScript APIs inside the same browserCode tool.',
    '- DOM code belongs inside page.evaluate. The surrounding JavaScript module runs in an isolated Node process.',
    '- Do not import modules or access Node globals, local files, environment variables, cookies, browser storage, or raw credential values. When the prompt supplies a credential reference, use only await credentialVault.fill(locator, ref); never read the filled field value or write credentials/references to outputs or logs.',
  ];
}

export function browserActionRules(screenshotAvailable = true) {
  return [
    '- Default to tab.playwright.locator(...).click() (or an equivalent stable Playwright locator on the selected page) for clicks. Playwright force: true is forbidden.',
    '- If a locator click times out, do not fall back to CUA, page.mouse, DOM element.click(), dispatchEvent(), or script click. Stop and inspect the automatically returned fresh snapshot for a loading layer, popup, overlay, stale locator, detached element, or asynchronous redraw before constructing the next locator.',
    '- CUA or coordinate clicking is allowed only for a special visual control that Playwright cannot describe. Use two separate model steps: first end a browserCode cell after emitting a fresh viewport screenshot, then inspect the returned image, confirm the intended point is not obscured, and perform one coordinate click in the next browserCode cell. Same-cell screenshot-and-click is forbidden, and the runtime rejects stale evidence after navigation, viewport change, or DOM redraw.',
    '- Use stable Playwright locators for semantic elements. For native HTML <select>, call locator.selectOption(...) directly.',
    '- Combine dependent inspection and action steps in one browserCode program when their control flow is deterministic.',
    '- After every state-changing action, verify the expected business state with a targeted locator, URL, field value, toast, dialog, or table-state assertion. Playwright success does not equal business success; inspect the resulting state in the same program and use the automatic post-execution DOM and console as additional evidence.',
    '- Use scrolling only for lazy-loaded, virtualized, or viewport-created content.',
    screenshotAvailable
      ? '- Use page.mouse coordinates only in the browserCode cell after the model has received and inspected a fresh viewport screenshot from the previous cell.'
      : '- Image-coordinate targeting is unavailable; use locators or DOM inspection.',
  ];
}

export function browserContextLine() {
  return 'No page state is preloaded. Use browserCode to inspect the live page when browser evidence is needed.';
}

export function screenshotObservationRule(screenshotAvailable = true) {
  return screenshotAvailable
    ? '- The DOM snapshot and page-console delta are attached automatically, but no screenshot is attached automatically. When pixel evidence is necessary, emit it from browserCode with await nodeRepl.emitImage(await page.screenshot({ fullPage: false })); the image becomes visible to the model only in the next model step.'
    : '- No image observation is available. Use browserCode for inspection and browser operations.';
}
