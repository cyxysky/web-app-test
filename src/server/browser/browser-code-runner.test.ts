import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { chromium, type Browser, type BrowserContext, type BrowserServer, type Page } from 'playwright';
import {
  analyzeBrowserCodeRisk,
  browserCodeHasImageOperation,
  browserCodePolicyViolation,
  BrowserCodeKernel,
  type BrowserCodeAttachmentBinding,
  type BrowserCodeCredentialBinding,
  type BrowserCodeUidReference,
} from '@webpilot/capability-browser/node';

let browserServer: BrowserServer;
let browser: Browser;
let browserContext: BrowserContext;
let page: Page;
let cdpEndpoint: string;
let kernel: BrowserCodeKernel;

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new Error('Unable to allocate test CDP port.');
  return address.port;
}

before(async () => {
  const port = await availablePort();
  cdpEndpoint = `http://127.0.0.1:${port}`;
  browserServer = await chromium.launchServer({ headless: true, args: [`--remote-debugging-port=${port}`] });
  browser = await chromium.connect(browserServer.wsEndpoint());
  browserContext = await browser.newContext();
  page = await browserContext.newPage();
  await page.setContent('<title>Editor</title><button onmouseenter="this.dataset.hovered=\'true\'" onclick="document.body.dataset.coordinateClicked=\'true\'">Save</button>');
  kernel = new BrowserCodeKernel({ protocol: 'cdp', endpoint: cdpEndpoint });
});

after(async () => {
  await kernel.close();
  await browser.close().catch(() => undefined);
  await browserServer.close().catch(() => undefined);
});

async function run(code: string, options: {
  abortSignal?: AbortSignal;
  maxOutputChars?: number;
  attachments?: BrowserCodeAttachmentBinding[];
  credentials?: BrowserCodeCredentialBinding[];
  uidReferences?: BrowserCodeUidReference[];
} = {}) {
  const executionId = randomUUID();
  await page.evaluate((id) => {
    Object.defineProperty(window, '__aiBrowserCodeExecutionId', {
      configurable: true,
      value: id,
    });
  }, executionId);
  return kernel.execute({
    code,
    executionId,
    ...options,
  });
}

test('browserCode sandbox executes ordinary Playwright code directly', async () => {
  const result = await run(`
    console.info('starting');
    var editorTitle = await page.title();
    var saveButton = page.getByRole('button', { name: 'Save' });
    var firstResult = {
      title: editorTitle,
      text: await saveButton.innerText(),
      snapshot: await page.domSnapshot(),
      url: page.url(),
      uidType: typeof page.uid,
    };
    nodeRepl.write(firstResult);
  `);

  assert.equal(result.ok, true, result.error);
  const firstValue = result.value as Record<string, unknown>;
  assert.equal(firstValue.title, 'Editor');
  assert.equal(firstValue.text, 'Save');
  assert.match(String(firstValue.snapshot), /^\[page-state\] /);
  assert.match(String(firstValue.snapshot), /\[ax-tree scope=active\]/);
  assert.match(String(firstValue.snapshot), /- button "Save"/);
  assert.equal(firstValue.url, 'about:blank');
  assert.equal(firstValue.uidType, 'undefined');
  assert.equal(result.logs.length, 1);
  assert.equal(result.logs[0].text, 'starting');
  assert.deepEqual(result.activity?.actions, []);
  assert.equal(result.activity?.navigationChanged, false);
  assert.equal(result.activity?.tabChanged, false);
  assert.equal(result.activity ? 'observation' in result.activity : false, false);
});

test('browserCode keeps the selected page when navigation clears its execution marker', async () => {
  const raceKernel = new BrowserCodeKernel({ protocol: 'cdp', endpoint: cdpEndpoint });
  const executeWithMarker = async (code: string) => {
    const executionId = randomUUID();
    await page.evaluate((id) => {
      Object.defineProperty(window, '__aiBrowserCodeExecutionId', {
        configurable: true,
        value: id,
      });
    }, executionId);
    return { executionId, pending: raceKernel.execute({ code, executionId }) };
  };
  try {
    const primed = await executeWithMarker(`nodeRepl.write(await page.title());`);
    assert.equal((await primed.pending).ok, true);

    const executionId = randomUUID();
    await page.evaluate((id) => {
      Object.defineProperty(window, '__aiBrowserCodeExecutionId', {
        configurable: true,
        value: id,
      });
    }, executionId);
    await page.goto('data:text/html,<title>Navigated during dispatch</title><main>Ready</main>');
    const recovered = await raceKernel.execute({
      code: `nodeRepl.write({ title: await page.title(), text: await page.locator('main').innerText() });`,
      executionId,
    });
    assert.equal(recovered.ok, true, recovered.error);
    assert.deepEqual(recovered.value, { title: 'Navigated during dispatch', text: 'Ready' });
  } finally {
    await raceKernel.close();
    await page.setContent('<title>Editor</title><button onmouseenter="this.dataset.hovered=\'true\'" onclick="document.body.dataset.coordinateClicked=\'true\'">Save</button>');
  }
});

test('page.getByUid resolves an exposed DOM UID to a governed Playwright locator', async () => {
  await page.setContent('<button id="uid-save" onclick="document.body.dataset.uidClicked=\'true\'">Save by UID</button>');
  await page.evaluate(() => {
    Object.defineProperty(window, '__aiDomRuntime', {
      configurable: true,
      value: {
        visibleDomElement: (ref: string) => ref === '7' ? document.querySelector('#uid-save') : undefined,
        pageObservation: () => ({
          epoch: 12,
          url: location.href,
          title: document.title,
          surfaces: [],
          surfaceStack: [],
          topSurfaceIds: [],
          surfaceTransition: 'initial',
        }),
      },
    });
  });
  const uidReferences: BrowserCodeUidReference[] = [{
    uid: 'dom-1-7',
    observationId: 'dom-observation-1',
    localRef: '7',
    label: 'Save by UID',
    descriptor: 'button#uid-save',
    line: '<button uid=dom-1-7 id="uid-save">Save by UID</button>',
    capabilities: ['click'],
  }];

  const result = await run(`
    var uidSaveButton = page.getByUid('dom-1-7');
    await uidSaveButton.click();
    nodeRepl.write({
      clicked: await page.locator('body').getAttribute('data-uid-clicked'),
      getByUidType: typeof page.getByUid,
    });
  `, { uidReferences });

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.value, { clicked: 'true', getByUidType: 'function' });
  assert.equal(await page.locator('#uid-save').getAttribute('data-ai-browser-code-uid'), null);

  const stale = await run(`page.getByUid('dom-9-9');`, { uidReferences });
  assert.equal(stale.ok, false);
  assert.match(stale.error || '', /STALE_DOM_EVIDENCE: UID dom-9-9 is not an exposed current DOM UID/i);
});

test('domSnapshot skips an unresponsive iframe instead of reaching the kernel watchdog', async () => {
  await page.setContent(`
    <title>Snapshot fallback</title>
    <button>Still visible</button>
    <iframe title="stalled-frame" srcdoc="<!doctype html><body>Frame</body>"></iframe>
  `);
  try {
    const stalledFrame = page.frames().find((frame) => frame !== page.mainFrame());
    assert.ok(stalledFrame);
    await stalledFrame.evaluate(() => {
      const stalledObservation = Function('return new Promise(function () {})') as () => Promise<never>;
      Object.defineProperty(window, '__aiDomRuntime', {
        configurable: true,
        value: { pageObservation: stalledObservation },
      });
    });

    const startedAt = Date.now();
    const result = await run(`
      var boundedSnapshot = await page.domSnapshot();
      nodeRepl.write(boundedSnapshot);
    `);

    assert.equal(result.ok, true, result.error);
    assert.ok(Date.now() - startedAt < 10_000, 'snapshot fallback should finish before the kernel watchdog');
    assert.match(String(result.value), /Still visible/);
  } finally {
    await page.setContent('<title>Editor</title><button onmouseenter="this.dataset.hovered=\'true\'" onclick="document.body.dataset.coordinateClicked=\'true\'">Save</button>');
  }
});

test('browserCode establishes caret and ranges for keyboard editing in textareas and rich-text frames', async () => {
  await page.setContent(`
    <title>Insertion editor</title>
    <label>Notes<textarea>alpha gamma</textarea></label>
    <div aria-label="Rich editor" contenteditable="true"><strong>first </strong><em>third</em></div>
    <iframe title="Frame editor" srcdoc="<!doctype html><body contenteditable='true' aria-label='Frame editor'>left right</body>"></iframe>
  `);
  try {
    const textareaResult = await run(`
      var insertionTextarea = page.getByLabel('Notes');
      var textareaSelection = await page.setTextSelection(insertionTextarea, { start: { afterText: 'alpha ' } });
      await page.keyboard.insertText('beta ');
      nodeRepl.write(textareaSelection);
    `);
    assert.equal(textareaResult.ok, true, textareaResult.error);

    const richResult = await run(`
      var insertionRichEditor = page.locator('[contenteditable="true"][aria-label="Rich editor"]');
      var richSelection = await page.setTextSelection(insertionRichEditor, { exactText: 'third' });
      await page.keyboard.insertText('second third');
      nodeRepl.write(richSelection);
    `);
    assert.equal(richResult.ok, true, richResult.error);

    const frameResult = await run(`
      var insertionFrameEditor = page.frameLocator('iframe[title="Frame editor"]').locator('body[contenteditable="true"]');
      var frameSelection = await page.setTextSelection(insertionFrameEditor, { exactText: 'right' });
      await page.keyboard.press('Backspace');
      await page.keyboard.insertText('middle right');
      nodeRepl.write({ frameSelection });
    `);
    assert.equal(frameResult.ok, true, frameResult.error);
    assert.equal((textareaResult.value as { verified?: boolean }).verified, true, JSON.stringify(textareaResult.value));
    assert.equal((richResult.value as { verified?: boolean }).verified, true, JSON.stringify({ result: richResult.value, text: await page.locator('[contenteditable="true"][aria-label="Rich editor"]').textContent() }));
    assert.equal((frameResult.value as { frameSelection?: { verified?: boolean } }).frameSelection?.verified, true, JSON.stringify({ result: frameResult.value, text: await page.frameLocator('iframe[title="Frame editor"]').locator('body').textContent() }));
    assert.equal(await page.getByLabel('Notes').inputValue(), 'alpha beta gamma');
    assert.equal(
      (await page.locator('[contenteditable="true"][aria-label="Rich editor"]').textContent())?.replace(/\u00a0/g, ' '),
      'first second third',
    );
    assert.equal(
      await page.frameLocator('iframe[title="Frame editor"]').locator('body').textContent(),
      'left middle right',
    );
  } finally {
    await page.setContent('<title>Editor</title><button onmouseenter="this.dataset.hovered=\'true\'" onclick="document.body.dataset.coordinateClicked=\'true\'">Save</button>');
  }
});

test('browserCode exposes exact text selection on every session Page', async () => {
  const secondaryPage = await browserContext.newPage();
  await secondaryPage.setContent(`
    <title>Secondary editor</title>
    <iframe title="Secondary frame" srcdoc="<!doctype html><body contenteditable='true'>date: 2026-08-12</body>"></iframe>
  `);
  try {
    const result = await run(`
      var secondaryEditorPage = context.pages().find(asyncPage => asyncPage !== page && !asyncPage.isClosed());
      if (!secondaryEditorPage) throw new Error('Secondary page was not found.');
      var secondaryEditor = secondaryEditorPage.frameLocator('iframe[title="Secondary frame"]').locator('body[contenteditable="true"]');
      var secondarySelection = await secondaryEditorPage.setTextSelection(secondaryEditor, { exactText: '2026-08-12' });
      await secondaryEditorPage.keyboard.insertText('2026-08-13');
      nodeRepl.write({
        hasSelectionHelper: typeof secondaryEditorPage.setTextSelection === 'function',
        selectedText: secondarySelection.selectedText,
      });
    `);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.value, { hasSelectionHelper: true, selectedText: '2026-08-12' });
    assert.equal(
      await secondaryPage.frameLocator('iframe[title="Secondary frame"]').locator('body').textContent(),
      'date: 2026-08-13',
    );
  } finally {
    await secondaryPage.close().catch(() => undefined);
  }
});

test('browserCode keeps JavaScript bindings across cells like the Codex kernel', async () => {
  const result = await run(`nodeRepl.write({ persistedTitle: editorTitle });`);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.value, { persistedTitle: 'Editor' });
});

test('browserCode bounds a missing locator and preserves the kernel after the failed cell', async () => {
  const startedAt = Date.now();
  const failed = await run(`
    var bindingBeforeLocatorFailure = 'still-here';
    await page.domSnapshot();
    await page.getByRole('button', { name: 'Missing button' }).click({ timeout: 3000 });
  `);
  assert.equal(failed.ok, false);
  assert.match(failed.error || '', /ACTIONABILITY_FAILED: click matched 0 elements/i);
  assert.match(failed.error || '', /ZERO_MATCH_DIAGNOSTICS/);
  assert.match(failed.error || '', /Save/);
  assert.equal(failed.activity?.actions.includes('locator.click'), false, 'a rejected candidate must not be recorded as an executed action');
  assert.ok(Date.now() - startedAt < 2_000, 'missing locator should fail before entering Playwright action timeout');

  const recovered = await run(`nodeRepl.write({ bindingBeforeLocatorFailure });`);
  assert.equal(recovered.ok, true, recovered.error);
  assert.deepEqual(recovered.value, { bindingBeforeLocatorFailure: 'still-here' });
});

test('browserCode actions do not require a same-cell domSnapshot gate', async () => {
  const hovered = await run(`
    await saveButton.hover();
    await page.verifyState({
      description: 'Save button received hover',
      locator: saveButton,
      state: 'attribute',
      attribute: 'data-hovered',
      equals: 'true',
    });
  `);
  assert.equal(hovered.ok, true, hovered.error);
  assert.ok(hovered.activity?.actions.includes('locator.hover'));
  assert.equal(hovered.activity?.verification?.status, 'passed');
});

test('browserCode auto-filters hidden candidates and permits explicit positional disambiguation', async () => {
  await page.evaluate(() => {
    const hidden = document.createElement('div');
    hidden.id = 'hidden-parent';
    hidden.style.display = 'none';
    hidden.innerHTML = `
      <button id="hidden-action">Hidden action</button>
      <button class="auto-filter-locator">Hidden locator action</button>
      <button class="auto-filter-page">Hidden page action</button>
      <input class="auto-filter-page-fill">
      <input class="hidden-file-input" type="file">
      <span class="qz-modal-title">Hidden modal title</span>
    `;
    const zeroSizedTitle = document.createElement('span');
    zeroSizedTitle.className = 'qz-modal-title';
    zeroSizedTitle.textContent = 'Zero-sized modal title';
    Object.assign(zeroSizedTitle.style, {
      display: 'block',
      height: '0',
      overflow: 'hidden',
      width: '0',
    });
    const visibleTitle = document.createElement('span');
    visibleTitle.className = 'qz-modal-title';
    visibleTitle.textContent = 'Visible modal title';
    const visibleLocatorAction = document.createElement('button');
    visibleLocatorAction.className = 'auto-filter-locator';
    visibleLocatorAction.textContent = 'Visible locator action';
    visibleLocatorAction.onclick = () => { document.body.dataset.autoFilteredLocator = 'done'; };
    const visiblePageAction = document.createElement('button');
    visiblePageAction.className = 'auto-filter-page';
    visiblePageAction.textContent = 'Visible page action';
    visiblePageAction.onclick = () => { document.body.dataset.autoFilteredPage = 'done'; };
    const visiblePageFill = document.createElement('input');
    visiblePageFill.className = 'auto-filter-page-fill';
    visiblePageFill.id = 'auto-filter-page-fill-target';
    const readonlyPageFill = document.createElement('input');
    readonlyPageFill.className = 'auto-filter-page-fill';
    readonlyPageFill.id = 'auto-filter-page-fill-readonly';
    readonlyPageFill.readOnly = true;
    const disabledAction = document.createElement('button');
    disabledAction.className = 'auto-filter-actionability';
    disabledAction.textContent = 'Disabled action';
    disabledAction.disabled = true;
    const enabledAction = document.createElement('button');
    enabledAction.className = 'auto-filter-actionability';
    enabledAction.textContent = 'Enabled action';
    enabledAction.onclick = () => { document.body.dataset.autoFilteredActionability = 'done'; };
    const transparentAction = document.createElement('button');
    transparentAction.className = 'auto-filter-opacity';
    transparentAction.textContent = 'Transparent action';
    transparentAction.style.opacity = '0';
    const opaqueAction = document.createElement('button');
    opaqueAction.className = 'auto-filter-opacity';
    opaqueAction.textContent = 'Opaque action';
    opaqueAction.onclick = () => { document.body.dataset.autoFilteredOpacity = 'done'; };
    const invalidActionA = document.createElement('button');
    invalidActionA.className = 'all-invalid-action';
    invalidActionA.disabled = true;
    const invalidActionB = invalidActionA.cloneNode(true);
    const duplicateA = document.createElement('button');
    duplicateA.className = 'duplicate-action';
    duplicateA.textContent = 'Duplicate';
    const duplicateB = duplicateA.cloneNode(true);
    const pointerEventsParent = document.createElement('div');
    pointerEventsParent.className = 'pointer-events-parent';
    pointerEventsParent.style.pointerEvents = 'none';
    const pointerEventsChild = document.createElement('button');
    pointerEventsChild.className = 'pointer-events-child';
    pointerEventsChild.style.pointerEvents = 'auto';
    pointerEventsChild.textContent = 'Child restores pointer events';
    pointerEventsChild.onclick = () => { document.body.dataset.pointerEventsChild = 'done'; };
    pointerEventsParent.append(pointerEventsChild);
    const ownPointerEventsNone = document.createElement('button');
    ownPointerEventsNone.className = 'own-pointer-events-action';
    ownPointerEventsNone.style.pointerEvents = 'none';
    ownPointerEventsNone.textContent = 'Target pointer events none';
    const ownPointerEventsAuto = document.createElement('button');
    ownPointerEventsAuto.className = 'own-pointer-events-action';
    ownPointerEventsAuto.textContent = 'Target pointer events auto';
    ownPointerEventsAuto.onclick = () => { document.body.dataset.ownPointerEventsAction = 'done'; };
    const coveredContainer = document.createElement('div');
    coveredContainer.className = 'hit-test-container';
    coveredContainer.style.display = 'inline-block';
    coveredContainer.style.position = 'relative';
    const coveredCandidate = document.createElement('button');
    coveredCandidate.className = 'hit-test-action';
    coveredCandidate.textContent = 'Covered candidate';
    const cover = document.createElement('div');
    Object.assign(cover.style, {
      background: 'rgba(255, 255, 255, 0.01)',
      inset: '0',
      position: 'absolute',
      zIndex: '2',
    });
    coveredContainer.append(coveredCandidate, cover);
    const uncoveredCandidate = document.createElement('button');
    uncoveredCandidate.className = 'hit-test-action';
    uncoveredCandidate.textContent = 'Uncovered candidate';
    uncoveredCandidate.onclick = () => { document.body.dataset.hitTestAction = 'done'; };
    const movingTrialAction = document.createElement('button');
    movingTrialAction.className = 'trial-filter-action';
    movingTrialAction.textContent = 'Moving trial candidate';
    const stableTrialAction = document.createElement('button');
    stableTrialAction.className = 'trial-filter-action';
    stableTrialAction.textContent = 'Stable trial candidate';
    stableTrialAction.onclick = () => { document.body.dataset.trialFilteredAction = 'done'; };
    document.body.append(
      hidden,
      visibleLocatorAction,
      visiblePageAction,
      readonlyPageFill,
      visiblePageFill,
      disabledAction,
      enabledAction,
      transparentAction,
      opaqueAction,
      invalidActionA,
      invalidActionB,
      duplicateA,
      duplicateB,
      pointerEventsParent,
      ownPointerEventsNone,
      ownPointerEventsAuto,
      coveredContainer,
      uncoveredCandidate,
      movingTrialAction,
      stableTrialAction,
      zeroSizedTitle,
      visibleTitle,
    );
    movingTrialAction.animate(
      [{ transform: 'translateX(0px)' }, { transform: 'translateX(24px)' }],
      { duration: 80, direction: 'alternate', iterations: Infinity },
    );
  });
  try {
    const hidden = await run(`
      await page.domSnapshot();
      await page.locator('#hidden-action').click();
    `);
    assert.equal(hidden.ok, false);
    assert.match(
      hidden.error || '',
      /matched 0 elements; 0 passed automatic visible filtering; 0 passed full actionability/i,
    );

    const hiddenFocus = await run(`
      await page.domSnapshot();
      await page.locator('#hidden-action').focus();
    `);
    assert.equal(hiddenFocus.ok, false);
    assert.match(
      hiddenFocus.error || '',
      /matched 0 elements; 0 passed automatic visible filtering; 0 passed full actionability/i,
    );

    const existingTitles = await run(`
      var modalTitles = page.locator('span.qz-modal-title');
      nodeRepl.write({
        count: await modalTitles.count(),
        firstText: await modalTitles.first().innerText(),
      });
    `);
    assert.equal(existingTitles.ok, true, existingTitles.error);
    assert.deepEqual(existingTitles.value, {
      count: 1,
      firstText: 'Visible modal title',
    });

    const autoFilteredLocator = await run(`
      await page.domSnapshot();
      await page.locator('.auto-filter-locator').click();
    `);
    assert.equal(autoFilteredLocator.ok, true, autoFilteredLocator.error);
    assert.equal(await page.locator('body').getAttribute('data-auto-filtered-locator'), 'done');

    const autoFilteredPage = await run(`
      await page.domSnapshot();
      await page.click('.auto-filter-page');
    `);
    assert.equal(autoFilteredPage.ok, true, autoFilteredPage.error);
    assert.equal(await page.locator('body').getAttribute('data-auto-filtered-page'), 'done');

    const autoFilteredPageFill = await run(`
      await page.domSnapshot();
      await page.fill('.auto-filter-page-fill', 'visible-value');
    `);
    assert.equal(autoFilteredPageFill.ok, true, autoFilteredPageFill.error);
    assert.equal(await page.locator('#auto-filter-page-fill-target').inputValue(), 'visible-value');
    assert.equal(await page.locator('#auto-filter-page-fill-readonly').inputValue(), '');
    assert.equal(await page.locator('#hidden-parent .auto-filter-page-fill').inputValue(), '');

    const autoFilteredActionability = await run(`
      await page.domSnapshot();
      await page.locator('.auto-filter-actionability').click();
    `);
    assert.equal(autoFilteredActionability.ok, true, autoFilteredActionability.error);
    assert.equal(await page.locator('body').getAttribute('data-auto-filtered-actionability'), 'done');

    const autoFilteredOpacity = await run(`
      await page.domSnapshot();
      await page.locator('.auto-filter-opacity').click();
    `);
    assert.equal(autoFilteredOpacity.ok, true, autoFilteredOpacity.error);
    assert.equal(await page.locator('body').getAttribute('data-auto-filtered-opacity'), 'done');

    const pointerEventsOverride = await run(`
      await page.domSnapshot();
      await page.locator('.pointer-events-child').click();
    `);
    assert.equal(pointerEventsOverride.ok, true, pointerEventsOverride.error);
    assert.equal(await page.locator('body').getAttribute('data-pointer-events-child'), 'done');

    const ownPointerEvents = await run(`
      await page.domSnapshot();
      await page.locator('.own-pointer-events-action').click();
    `);
    assert.equal(ownPointerEvents.ok, true, ownPointerEvents.error);
    assert.equal(await page.locator('body').getAttribute('data-own-pointer-events-action'), 'done');

    const hitTestAction = await run(`
      await page.domSnapshot();
      await page.locator('.hit-test-action').click();
    `);
    assert.equal(hitTestAction.ok, true, hitTestAction.error);
    assert.equal(await page.locator('body').getAttribute('data-hit-test-action'), 'done');

    const trialFilteredAction = await run(`
      await page.domSnapshot();
      await page.locator('.trial-filter-action').click();
    `);
    assert.equal(trialFilteredAction.ok, true, trialFilteredAction.error);
    assert.equal(await page.locator('body').getAttribute('data-trial-filtered-action'), 'done');

    await page.evaluate(() => {
      const foregroundSurface = document.createElement('div');
      foregroundSurface.className = 'foreground-surface';
      foregroundSurface.setAttribute('role', 'dialog');
      foregroundSurface.textContent = 'Foreground dialog';
      Object.assign(foregroundSurface.style, {
        background: 'white',
        height: '120px',
        left: '12px',
        position: 'fixed',
        top: '12px',
        width: '240px',
        zIndex: '100',
      });
      const backgroundTarget = document.createElement('button');
      backgroundTarget.className = 'background-behind-surface';
      backgroundTarget.textContent = 'Background target';
      backgroundTarget.style.marginTop = '3000px';
      backgroundTarget.addEventListener('click', () => { document.body.dataset.backgroundClicked = 'true'; });
      document.body.append(foregroundSurface, backgroundTarget);
    });
    const coveredBackgroundAction = await run(`
      await page.domSnapshot();
      await page.locator('.background-behind-surface').click();
    `);
    assert.equal(coveredBackgroundAction.ok, true, coveredBackgroundAction.error);
    assert.equal(await page.locator('body').getAttribute('data-background-clicked'), 'true');
    await page.locator('.foreground-surface, .background-behind-surface')
      .evaluateAll((elements) => elements.forEach((element) => element.remove()));

    await page.evaluate(() => {
      const foregroundSurface = document.createElement('div');
      foregroundSurface.className = 'portal-trigger-surface';
      foregroundSurface.setAttribute('role', 'dialog');
      foregroundSurface.textContent = 'Select trigger surface';
      Object.assign(foregroundSurface.style, {
        background: 'white',
        height: '80px',
        left: '12px',
        position: 'fixed',
        top: '12px',
        width: '220px',
        zIndex: '100',
      });
      const optionList = document.createElement('ul');
      optionList.className = 'portal-option-list';
      Object.assign(optionList.style, {
        background: 'white',
        left: '12px',
        margin: '0',
        padding: '8px',
        position: 'fixed',
        top: '104px',
        width: '220px',
        zIndex: '100',
      });
      const option = document.createElement('li');
      option.className = 'portal-sibling-option';
      option.textContent = 'Portal option';
      option.addEventListener('click', () => { document.body.dataset.portalOption = 'selected'; });
      optionList.append(option);
      document.body.append(foregroundSurface, optionList);
    });
    const portalSiblingAction = await run(`
      await page.domSnapshot();
      await page.locator('.portal-sibling-option').click();
    `);
    assert.equal(portalSiblingAction.ok, true, portalSiblingAction.error);
    assert.equal(await page.locator('body').getAttribute('data-portal-option'), 'selected');
    await page.locator('.portal-trigger-surface, .portal-option-list')
      .evaluateAll((elements) => elements.forEach((element) => element.remove()));

    const allInvalid = await run(`
      await page.domSnapshot();
      await page.locator('.all-invalid-action').click();
    `);
    assert.equal(allInvalid.ok, false);
    assert.match(
      allInvalid.error || '',
      /matched 2 elements; 2 passed automatic visible filtering; 0 passed full actionability/i,
    );

    const hiddenFileInput = await run(`
      await page.domSnapshot();
      await page.locator('.hidden-file-input').setInputFiles([]);
    `);
    assert.equal(hiddenFileInput.ok, false);
    assert.match(hiddenFileInput.error || '', /attachmentVault\.setInputFiles/);

    const ambiguous = await run(`
      await page.domSnapshot();
      await page.locator('.duplicate-action').click();
    `);
    assert.equal(ambiguous.ok, false);
    assert.match(
      ambiguous.error || '',
      /matched 2 elements; 2 passed automatic visible filtering; 2 passed full actionability/i,
    );

    const positional = await run(`
      await page.domSnapshot();
      await page.locator('.duplicate-action').first().click();
      await page.locator('.duplicate-action').last().hover();
      await page.locator('.duplicate-action').nth(1).click();
    `);
    assert.equal(positional.ok, true, positional.error);
    assert.deepEqual(positional.activity?.actions, ['locator.click', 'locator.hover', 'locator.click']);

  } finally {
    await page.locator(
      '#hidden-parent, .auto-filter-locator, .auto-filter-page, .auto-filter-page-fill, '
      + '.auto-filter-actionability, .auto-filter-opacity, .all-invalid-action, .duplicate-action, '
      + '.pointer-events-parent, .own-pointer-events-action, .hit-test-container, .hit-test-action, .trial-filter-action, '
      + '.foreground-surface, .background-behind-surface, '
      + '.qz-modal-title',
    ).evaluateAll((elements) => elements.forEach((element) => element.remove()));
    await page.locator('body').evaluate((body) => {
      delete body.dataset.autoFilteredLocator;
      delete body.dataset.autoFilteredPage;
      delete body.dataset.autoFilteredActionability;
      delete body.dataset.autoFilteredOpacity;
      delete body.dataset.pointerEventsChild;
      delete body.dataset.ownPointerEventsAction;
      delete body.dataset.hitTestAction;
      delete body.dataset.trialFilteredAction;
    });
  }
});

test('browserCode permits multiple bounded state-changing operations per cell', async () => {
  await page.evaluate(() => {
    const first = document.createElement('button');
    first.id = 'single-step-first';
    first.textContent = 'First step';
    first.onclick = () => { document.body.dataset.firstStep = 'done'; };
    const second = document.createElement('button');
    second.id = 'single-step-second';
    second.textContent = 'Second step';
    second.onmouseenter = () => { document.body.dataset.secondHover = 'done'; };
    second.onclick = () => { document.body.dataset.secondStep = 'done'; };
    document.body.append(first, second);
  });
  try {
    const result = await run(`
      await page.domSnapshot();
      await page.locator('#single-step-first').click();
      await page.verifyState({
        description: 'First step completed',
        locator: page.locator('body'),
        state: 'attribute',
        attribute: 'data-first-step',
        equals: 'done',
      });
      await page.locator('#single-step-second').hover();
      await page.locator('#single-step-second').click();
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(await page.locator('body').getAttribute('data-first-step'), 'done');
    assert.equal(await page.locator('body').getAttribute('data-second-hover'), 'done');
    assert.equal(await page.locator('body').getAttribute('data-second-step'), 'done');
    assert.deepEqual(
      result.activity?.actions.filter((action) => action === 'locator.click'),
      ['locator.click', 'locator.click'],
    );
    assert.ok(result.activity?.actions.includes('locator.hover'));
  } finally {
    await page.locator('#single-step-first, #single-step-second').evaluateAll((elements) => elements.forEach((element) => element.remove()));
    await page.locator('body').evaluate((body) => {
      delete body.dataset.firstStep;
      delete body.dataset.secondHover;
      delete body.dataset.secondStep;
    });
  }
});

test('browserCode leaves post-action verification to the model without blocking later cells', async () => {
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'pending-verification';
    button.textContent = 'Optional verification';
    button.onclick = () => {
      document.body.dataset.optionalVerification = String(
        Number(document.body.dataset.optionalVerification || '0') + 1,
      );
    };
    document.body.append(button);
  });
  try {
    const unverified = await run(`
      await page.domSnapshot();
      await page.locator('#pending-verification').click();
    `);
    assert.equal(unverified.ok, true, unverified.error);
    assert.equal(unverified.activity?.verification, undefined);
    assert.equal(await page.locator('body').getAttribute('data-optional-verification'), '1');

    const nextCell = await run(`
      await page.domSnapshot();
      await page.locator('#pending-verification').click();
    `);
    assert.equal(nextCell.ok, true, nextCell.error);
    assert.equal(await page.locator('body').getAttribute('data-optional-verification'), '2');

    const invalidLocator = await run(`
      await page.verifyState({
        description: 'Invalid locator is rejected clearly',
        locator: {},
        state: 'visible',
      });
    `);
    assert.equal(invalidLocator.ok, false);
    assert.match(invalidLocator.error || '', /Locator from the active page or a selector string/);
    assert.doesNotMatch(invalidLocator.error || '', /count is not a function/);

    const verified = await run(`
      await page.verifyState({
        description: 'Optional verification accepts a selector string',
        locator: '#pending-verification',
        state: 'visible',
      });
    `);
    assert.equal(verified.ok, true, verified.error);
    assert.equal(verified.activity?.verification?.status, 'passed');
  } finally {
    await page.locator('#pending-verification').evaluate((element) => element.remove());
    await page.locator('body').evaluate((body) => {
      delete body.dataset.optionalVerification;
    });
  }
});

test('browserCode supports non-visual coordinate clicks from exact Locator rect evidence', async () => {
  await page.goto('about:blank');
  await page.setContent(`
    <title>Rect coordinate target</title>
    <button id="rect-target" style="position:fixed;left:40px;top:40px;width:120px;height:40px"
      onclick="document.body.dataset.rectClickCount=String(Number(document.body.dataset.rectClickCount || 0)+1)">Rect target</button>
  `);
  try {
    const sameCellRect = await run(`
      var rectTarget = page.locator('#rect-target');
      var rectTargetBox = await rectTarget.boundingBox();
      if (!rectTargetBox) throw new Error('Rect target has no bounding box.');
      await page.mouse.click(
        rectTargetBox.x + rectTargetBox.width / 2,
        rectTargetBox.y + rectTargetBox.height / 2
      );
      nodeRepl.write({ rectTargetBox, clickCount: await page.locator('body').getAttribute('data-rect-click-count') });
    `);
    assert.equal(sameCellRect.ok, true, sameCellRect.error);
    assert.equal((sameCellRect.value as { clickCount?: string }).clickCount, '1');

    const returnedRect = await run(`
      var returnedRectTarget = page.locator('#rect-target');
      var returnedRectBox = await returnedRectTarget.boundingBox();
      if (!returnedRectBox) throw new Error('Rect target has no bounding box.');
      nodeRepl.write({ returnedRectBox });
    `);
    assert.equal(returnedRect.ok, true, returnedRect.error);

    const nextCellRectClick = await run(`
      await page.mouse.click(
        returnedRectBox.x + returnedRectBox.width * 0.75,
        returnedRectBox.y + returnedRectBox.height * 0.5
      );
      nodeRepl.write(await page.locator('body').getAttribute('data-rect-click-count'));
    `);
    assert.equal(nextCellRectClick.ok, true, nextCellRectClick.error);
    assert.equal(nextCellRectClick.value, '2');

    const outsideRecordedRect = await run(`
      await page.mouse.click(
        returnedRectBox.x + returnedRectBox.width + 20,
        returnedRectBox.y + returnedRectBox.height / 2
      );
    `);
    assert.equal(outsideRecordedRect.ok, false);
    assert.match(outsideRecordedRect.error || '', /point inside the current rect|point inside the recorded rect|boundingBox/);
  } finally {
    await page.goto('about:blank');
    await page.setContent('<title>Editor</title><button onmouseenter="this.dataset.hovered=\'true\'" onclick="document.body.dataset.coordinateClicked=\'true\'">Save</button>');
  }
});

test('browserCode requires screenshot review in a previous cell and reuses it for multiple clicks', async () => {
  await page.goto('about:blank');
  await page.setContent(`
    <title>Screenshot coordinate target</title>
    <button style="position:fixed;left:0;top:0;width:80px;height:50px"
      onclick="document.body.dataset.coordinateClickCount=String(Number(document.body.dataset.coordinateClickCount || 0)+1)">Save</button>
  `);
  try {
    const unobservedCoordinate = await run(`await page.mouse.click(10, 10);`);
    assert.equal(unobservedCoordinate.ok, false);
    assert.match(unobservedCoordinate.error || '', /viewport screenshot|boundingBox/);

    const sameCellCoordinate = await run(`
      var coordinateScreenshot = await page.screenshot({ fullPage: false });
      await nodeRepl.emitImage(coordinateScreenshot);
      await page.mouse.click(10, 10);
    `);
    assert.equal(sameCellCoordinate.ok, false);
    assert.match(sameCellCoordinate.error || '', /previous browserCode cell/);
    assert.equal(sameCellCoordinate.images?.length, 1);

    const reviewedScreenshot = await run(`
      await nodeRepl.emitImage(await page.screenshot({ fullPage: false }));
      nodeRepl.write({ screenshotReady: true });
    `);
    assert.equal(reviewedScreenshot.ok, true, reviewedScreenshot.error);
    assert.deepEqual(reviewedScreenshot.value, { screenshotReady: true });

    const reviewedCoordinates = await run(`
      await page.mouse.click(10, 10);
      await page.mouse.click(20, 20);
      nodeRepl.write({ clickCount: await page.locator('body').getAttribute('data-coordinate-click-count') });
    `);
    assert.equal(reviewedCoordinates.ok, true, reviewedCoordinates.error);
    assert.deepEqual(reviewedCoordinates.value, { clickCount: '2' });
  } finally {
    await page.goto('about:blank');
    await page.setContent('<title>Editor</title><button onmouseenter="this.dataset.hovered=\'true\'" onclick="document.body.dataset.coordinateClicked=\'true\'">Save</button>');
  }
});

test('browserCode keeps coordinate evidence across unrelated DOM mutations', async () => {
  const screenshot = await run(`
    await nodeRepl.emitImage(await page.screenshot({ fullPage: false }));
  `);
  assert.equal(screenshot.ok, true, screenshot.error);

  await page.evaluate(() => {
    document.body.dataset.redrawn = String(Date.now());
  });
  const coordinate = await run(`await page.mouse.click(10, 10);`);
  assert.equal(coordinate.ok, true, coordinate.error);
});

test('browserCode allows a unique rendered overlay target to use Playwright force', async () => {
  await page.evaluate(() => {
    const overlay = document.createElement('div');
    overlay.id = 'blocking-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.addEventListener('click', () => {
      document.body.dataset.forcedOverlayClick = 'true';
    });
    Object.assign(overlay.style, {
      background: 'rgba(0, 0, 0, 0.1)',
      inset: '0',
      position: 'fixed',
      zIndex: '9999',
    });
    document.body.append(overlay);
    delete document.body.dataset.forcedOverlayClick;
  });
  try {
    const forced = await run(`
      await page.locator('#blocking-overlay').click({ force: true, position: { x: 5, y: 5 } });
      nodeRepl.write(await page.locator('body').getAttribute('data-forced-overlay-click'));
    `);
    assert.equal(forced.ok, true, forced.error);
    assert.equal(forced.value, 'true');
  } finally {
    await page.locator('#blocking-overlay').evaluate((element) => element.remove()).catch(() => undefined);
  }
});

test('browserCode treats aria-hidden as accessibility metadata instead of visual hiding', async () => {
  await page.evaluate(() => {
    const menu = document.createElement('div');
    menu.id = 'rendered-aria-hidden-menu';
    menu.setAttribute('aria-hidden', 'true');
    menu.setAttribute('role', 'menu');
    Object.assign(menu.style, {
      background: 'white',
      display: 'block',
      height: '80px',
      left: '20px',
      position: 'fixed',
      top: '20px',
      visibility: 'visible',
      width: '220px',
      zIndex: '9999',
    });
    const copy = document.createElement('button');
    copy.dataset.action = 'action-copy-page-link';
    copy.textContent = 'Copy';
    copy.onclick = () => { document.body.dataset.renderedAriaHiddenClicked = 'true'; };
    menu.append(copy);
    document.body.append(menu);
    delete document.body.dataset.renderedAriaHiddenClicked;
  });
  try {
    const clicked = await run(`
      var renderedMenuTarget = page.locator('[data-action="action-copy-page-link"]');
      var renderedMenuGeometry = await renderedMenuTarget.evaluate(element => {
        var rect = element.getBoundingClientRect();
        var style = getComputedStyle(element);
        return { display: style.display, height: rect.height, visibility: style.visibility, width: rect.width };
      });
      await renderedMenuTarget.click();
      nodeRepl.write({
        clicked: await page.locator('body').getAttribute('data-rendered-aria-hidden-clicked'),
        rendered: renderedMenuGeometry.display !== 'none'
          && renderedMenuGeometry.visibility === 'visible'
          && renderedMenuGeometry.width > 0
          && renderedMenuGeometry.height > 0,
      });
    `);
    assert.equal(clicked.ok, true, clicked.error);
    assert.deepEqual(clicked.value, {
      clicked: 'true',
      rendered: true,
    });
  } finally {
    await page.locator('#rendered-aria-hidden-menu').evaluate((element) => element.remove()).catch(() => undefined);
  }
});

test('browserCode does not scroll the background when a viewport overlay blocks an offscreen target', async () => {
  await page.setContent(`
    <style>
      body { margin: 0; min-height: 3200px; }
      #blocked-offscreen-action { margin-top: 2600px; }
      #viewport-blocking-backdrop { position: fixed; inset: 0; z-index: 1000; background: rgba(0, 0, 0, 0.05); }
    </style>
    <button id="blocked-offscreen-action">Blocked offscreen action</button>
    <div id="viewport-blocking-backdrop"></div>
  `);
  try {
    await page.evaluate(() => window.scrollTo(0, 240));
    const scrollBefore = await page.evaluate(() => window.scrollY);
    const blocked = await run(`
      await page.locator('#blocked-offscreen-action').click();
    `);
    assert.equal(blocked.ok, false);
    assert.match(blocked.error || '', /Playwright click trial failed/i);
    assert.match(blocked.error || '', /intercepts pointer events/i);
    assert.equal(await page.evaluate(() => window.scrollY), scrollBefore);
  } finally {
    await page.setContent('<title>Editor</title><button onmouseenter="this.dataset.hovered=\'true\'" onclick="document.body.dataset.coordinateClicked=\'true\'">Save</button>');
  }
});

test('browserCode lets the Playwright trial decide when a viewport overlay covers a visible target', async () => {
  await page.setContent(`
    <style>
      body { margin: 0; min-height: 2200px; }
      #covered-visible-action { margin-top: 300px; }
      #loading-backdrop { position: fixed; inset: 0; z-index: 1000; background: rgba(0, 0, 0, 0.05); }
    </style>
    <button id="covered-visible-action">Covered visible action</button>
    <div id="loading-backdrop"></div>
  `);
  try {
    await page.evaluate(() => window.scrollTo(0, 240));
    const scrollBefore = await page.evaluate(() => window.scrollY);
    const blocked = await run(`
      await page.locator('#covered-visible-action').click();
    `);
    assert.equal(blocked.ok, false);
    assert.match(blocked.error || '', /intercepts pointer events/i);
    assert.doesNotMatch(blocked.error || '', /trial skipped to preserve/i);
    assert.match(blocked.error || '', /trial failed/i);
    assert.equal(await page.evaluate(() => window.scrollY), scrollBefore);
  } finally {
    await page.setContent('<title>Editor</title><button onmouseenter="this.dataset.hovered=\'true\'" onclick="document.body.dataset.coordinateClicked=\'true\'">Save</button>');
  }
});

test('browserCode runs the Playwright trial for an iframe target when the parent viewport is blocked', async () => {
  await page.setContent(`
    <style>
      body { margin: 0; min-height: 2200px; }
      iframe { display: block; height: 180px; margin-top: 300px; width: 500px; }
      #loading-backdrop { position: fixed; inset: 0; z-index: 1000; background: rgba(0, 0, 0, 0.05); }
    </style>
    <iframe id="editor-frame" srcdoc="<!doctype html><body id='tinymce' contenteditable='true'>Draft</body>"></iframe>
    <div id="loading-backdrop"></div>
  `);
  try {
    await page.evaluate(() => window.scrollTo(0, 240));
    const scrollBefore = await page.evaluate(() => window.scrollY);
    const blocked = await run(`
      await page.frameLocator('iframe#editor-frame').locator('body#tinymce').click();
    `);
    assert.equal(blocked.ok, false);
    assert.match(blocked.error || '', /iframe#editor-frame/i);
    assert.doesNotMatch(blocked.error || '', /trial skipped to preserve/i);
    assert.match(blocked.error || '', /trial failed/i);
    assert.equal(await page.evaluate(() => window.scrollY), scrollBefore);
  } finally {
    await page.setContent('<title>Editor</title><button onmouseenter="this.dataset.hovered=\'true\'" onclick="document.body.dataset.coordinateClicked=\'true\'">Save</button>');
  }
});

test('browserCode emits screenshots from the same JavaScript cell', async () => {
  const result = await run(`
    var emittedScreenshot = await page.screenshot({ type: 'png' });
    await nodeRepl.emitImage(emittedScreenshot);
    nodeRepl.write({ emitted: true });
  `);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.value, { emitted: true });
  assert.equal(result.images?.length, 1);
  assert.equal(result.images?.[0]?.mimeType, 'image/png');
  assert.equal(Buffer.from(result.images?.[0]?.data || '', 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('browserCode exposes browser and tab lifecycle as JavaScript APIs', async () => {
  const created = await run(`
    var runtimeBrowser = await agent.browsers.getDefault();
    var runtimeTab = await runtimeBrowser.tabs.new();
    await runtimeTab.playwright.setContent('<title>Runtime tab</title><button onclick="location.hash=&quot;runtime-ready&quot;">Continue</button>');
    await page.verifyState({
      description: 'Runtime tab content is ready',
      locator: page.getByRole('button', { name: 'Continue' }),
      state: 'visible',
    });
    nodeRepl.write({ created: true });
  `);
  assert.equal(created.ok, true, created.error);

  const navigated = await run(`
    runtimeTab.use();
    await runtimeTab.playwright.domSnapshot();
    await runtimeTab.playwright.expectNavigation(
      () => runtimeTab.playwright.getByRole('button', { name: 'Continue' }).click(),
      { url: /#runtime-ready$/, timeoutMs: 3000 },
    );
    await runtimeTab.playwright.verifyState({
      description: 'Runtime tab reached the expected hash',
      url: /#runtime-ready$/,
    });
    nodeRepl.write({ navigationUrl: page.url() });
  `);
  assert.equal(navigated.ok, true, navigated.error);
  assert.deepEqual(navigated.value, { navigationUrl: 'about:blank#runtime-ready' });

  const result = await run(`
    var runtimeOpenTabs = await runtimeBrowser.user.openTabs();
    await runtimeBrowser.tabs.use(runtimeTab);
    await runtimeBrowser.tabs.finalize({ keep: [{ tab: runtimeTab, status: 'deliverable' }] });
    nodeRepl.write({
      browserCount: (await agent.browsers.list()).length,
      currentTitle: await page.title(),
      hasCua: typeof tab.cua.click === 'function',
      navigationUrl: page.url(),
      openTabCount: runtimeOpenTabs.length,
    });
  `);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.value, {
    browserCount: 1,
    currentTitle: 'Runtime tab',
    hasCua: true,
    navigationUrl: 'about:blank#runtime-ready',
    openTabCount: 2,
  });
});

test('browser.tabs.new accepts a URL string and navigates the selected tab', async () => {
  const result = await run(`
    var stringUrlTab = await browser.tabs.new('data:text/html,<title>String URL tab</title><main>Opened directly</main>');
    nodeRepl.write({
      pageTitle: await page.title(),
      tabTitle: await stringUrlTab.title(),
      url: stringUrlTab.url(),
    });
  `);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.value, {
    pageTitle: 'String URL tab',
    tabTitle: 'String URL tab',
    url: 'data:text/html,<title>String URL tab</title><main>Opened directly</main>',
  });
});

test('browserCode session runtime excludes ungrouped and other-group tabs', async () => {
  const sessionGroupId = 'chat_scoped-runtime-test';
  const groupedPage = await browserContext.newPage();
  await groupedPage.setContent('<title>Scoped tab</title><main>Scoped tab</main>');
  await groupedPage.evaluate((groupId) => {
    document.documentElement.setAttribute('data-ai-web-test-session-group-id', groupId);
    document.documentElement.setAttribute('data-ai-web-test-session-group-title', 'Scoped group');
  }, sessionGroupId);
  const otherGroupPage = await browserContext.newPage();
  await otherGroupPage.setContent('<title>Other group tab</title><main>Other group tab</main>');
  await otherGroupPage.evaluate(() => {
    document.documentElement.setAttribute('data-ai-web-test-session-group-id', 'chat_other-group');
    document.documentElement.setAttribute('data-ai-web-test-session-group-title', 'Other group');
  });
  const scopedKernel = new BrowserCodeKernel(
    { protocol: 'cdp', endpoint: cdpEndpoint },
    { sessionGroupId },
  );
  try {
    const executionId = randomUUID();
    await groupedPage.evaluate((id) => {
      Object.defineProperty(window, '__aiBrowserCodeExecutionId', {
        configurable: true,
        value: id,
      });
    }, executionId);
    const result = await scopedKernel.execute({
      code: `
        var scopedOpenTabs = await browser.user.openTabs();
        var scopedSessionTabs = await browser.tabs.list();
        nodeRepl.write({ listedCount: scopedSessionTabs.length, openTabs: scopedOpenTabs });
      `,
      executionId,
    });
    assert.equal(result.ok, true, result.error);
    const value = result.value as {
      listedCount?: number;
      openTabs?: Array<{ groupId?: string; title?: string }>;
    };
    assert.equal(value.listedCount, 1);
    assert.deepEqual(value.openTabs?.map((tab) => ({ groupId: tab.groupId, title: tab.title })), [{
      groupId: sessionGroupId,
      title: 'Scoped tab',
    }]);
  } finally {
    await scopedKernel.close();
    await groupedPage.close().catch(() => undefined);
    await otherGroupPage.close().catch(() => undefined);
  }
});

test('browserCode allows normal constructor and prototype DOM code without exposing direct Node globals', async () => {
  const result = await run(`
    // Axure prototypes usually render their content inside generated containers.
    var prototypeDom = await page.evaluate(() => ({
      constructorName: document.body.constructor.name,
      prototypeConstructorName: Object.getPrototypeOf(document.body).constructor.name,
    }));
    var workspaceRead = 'allowed';
    try {
      const hostProcess = page.url.constructor('return process')();
      const fs = hostProcess.getBuiltinModule('node:fs');
      fs.readFileSync(hostProcess.cwd() + '/package.json', 'utf8');
    } catch (error) {
      workspaceRead = error && typeof error === 'object' && 'code' in error ? error.code : 'denied';
    }
    var prototypeResult = {
      ...prototypeDom,
      prototypeNote: 'Axure prototypes are ordinary page content',
      processType: typeof process,
      requireType: typeof require,
      bufferType: typeof Buffer,
      workspaceRead,
    };
    nodeRepl.write(prototypeResult);
  `);

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.value, {
    constructorName: 'HTMLBodyElement',
    prototypeConstructorName: 'HTMLBodyElement',
    prototypeNote: 'Axure prototypes are ordinary page content',
    processType: 'undefined',
    requireType: 'undefined',
    bufferType: 'undefined',
    workspaceRead: 'ERR_ACCESS_DENIED',
  });
});

test('browserCode stops an unbounded user promise on explicit abort', async () => {
  const controller = new AbortController();
  const pending = run(`
    await page.evaluate(() => { window.__browserCodeAbortTestStarted = true; });
    await new Promise(() => undefined);
  `, { abortSignal: controller.signal });
  let started = false;
  for (let attempt = 0; attempt < 100 && !started; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    started = await page.evaluate(() => Boolean((window as Window & { __browserCodeAbortTestStarted?: boolean }).__browserCodeAbortTestStarted));
  }
  assert.equal(started, true, 'browserCode cell should start before it is explicitly aborted');
  controller.abort();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);
  assert.match(result.error || '', /aborted/);
});

test('browserCode watchdog stops an unresponsive cell and restarts the kernel', async () => {
  const watchdogKernel = new BrowserCodeKernel(
    { protocol: 'cdp', endpoint: cdpEndpoint },
    { executionTimeoutMs: 250 },
  );
  const execute = async (code: string) => {
    const executionId = randomUUID();
    await page.evaluate((id) => {
      Object.defineProperty(window, '__aiBrowserCodeExecutionId', {
        configurable: true,
        value: id,
      });
    }, executionId);
    return watchdogKernel.execute({ code, executionId });
  };

  try {
    const startedAt = Date.now();
    const timedOut = await execute('await new Promise(() => undefined);');
    assert.equal(timedOut.ok, false);
    assert.match(timedOut.error || '', /timed out after 250ms/);
    assert.ok(Date.now() - startedAt < 5_000, 'watchdog should return control instead of leaving the cell pending');

    const recovered = await execute(`nodeRepl.write({ recovered: true, title: await page.title() });`);
    assert.equal(recovered.ok, true, recovered.error);
    assert.deepEqual(recovered.value, { recovered: true, title: 'Editor' });
  } finally {
    await watchdogKernel.close();
  }
});

test('browserCode recycles a persistent kernel after its execution budget', async () => {
  const rotatingKernel = new BrowserCodeKernel(
    { protocol: 'cdp', endpoint: cdpEndpoint },
    { maxExecutions: 1 },
  );
  const execute = async (code: string) => {
    const executionId = randomUUID();
    await page.evaluate((id) => {
      Object.defineProperty(window, '__aiBrowserCodeExecutionId', {
        configurable: true,
        value: id,
      });
    }, executionId);
    return rotatingKernel.execute({ code, executionId });
  };

  try {
    const first = await execute(`var memoryBoundBinding = 'retained'; nodeRepl.write(memoryBoundBinding);`);
    assert.equal(first.ok, true, first.error);
    assert.equal(first.kernelReset?.reason, 'execution-limit');

    const second = await execute(`nodeRepl.write(typeof memoryBoundBinding);`);
    assert.equal(second.ok, true, second.error);
    assert.equal(second.value, 'undefined');
  } finally {
    await rotatingKernel.close();
  }
});

test('browserCode agent state survives a kernel recycle', async () => {
  const durableValues = new Map<string, { revision: number; value: unknown }>();
  const stateKernel = new BrowserCodeKernel(
    { protocol: 'cdp', endpoint: cdpEndpoint },
    {
      maxExecutions: 1,
      runtimeState: ({ action, input }) => {
        const record = input as { key?: string; value?: unknown };
        const key = String(record.key || '');
        if (action === 'set') {
          const revision = (durableValues.get(key)?.revision || 0) + 1;
          durableValues.set(key, { revision, value: record.value });
          return { key, value: record.value, revision, updatedAt: new Date().toISOString() };
        }
        if (action === 'get') {
          const entry = durableValues.get(key);
          return entry
            ? { found: true, key, ...entry, updatedAt: new Date().toISOString() }
            : { found: false, key };
        }
        throw new Error(`Unexpected state action in test: ${action}`);
      },
    },
  );
  const execute = async (code: string) => {
    const executionId = randomUUID();
    await page.evaluate((id) => {
      Object.defineProperty(window, '__aiBrowserCodeExecutionId', {
        configurable: true,
        value: id,
      });
    }, executionId);
    return stateKernel.execute({ code, executionId });
  };

  try {
    const saved = await execute(`
      var temporaryConversationValue = 'kernel-only';
      nodeRepl.write(await agent.state.set('task.progress',{step:3,issueId:'30789'}));
    `);
    assert.equal(saved.ok, true, saved.error);
    assert.equal(saved.kernelReset?.reason, 'execution-limit');

    const restored = await execute(`
      nodeRepl.write({
        temporaryType: typeof temporaryConversationValue,
        persisted: await agent.state.get('task.progress')
      });
    `);
    assert.equal(restored.ok, true, restored.error);
    assert.equal((restored.value as { temporaryType: string }).temporaryType, 'undefined');
    assert.deepEqual((restored.value as { persisted: { value: unknown } }).persisted.value, {
      step: 3,
      issueId: '30789',
    });

    const objectForm = await execute(`
      nodeRepl.write(await agent.state.set({key:'task.object-form',value:'still-supported'}));
    `);
    assert.equal(objectForm.ok, true, objectForm.error);
    assert.equal((objectForm.value as { value: unknown }).value, 'still-supported');
  } finally {
    await stateKernel.close();
  }
});

test('browserCode returns synchronous agent state validation failures without waiting for the cell timeout', async () => {
  const stateKernel = new BrowserCodeKernel(
    { protocol: 'cdp', endpoint: cdpEndpoint },
    {
      executionTimeoutMs: 5_000,
      runtimeState: () => {
        throw new Error('agent.state value must not contain circular references.');
      },
    },
  );
  const executionId = randomUUID();
  await page.evaluate((id) => {
    Object.defineProperty(window, '__aiBrowserCodeExecutionId', {
      configurable: true,
      value: id,
    });
  }, executionId);

  try {
    const startedAt = Date.now();
    const result = await stateKernel.execute({
      code: `await agent.state.set({key:'too-large',value:'x'});`,
      executionId,
    });
    assert.equal(result.ok, false);
    assert.match(result.error || '', /must not contain circular references/);
    assert.ok(Date.now() - startedAt < 4_000, `state failure took ${Date.now() - startedAt}ms`);
  } finally {
    await stateKernel.close();
  }
});

test('browserCode truncates oversized return values', async () => {
  const result = await run(`nodeRepl.write('x'.repeat(5_000));`, { maxOutputChars: 1_000 });
  assert.equal(result.ok, true, result.error);
  assert.equal((result.value as { truncated?: boolean }).truncated, true);
  assert.equal((result.value as { originalChars?: number }).originalChars, 5_002);
});

test('browserCode restarts with a clean kernel after an aborted cell', async () => {
  const result = await run(`nodeRepl.write({ title: await page.title(), oldBinding: typeof editorTitle });`);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.value, { title: 'Editor', oldBinding: 'undefined' });
});

test('browserCode uploads registered attachments through attachmentVault only', async () => {
  await page.setContent('<title>Attachment upload</title><input id="attachment-input" type="file" hidden>');
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'browser-code-attachment-'));
  const fileName = 'drag.txt';
  const attachmentPath = path.join(tempDir, fileName);
  writeFileSync(attachmentPath, 'controlled attachment content', 'utf8');
  const attachments = [{
    name: fileName,
    path: attachmentPath,
    ref: 'attachment-test-ref',
  }];
  try {
    const direct = await run(`
      await page.locator('#attachment-input').setInputFiles('C:/untrusted/local/path.txt');
    `);
    assert.equal(direct.ok, false);
    assert.match(direct.error || '', /attachmentVault\.setInputFiles/);

    const missing = await run(`
      await attachmentVault.setInputFiles(page.locator('#attachment-input'), 'missing-attachment');
    `, { attachments });
    assert.equal(missing.ok, false);
    assert.match(missing.error || '', /unavailable for this browserCode execution/);

    const uploaded = await run(`
      await page.domSnapshot();
      var controlledUpload = await attachmentVault.setInputFiles(
        page.locator('#attachment-input'),
        'attachment-test-ref'
      );
      nodeRepl.write(controlledUpload);
    `, { attachments });
    assert.equal(uploaded.ok, true, uploaded.error);
    assert.deepEqual(uploaded.activity?.actions, ['attachment.setInputFiles']);
    assert.deepEqual(
      await page.locator('#attachment-input').evaluate((element) => Array.from(
        (element as HTMLInputElement).files || [],
        (file) => file.name,
      )),
      [fileName],
    );
    assert.equal((uploaded.value as { attachmentId?: string }).attachmentId, 'attachment-test-ref');
    assert.equal((uploaded.value as { fileName?: string }).fileName, fileName);
    assert.doesNotMatch(JSON.stringify(uploaded), new RegExp(attachmentPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    await page.setContent('<title>Editor</title><button onmouseenter="this.dataset.hovered=\'true\'" onclick="document.body.dataset.coordinateClicked=\'true\'">Save</button>');
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test('browserCode fills credential references only on an allowed origin without returning the raw value', async () => {
  await browserContext.route('http://credential.test/**', (route) => route.fulfill({
    body: `
      <title>Login</title>
      <div class="ng-login-container" style="display:none">
        <input name="username">
        <input name="password" type="password">
        <button type="submit">Hidden submit</button>
      </div>
      <input name="hidden-token" type="hidden">
      <input id="readonly-username" name="username" readonly>
      <label>Username<input name="username"></label>
      <label>Password<input name="password" type="password"></label>
    `,
    contentType: 'text/html',
  }));
  await page.goto('http://credential.test/login');
  const secret = 'vault-secret-value';
  try {
    const fakeLocatorResult = await run(`
      var capturedCredentialValue = 'not-exposed';
      var fakeCredentialLocator = {
        _frame: page.mainFrame(),
        _selector: 'input[type="password"]',
        fill(value) { capturedCredentialValue = value; },
      };
      await credentialVault.fill(fakeCredentialLocator, 'fake-locator-ref');
    `, {
      credentials: [{ ref: 'fake-locator-ref', value: secret, allowedOrigins: ['http://credential.test'] }],
    });
    assert.equal(fakeLocatorResult.ok, false);
    assert.match(fakeLocatorResult.error || '', /requires a Locator from the active browser session/);
    const fakeLocatorLeakCheck = await run(`nodeRepl.write(capturedCredentialValue);`);
    assert.equal(fakeLocatorLeakCheck.value, 'not-exposed');

    const autoFilteredCredential = await run(`
      await page.domSnapshot();
      await credentialVault.fill(page.locator('input[name="username"]'), 'username-ref');
    `, {
      credentials: [{ ref: 'username-ref', value: secret, allowedOrigins: ['http://credential.test'] }],
    });
    assert.equal(autoFilteredCredential.ok, true, autoFilteredCredential.error);
    assert.equal(await page.locator('label input[name="username"]').inputValue(), secret);
    assert.equal(await page.locator('#readonly-username').inputValue(), '');
    assert.equal(await page.locator('.ng-login-container input[name="username"]').inputValue(), '');
    assert.doesNotMatch(JSON.stringify(autoFilteredCredential), new RegExp(secret));

    await page.locator('label input[name="username"]').fill('');
    await page.locator('label input[name="password"]').fill('');
    const multiCredential = await run(`
      await page.domSnapshot();
      await credentialVault.fill(page.locator('input[name="username"]'), 'username-ref');
      await credentialVault.fill(page.locator('input[name="password"]'), 'password-ref');
    `, {
      credentials: [
        { ref: 'username-ref', value: secret, allowedOrigins: ['http://credential.test'] },
        { ref: 'password-ref', value: secret, allowedOrigins: ['http://credential.test'] },
      ],
    });
    assert.equal(multiCredential.ok, true, multiCredential.error);
    assert.equal(await page.locator('label input[name="username"]').inputValue(), secret);
    assert.equal(await page.locator('label input[name="password"]').inputValue(), secret);
    assert.deepEqual(
      multiCredential.activity?.actions,
      ['credential.fill', 'credential.fill'],
    );
    assert.doesNotMatch(JSON.stringify(multiCredential), new RegExp(secret));

    const hiddenCredential = await run(`
      await page.domSnapshot();
      await credentialVault.fill(page.locator('.ng-login-container input[name="username"]'), 'username-ref');
    `, {
      credentials: [{ ref: 'username-ref', value: secret, allowedOrigins: ['http://credential.test'] }],
    });
    assert.equal(hiddenCredential.ok, false);
    assert.match(
      hiddenCredential.error || '',
      /matched 0 elements; 0 passed automatic visible filtering; 0 passed full actionability/i,
    );
    assert.equal(await page.locator('.ng-login-container input[name="username"]').inputValue(), '');

    const hiddenInputCredential = await run(`
      await page.domSnapshot();
      await credentialVault.fill(page.locator('input[name="hidden-token"]'), 'hidden-token-ref');
    `, {
      credentials: [{ ref: 'hidden-token-ref', value: secret, allowedOrigins: ['http://credential.test'] }],
    });
    assert.equal(hiddenInputCredential.ok, false);
    assert.match(
      hiddenInputCredential.error || '',
      /matched 0 elements; 0 passed automatic visible filtering; 0 passed full actionability/i,
    );
    assert.equal(await page.locator('input[name="hidden-token"]').inputValue(), '');

    const hiddenButton = await run(`
      await page.domSnapshot();
      await page.locator('.ng-login-container button[type="submit"]').click();
    `);
    assert.equal(hiddenButton.ok, false);
    assert.match(
      hiddenButton.error || '',
      /matched 0 elements; 0 passed automatic visible filtering; 0 passed full actionability/i,
    );

    const result = await run(`
      await page.domSnapshot();
      var credentialFillResult = await credentialVault.fill(
        page.locator('input[name="password"]').filter({ visible: true }),
        'password-ref'
      );
      nodeRepl.write(credentialFillResult);
    `, {
      credentials: [{ ref: 'password-ref', value: secret, allowedOrigins: ['http://credential.test'] }],
    });

    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.value, { filled: true, origin: 'http://credential.test' });
    assert.equal(await page.locator('label input[name="password"]').inputValue(), secret);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));

    await page.locator('label input[name="password"]').fill('');
    const rejected = await run(`
      await credentialVault.fill(page.locator('label input[name="password"]'), 'wrong-origin-ref');
    `, {
      credentials: [{ ref: 'wrong-origin-ref', value: secret, allowedOrigins: ['http://other.test'] }],
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error || '', /not allowed for http:\/\/credential\.test/);
    assert.equal(await page.locator('label input[name="password"]').inputValue(), '');
    assert.doesNotMatch(JSON.stringify(rejected), new RegExp(secret));

    const unrestricted = await run(`
      await credentialVault.fill(page.locator('label input[name="password"]'), 'unrestricted-ref');
    `, {
      credentials: [{ ref: 'unrestricted-ref', value: secret, allowedOrigins: [] }],
    });
    assert.equal(unrestricted.ok, true, unrestricted.error);
    assert.equal(await page.locator('label input[name="password"]').inputValue(), secret);
    assert.doesNotMatch(JSON.stringify(unrestricted), new RegExp(secret));
  } finally {
    await page.goto('about:blank');
    await page.setContent('<title>Editor</title><button onmouseenter="this.dataset.hovered=\'true\'" onclick="document.body.dataset.coordinateClicked=\'true\'">Save</button>');
    await browserContext.unroute('http://credential.test/**');
  }
});

test('browserCode risk analysis confirms committed effects instead of preparatory credential entry', () => {
  assert.equal(analyzeBrowserCodeRisk(`await page.goto('https://example.test/login')`).requiresConfirmation, false);
  assert.equal(analyzeBrowserCodeRisk(`// 点击登录按钮\nconst buttons = await page.locator('button').allTextContents()`).requiresConfirmation, false);
  assert.equal(analyzeBrowserCodeRisk(`await page.getByRole('button', { name: '删除' }).click()`).requiresConfirmation, true);
  assert.equal(analyzeBrowserCodeRisk(`await page.getByLabel('Password').fill('secret')`).requiresConfirmation, false);
  assert.equal(analyzeBrowserCodeRisk(`await page.getByRole('button', { name: 'Login' }).click()`).requiresConfirmation, true);
  assert.equal(analyzeBrowserCodeRisk(`await fetch('data/document.js', { credentials: 'include' })`).requiresConfirmation, false);
  assert.equal(analyzeBrowserCodeRisk(`await fetch('/api/report', { method: 'GET' })`).requiresConfirmation, false);
  assert.equal(analyzeBrowserCodeRisk(`await fetch('/api/update', { method: 'POST' })`).requiresConfirmation, true);
  assert.equal(analyzeBrowserCodeRisk(`return await page.getByRole('heading').innerText()`).requiresConfirmation, false);
});

test('browserCode policy allows Playwright force while retaining script-click protections', () => {
  assert.equal(browserCodePolicyViolation(`await locator.click({ force: true })`), undefined);
  assert.equal(browserCodePolicyViolation(`await locator.click()`), undefined);
  assert.equal(
    browserCodePolicyViolation(`await attachmentVault.setInputFiles(page.locator('input[type=file]'), 'attachment-1')`),
    undefined,
  );
});

test('browserCode image-operation detection uses parsed member calls', () => {
  assert.equal(browserCodeHasImageOperation('await nodeRepl.emitImage(await page.screenshot())'), true);
  assert.equal(browserCodeHasImageOperation('await page.screenshot({fullPage:false})'), true);
  assert.equal(browserCodeHasImageOperation('nodeRepl.write({screenshot:"metadata only"})'), false);
  assert.equal(browserCodeHasImageOperation('const screenshot = "plain value"; nodeRepl.write(screenshot)'), false);
});

test('browserCode policy rejects direct or reconstructed file uploads', () => {
  assert.match(
    browserCodePolicyViolation(`await page.locator('input[type=file]').setInputFiles('C:/secret.txt')`) || '',
    /attachmentVault\.setInputFiles/,
  );
  assert.match(
    browserCodePolicyViolation(`await fileChooser.setFiles({ name: 'drag.txt', buffer: encoded })`) || '',
    /FileChooser\.setFiles/,
  );
});

test('browserCode policy rejects scripted clicks that bypass actionability', () => {
  assert.match(
    browserCodePolicyViolation(`await page.locator('button').dispatchEvent('click')`) || '',
    /forbids dispatchEvent/,
  );
  assert.match(
    browserCodePolicyViolation(`await page.evaluate(() => document.querySelector('button').click())`) || '',
    /forbids DOM element\.click/,
  );
  assert.match(
    browserCodePolicyViolation(`await page.locator('button').evaluate((button) => button.click())`) || '',
    /forbids DOM element\.click/,
  );
  assert.match(
    browserCodePolicyViolation(`await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const button of buttons) {
        if (button.textContent.includes('确定')) {
          button.click();
          return true;
        }
      }
      return false;
    })`) || '',
    /forbids DOM element\.click/,
  );
  assert.equal(
    browserCodePolicyViolation(`await page.evaluate(() => document.title); await page.getByRole('button', { name: 'Save' }).click()`),
    undefined,
  );
  assert.equal(
    browserCodePolicyViolation(`
      var observedFields = await page.evaluate(() => ({
        title: document.title,
        buttons: Array.from(document.querySelectorAll('button')).map((button) => button.textContent),
      }));
      await page.getByRole('button', { name: 'Save' }).click();
    `),
    undefined,
  );
});
