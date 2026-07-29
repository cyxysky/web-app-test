export function browserCodeRules() {
  return [
    '- browserCode is the primary browser inspection and operation tool. Put one ordinary JavaScript cell in params.code. Code mode has no UID-click tool.',
    '- The code receives the real Playwright page and context objects. Use ordinary Playwright APIs directly.',
    '- Before every click, hover, fill, press, select, drag, or other state-changing action, first call page.domSnapshot() for the latest page hierarchy and content. Do not act from an older snapshot or conversation history.',
    '- The JavaScript kernel persists for the browser session. Write top-level statements and top-level await; do not wrap the code in a function or module.',
    '- Use top-level var for reusable bindings or choose fresh names because bindings persist across calls. Emit the result with nodeRepl.write(<JSON-serializable value>).',
    '- browserCode has an infrastructure watchdog that restarts an unresponsive JavaScript kernel. Keep each cell bounded. Playwright locator/action operations default to 5000ms and navigation defaults to 30000ms, so a missing target returns control without destroying persistent bindings. Use an explicit per-operation timeout only when the page has a known longer transition.',
    '- browserCode always returns final page identity and code/page console deltas. After an actual browser operation, navigation, or tab change it directly returns the same incremental domChanges used by DOM mode. Pure read cells, including pure-read failures, return no automatic DOM content.',
    '- Use the latest page.domSnapshot() to understand structure, then use targeted Playwright or read-only DOM inspection as needed to identify a stable parent container by data-testid, a stable data-* attribute, or a unique exact href. Locate the intended child inside that container by semantic role or exact text, apply locator.filter({ visible: true }), call count(), and act only when count() === 1. If count() > 1, narrow the parent scope or use a stronger stable attribute; never bypass ambiguity with first(), last(), or nth(). If count() === 0, refresh the snapshot and rebuild the locator instead of clicking.',
    '- For pixel evidence, stay inside browserCode: const image = await page.screenshot({ fullPage: false }); await nodeRepl.emitImage(image). Full-page images are read-only; use viewport coordinates only from a freshly emitted viewport image.',
    '- The code runtime also exposes browser/tab: browser.tabs.list()/new()/finalize(), browser.user.openTabs()/claimTab(), tab.playwright, and tab.cua. These are JavaScript APIs inside the same browserCode tool.',
    '- DOM code belongs inside page.evaluate. The surrounding JavaScript module runs in an isolated Node process.',
    '- Do not import modules or access Node globals, local files, environment variables, cookies, browser storage, or raw credential values. When the prompt supplies a credential reference, use only await credentialVault.fill(locator, ref); never read the filled field value or write credentials/references to outputs or logs.',
  ];
}

export function browserChatCodeRules(screenshotAvailable = true) {
  return [
    '- Use browserCode for live inspection and operation. It receives the real Playwright page/context and a persistent top-level-await JavaScript kernel: keep cells bounded, use top-level var or fresh names, and return compact evidence with nodeRepl.write(...).',
    '- Each browserCode result includes final page identity plus code/page console deltas. Actual browser operations, navigation, and tab changes directly include DOM mode incremental domChanges; pure reads include no automatic DOM content. Keep DOM-only code inside page.evaluate, and do not import modules or access Node globals, files, environment variables, cookies, or browser storage.',
    '- Before every click, hover, fill, press, select, drag, or other state-changing action, call page.domSnapshot() for the latest hierarchy and content. Then use targeted Playwright or read-only DOM inspection as needed to identify the stable parent container by data-testid, a stable data-* attribute, or a unique exact href; locate the child inside it by semantic role or exact text, filter({ visible: true }), call count(), and act only when count() === 1. If count() > 1, narrow the parent or use a stronger stable attribute; never use first/last/nth to hide ambiguity. If anything remains uncertain, inspect instead of acting. Use locator.selectOption(...) for native <select>.',
    '- If no normal locator uniquely identifies the rendered target, inspect fresh DOM evidence and refine the locator scope. Code mode has no UID-click tool.',
    '- Never use force:true. After a locator timeout or strict-mode failure, inspect returned domChanges when present, take a fresh page.domSnapshot(), and rebuild the locator with tighter parent scope or a stronger stable attribute; do not retry the same locator or bypass it with CUA, page.mouse, DOM click, dispatchEvent, or script click. Wait only for a known transition, scroll only for lazy/virtual content, and verify business state after every change.',
    screenshotAvailable
      ? '- For a Playwright-indescribable visual control only, emit a fresh viewport image with nodeRepl.emitImage(await page.screenshot({fullPage:false})) and end the cell; after the model sees that image, one coordinate/CUA action may be performed in the next cell. Full-page images are read-only, and navigation, viewport change, or DOM redraw invalidates the image.'
      : '- Image and coordinate targeting are unavailable; use Playwright locators or DOM evidence.',
    '- For tabs/windows, use context.pages() or the available browser.tabs/browser.user/tab.playwright/tab.cua APIs. When given a credential reference, use credentialVault.fill(locator, ref) only; never read or output credential values or references.',
  ];
}

export function browserChatDomRules(screenshotAvailable = true) {
  return [
    '- Use inspect action="capture" mode="full" for the complete loaded semantic DOM. mode="text" is the reading view of all loaded text; mode="changes" contains only inter-action changes and has no actionable UIDs.',
    '- Before every state-changing action, first understand exactly what the user wants and confirm from a fresh inspect result the current page, active dialog/layer, expected result, exact target, and loading or blocking state. If anything is uncertain or the interface may have changed, inspect again instead of acting.',
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
    '- Before every click, hover, fill, press, select, drag, or other state-changing action, call page.domSnapshot() and understand the current hierarchy, content, active layer, intended outcome, and blocking state from that latest snapshot.',
    '- Then use targeted Playwright or read-only DOM inspection as needed to identify a stable parent container using data-testid, a stable data-* attribute, or a unique exact href. Inside that container, use a semantic role or exact text, apply locator.filter({ visible: true }), call count(), and proceed only when count() === 1.',
    '- If count() > 1, narrow the parent container or switch to a stronger stable attribute. Never use first(), last(), or nth() to hide ambiguity. If count() === 0 or the snapshot does not identify the target, obtain a fresh snapshot and rebuild the locator.',
    '- Playwright force: true is forbidden. If a locator click times out or strict mode reports ambiguity, do not fall back to CUA, page.mouse, DOM element.click(), dispatchEvent(), or script click. Inspect returned domChanges when present, take a fresh page.domSnapshot(), and construct a tighter locator.',
    '- CUA or coordinate clicking is allowed only for a special visual control that Playwright cannot describe. Use two separate model steps: first end a browserCode cell after emitting a fresh viewport screenshot, then inspect the returned image, confirm the intended point is not obscured, and perform one coordinate click in the next browserCode cell. Same-cell screenshot-and-click is forbidden, and the runtime rejects stale evidence after navigation, viewport change, or DOM redraw.',
    '- Use stable Playwright locators for semantic elements. For native HTML <select>, call locator.selectOption(...) directly.',
    '- Combine dependent inspection and action steps in one browserCode program when their control flow is deterministic.',
    '- After every state-changing action, verify the expected business state with a targeted locator, URL, field value, toast, dialog, or table-state assertion. Playwright success does not equal business success; use direct domChanges and console deltas only as additional evidence.',
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
    ? '- Final page identity and console deltas are attached automatically. Actual browser operations, navigation, and tab changes also attach direct DOM mode incremental domChanges; pure reads attach no automatic DOM content. No screenshot is attached automatically. When pixel evidence is necessary, emit it from browserCode with await nodeRepl.emitImage(await page.screenshot({ fullPage: false })); the image becomes visible to the model only in the next model step.'
    : '- No image observation is available. Use browserCode for inspection and browser operations.';
}
