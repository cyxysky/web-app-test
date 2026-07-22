export function browserCodeRules() {
  return [
    '- browserCode is the only browser inspection and operation tool. Put one ordinary JavaScript cell in params.code.',
    '- The code receives the real Playwright page and context objects. Use ordinary Playwright APIs directly.',
    '- The JavaScript kernel persists for the browser session. Write top-level statements and top-level await; do not wrap the code in a function or module.',
    '- Use top-level var for reusable bindings or choose fresh names because bindings persist across calls. Emit the result with nodeRepl.write(<JSON-serializable value>).',
    '- browserCode has no whole-cell deadline that can overwrite a completed browser action. Playwright locator/action operations default to 3000ms and navigation defaults to 30000ms so a missing target returns control without destroying persistent bindings. Use an explicit per-operation timeout only when the page has a known longer transition.',
    '- Inspect page structure and state inside the same program. Prefer a recent page.domSnapshot() as locator ground truth; use normal Playwright locators or page.evaluate for focused details. After a locator timeout or navigation, refresh the snapshot before constructing a different locator.',
    '- For pixel evidence, stay inside browserCode: const image = await page.screenshot({ fullPage: false }); await nodeRepl.emitImage(image). Full-page images are read-only; use viewport coordinates only from a freshly emitted viewport image.',
    '- The code runtime also exposes browser/tab: browser.tabs.list()/new()/finalize(), browser.user.openTabs()/claimTab(), tab.playwright, and tab.cua. These are JavaScript APIs inside the same browserCode tool.',
    '- DOM code belongs inside page.evaluate. The surrounding JavaScript module runs in an isolated Node process.',
    '- Do not import modules or access Node globals, local files, environment variables, cookies, browser storage, or raw credential values. When the prompt supplies a credential reference, use only await credentialVault.fill(locator, ref); never read the filled field value or write credentials/references to outputs or logs.',
  ];
}

export function browserActionRules(screenshotAvailable = true) {
  return [
    '- Use stable Playwright locators for semantic elements. For native HTML <select>, call locator.selectOption(...) directly.',
    '- Combine dependent inspection and action steps in one browserCode program when their control flow is deterministic.',
    '- After an action, inspect the resulting state in the same program or return the exact values needed to decide the next call.',
    '- Use scrolling only for lazy-loaded, virtualized, or viewport-created content.',
    screenshotAvailable
      ? '- Use page.mouse coordinates only when the target is derived from the latest explicit viewport screenshot.'
      : '- Image-coordinate targeting is unavailable; use locators or DOM inspection.',
  ];
}

export function browserContextLine() {
  return 'No page state is preloaded. Use browserCode to inspect the live page when browser evidence is needed.';
}

export function screenshotObservationRule(screenshotAvailable = true) {
  return screenshotAvailable
    ? '- No screenshot is attached automatically. When pixel evidence is necessary, emit it from browserCode with await nodeRepl.emitImage(await page.screenshot({ fullPage: false })).'
    : '- No image observation is available. Use browserCode for inspection and browser operations.';
}
