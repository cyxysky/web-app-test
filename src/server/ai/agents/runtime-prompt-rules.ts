export function browserCodeRules() {
  return [
    '- browserCode is the primary browser inspection and operation tool. Put one ordinary JavaScript cell in params.code. Code mode has no UID-click tool.',
    '- The code receives the real Playwright page and context objects. Use ordinary Playwright APIs directly.',
    '- The JavaScript kernel persists for the browser session. Write top-level statements and top-level await; do not wrap the code in a function or module.',
    '- Use top-level var for reusable bindings or choose fresh names because bindings persist across calls. Emit the result with nodeRepl.write(<JSON-serializable value>).',
    '- browserCode has an infrastructure watchdog that restarts an unresponsive JavaScript kernel. Keep each cell bounded. Playwright locator/action operations default to 5000ms and navigation defaults to 30000ms, so a missing target returns control without destroying persistent bindings. Use an explicit per-operation timeout only when the page has a known longer transition.',
    '- Every browserCode result automatically includes a freshly captured full semantic DOM snapshot and the page-console delta produced during that cell, in addition to code-console output. Treat both as post-execution evidence and inspect console errors before deciding the next step.',
    '- Inspect page structure and state inside the same program. Prefer the automatically returned fresh DOM snapshot as the next call\'s locator ground truth; use page.domSnapshot() or page.evaluate only when focused evidence is needed before an action inside the current cell.',
    '- For pixel evidence, stay inside browserCode: const image = await page.screenshot({ fullPage: false }); await nodeRepl.emitImage(image). Full-page images are read-only; use viewport coordinates only from a freshly emitted viewport image.',
    '- The code runtime also exposes browser/tab: browser.tabs.list()/new()/finalize(), browser.user.openTabs()/claimTab(), tab.playwright, and tab.cua. These are JavaScript APIs inside the same browserCode tool.',
    '- DOM code belongs inside page.evaluate. The surrounding JavaScript module runs in an isolated Node process.',
    '- Do not import modules or access Node globals, local files, environment variables, cookies, browser storage, or raw credential values. When the prompt supplies a credential reference, use only await credentialVault.fill(locator, ref); never read the filled field value or write credentials/references to outputs or logs.',
  ];
}

export function browserChatCodeRules(screenshotAvailable = true) {
  return [
    '- Use browserCode for live inspection and operation. It receives the real Playwright page/context and a persistent top-level-await JavaScript kernel: keep cells bounded, use top-level var or fresh names, and return compact evidence with nodeRepl.write(...).',
    '- Each browserCode result already includes a fresh full semantic DOM snapshot plus code/page console deltas. Treat them as the next-step ground truth, inspect errors, keep DOM-only code inside page.evaluate, and do not import modules or access Node globals, files, environment variables, cookies, or browser storage.',
    '- Prefer a semantic Playwright locator scoped to the visible dialog/region. For duplicate labels, filter visible candidates and require exactly one; never guess with first/last/nth. Use locator.selectOption(...) for native <select>.',
    '- If no normal locator uniquely identifies the rendered target, inspect fresh DOM evidence and refine the locator scope. Code mode has no UID-click tool.',
    '- Never use force:true. After a locator timeout, inspect the fresh snapshot for loading, overlays, popups, detachment, or redraw; do not bypass it with CUA, page.mouse, DOM click, dispatchEvent, or script click. Combine deterministic inspection/action in one cell, wait only for a known transition, scroll only for lazy/virtual content, and verify business state after every change.',
    screenshotAvailable
      ? '- For a Playwright-indescribable visual control only, emit a fresh viewport image with nodeRepl.emitImage(await page.screenshot({fullPage:false})) and end the cell; after the model sees that image, one coordinate/CUA action may be performed in the next cell. Full-page images are read-only, and navigation, viewport change, or DOM redraw invalidates the image.'
      : '- Image and coordinate targeting are unavailable; use Playwright locators or DOM evidence.',
    '- For tabs/windows, use context.pages() or the available browser.tabs/browser.user/tab.playwright/tab.cua APIs. When given a credential reference, use credentialVault.fill(locator, ref) only; never read or output credential values or references.',
  ];
}

export function browserChatDomRules(screenshotAvailable = true) {
  return [
    '- Use inspect action="capture" mode="full" for the complete loaded semantic DOM. mode="text" is the reading view of all loaded text; mode="changes" contains only inter-action changes and has no actionable UIDs.',
    '- Continue a paged frozen capture only with its exact nextCursor and the same mode. Never scroll for snapshot pagination. Use inspect action="search" to narrow the current baseline and action="httpRequests" for network evidence.',
    '- Use only current dom-* UIDs. A state-changing action returns an immediate DOM delta; any UID listed as removed is invalid. Treat validationErrors as action failure and correct the named field before continuing.',
    screenshotAvailable
      ? '- No screenshot is attached automatically. When pixel evidence is necessary, call takeScreenshot with capture="viewport" and end that model step; after inspecting the returned image, use interact with either coordinates from that latest viewport screenshot or one current UID, never both. Full-page and older screenshots are read-only evidence.'
      : '- Use interact with one current UID; coordinate targeting is unavailable.',
    '- interact supports click, hover, drag, scrolling, type, press, shortcuts, and selectOption. UID actions scroll their target into view; scroll the page only for confirmed lazy or virtual content.',
    '- For a native select, use interact action="selectOption" with its current UID and an exact option value or full label. Do not click the platform dropdown or choose with keyboard arrows.',
    '- Use browser for navigation, waiting, listing tabs, and switching tabs. After an action may open a tab, list tabs before choosing the next target.',
    '- For a supplied credential reference, use interact action="type" with a current field UID only. Never place the secret in text, read it back, or expose the reference.',
  ];
}

export function browserActionRules(screenshotAvailable = true) {
  return [
    '- Default to a semantic Playwright locator scoped to the current visible dialog or region, such as getByRole(..., { exact: true }). Before clicking duplicate text, keep only rendered candidates with locator.filter({ visible: true }) and require count() === 1. Never use first(), last(), or nth() to guess among same-name candidates.',
    '- If no normal locator uniquely identifies the rendered target, inspect fresh DOM evidence and refine the locator scope until exactly one visible Playwright target remains.',
    '- Playwright force: true is forbidden. If a locator click times out, do not fall back to CUA, page.mouse, DOM element.click(), dispatchEvent(), or script click. Stop and inspect the automatically returned fresh snapshot for a loading layer, popup, overlay, stale locator, detached element, or asynchronous redraw before constructing the next locator.',
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
