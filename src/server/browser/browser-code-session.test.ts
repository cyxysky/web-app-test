import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { Page } from 'playwright';
import { BrowserSession, closeAllBrowserSessions } from './browser-session';

async function waitForCondition(check: () => boolean | Promise<boolean>, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

function readPngDimensions(buffer: Buffer) {
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

test('BrowserSession executes browserCode against the controlled Playwright page', async (context) => {
  const session = new BrowserSession('dom', { headless: true, isolated: true, runId: 'browser-code-session-test' });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  await page.goto(`data:text/html,${encodeURIComponent(`
    <!doctype html>
    <html><body>
      <label>Name <input aria-label="Name"></label>
      <label>Password <input type="password" aria-label="Password"></label>
      <label>Role
        <select aria-label="Role">
          <option value="viewer">Viewer</option>
          <option value="admin">Admin</option>
        </select>
      </label>
      <button type="button" onclick="console.error('apply-clicked'); document.body.dataset.applied = 'yes'; document.getElementById('status').textContent = 'Applied'">Apply</button>
      <p id="status">Pending</p>
    </body></html>
  `)}`);

  const fillName = await session.executeBrowserCode({
    code: `
      var name = page.locator('[aria-label="Name"]').filter({ visible: true });
      await name.fill('Alice');
      await page.verifyState({
        description: 'Name value was entered',
        locator: name,
        state: 'value',
        equals: 'Alice',
      });
      var nameBox = await name.boundingBox();
      var locatorCursor = await page.locator('#__ai_mouse_cursor__').evaluate((element) => ({
        x: Number(element.dataset.x),
        y: Number(element.dataset.y),
      }));
    `,
    runId: 'browser-code-session-test',
    stepIndex: 1,
  });
  assert.equal(fillName.ok, true, fillName.actual);
  assert.equal(fillName.observation, undefined);
  const fillNameActual = JSON.parse(fillName.actual) as {
    observation?: unknown;
    domChanges?: { observation?: unknown };
    axTree?: string;
  };
  assert.equal(fillNameActual.observation, undefined);
  assert.equal(fillNameActual.domChanges?.observation, undefined);
  assert.equal(fillNameActual.axTree, undefined);

  const missingAction = await session.executeBrowserCode({
    code: `
      await page.domSnapshot();
      await page.locator('#missing-action-target').click();
    `,
    runId: 'browser-code-session-test',
    stepIndex: 2,
  });
  assert.equal(missingAction.ok, false);
  assert.equal(missingAction.observation, undefined);
  const missingActual = JSON.parse(missingAction.actual) as {
    observation?: unknown;
    domChanges?: { observation?: unknown };
    axTree?: string;
  };
  assert.equal(missingActual.observation, undefined);
  assert.equal(missingActual.domChanges?.observation, undefined);
  assert.equal(missingActual.axTree, undefined);

  const selectRole = await session.executeBrowserCode({
    code: `
      await page.domSnapshot();
      var role = page.getByLabel('Role').filter({ visible: true });
      await role.selectOption('admin');
      await page.verifyState({
        description: 'Admin role was selected',
        locator: role,
        state: 'value',
        equals: 'admin',
      });
    `,
    runId: 'browser-code-session-test',
    stepIndex: 3,
  });
  assert.equal(selectRole.ok, true, selectRole.actual);

  const screenshotAction = await session.executeBrowserCode({
    code: `
      var button = page.getByRole('button', { name: 'Apply' }).filter({ visible: true });
      var buttonLabel = await button.evaluate((element, suffix) => element.textContent + suffix, '!');
      var buttonBox = await button.boundingBox();
      if (!buttonBox) throw new Error('Apply button is not visible');
      await nodeRepl.emitImage(await page.screenshot({ type: 'png', fullPage: false }));
      nodeRepl.write({ screenshotReady: true });
    `,
    runId: 'browser-code-session-test',
    stepIndex: 4,
  });

  assert.equal(screenshotAction.ok, true, screenshotAction.actual);
  assert.equal(screenshotAction.referenceImagePaths?.length, 1);
  assert.equal((await readFile(screenshotAction.referenceImagePaths?.[0] || '')).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const screenshotResult = JSON.parse(screenshotAction.actual) as { console?: unknown };
  assert.equal('console' in screenshotResult, false);

  const action = await session.executeBrowserCode({
    code: `
      await page.mouse.click(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2);
      await page.verifyState({
        description: 'Apply action completed',
        locator: page.locator('#status'),
        state: 'text',
        equals: 'Applied',
      });
      const state = await page.evaluate(() => ({
        name: document.querySelector('[aria-label="Name"]').value,
        role: document.querySelector('[aria-label="Role"]').value,
        applied: document.body.dataset.applied,
        status: document.getElementById('status').textContent,
      }));
      var sessionResult = {
        buttonLabel,
        locatorCursor,
        nameBox,
        state,
        url: page.url(),
        uidType: typeof page.uid,
        nativeContext: typeof context.newCDPSession === 'function',
        pageCount: context.pages().length,
      };
      nodeRepl.write(sessionResult);
    `,
    runId: 'browser-code-session-test',
    stepIndex: 5,
  });

  assert.equal(action.ok, true, action.actual);
  const result = JSON.parse(action.actual) as {
    result?: {
      buttonLabel?: string;
      locatorCursor?: { x: number; y: number };
      nameBox?: { height: number; width: number; x: number; y: number };
      state?: { name?: string; role?: string; applied?: string; status?: string };
      url?: string;
      uidType?: string;
      nativeContext?: boolean;
      pageCount?: number;
    };
    domChanges?: {
      added?: string[];
      updated?: string[];
      extra?: { added?: string[]; updated?: string[]; errors?: string[] };
    };
    axTree?: string;
    console?: unknown;
  };
  assert.deepEqual(result.result?.state, { name: 'Alice', role: 'admin', applied: 'yes', status: 'Applied' });
  assert.equal(result.result?.buttonLabel, 'Apply!');
  assert.ok(result.result?.nameBox);
  assert.ok(Math.abs((result.result?.locatorCursor?.x || 0) - (result.result.nameBox.x + result.result.nameBox.width / 2)) <= 1);
  assert.ok(Math.abs((result.result?.locatorCursor?.y || 0) - (result.result.nameBox.y + result.result.nameBox.height / 2)) <= 1);
  assert.match(result.result?.url || '', /^data:text\/html,/);
  assert.equal(result.result?.uidType, 'undefined');
  assert.equal(result.result?.nativeContext, true);
  assert.equal(result.result?.pageCount, 1);
  assert.match(JSON.stringify(result.domChanges || {}), /Applied/);
  assert.equal(result.axTree, undefined);
  assert.equal('postActionObservation' in result, false);
  assert.equal('domSnapshot' in result, false);
  assert.ok(result.domChanges?.extra?.errors?.some((entry) => entry === '[console] apply-clicked'));
  assert.equal('console' in result, false);
  assert.deepEqual(action.referenceImagePaths, []);
  assert.equal(await page.getByLabel('Name').inputValue(), 'Alice');
  assert.equal(await page.getByLabel('Role').inputValue(), 'admin');
  const cursorState = await page.locator('#__ai_mouse_cursor__').evaluate((element) => ({
    opacity: (element as HTMLElement).style.opacity,
    x: Number((element as HTMLElement).dataset.x),
    y: Number((element as HTMLElement).dataset.y),
  }));
  const applyBox = await page.getByRole('button', { name: 'Apply' }).boundingBox();
  assert.equal(cursorState.opacity, '1');
  assert.ok(applyBox);
  assert.ok(Math.abs(cursorState.x - (applyBox.x + applyBox.width / 2)) <= 1);
  assert.ok(Math.abs(cursorState.y - (applyBox.y + applyBox.height / 2)) <= 1);

  const readOnlyAction = await session.executeBrowserCode({
    code: `nodeRepl.write({ title: await page.title(), url: page.url() });`,
    runId: 'browser-code-session-test',
    stepIndex: 5,
  });
  assert.equal(readOnlyAction.ok, true, readOnlyAction.actual);
  const readOnlyResult = JSON.parse(readOnlyAction.actual) as Record<string, unknown>;
  assert.equal('domChanges' in readOnlyResult, false);
  assert.equal('axTree' in readOnlyResult, false);
  assert.equal('postActionObservation' in readOnlyResult, false);

  const readOnlyFailure = await session.executeBrowserCode({
    code: `await page.locator('[data-never-exists]').innerText({ timeout: 100 });`,
    runId: 'browser-code-session-test',
    stepIndex: 6,
  });
  assert.equal(readOnlyFailure.ok, false);
  const readOnlyFailureResult = JSON.parse(readOnlyFailure.actual) as Record<string, unknown>;
  assert.equal('domChanges' in readOnlyFailureResult, false);
  assert.equal('axTree' in readOnlyFailureResult, false);
  assert.equal('postActionObservation' in readOnlyFailureResult, false);
});

test('browserCode-created tabs are owned and group-marked before preview starts', async (context) => {
  const session = new BrowserSession('code', {
    headless: true,
    isolated: true,
    runId: 'browser-code-tab-group-test',
  });
  context.after(async () => session.close());
  await session.start();
  const initialPage = Reflect.get(session, 'activePage') as Page;
  await initialPage.setContent('<title>Initial</title><main>Initial tab</main>');

  const createdAction = await session.executeBrowserCode({
    code: `
      var createdTab = await browser.tabs.new({
        url: 'data:text/html,<title>Created</title><main>Created tab</main>',
      });
      nodeRepl.write({ url: createdTab.url() });
    `,
    runId: 'browser-code-tab-group-test',
    stepIndex: 1,
  });
  assert.equal(createdAction.ok, true, createdAction.actual);

  const directAction = await session.executeBrowserCode({
    code: `
      var directContextTab = await context.newPage();
      await directContextTab.goto('data:text/html,<title>Direct</title><main>Direct context tab</main>');
      nodeRepl.write({ directUrl: directContextTab.url(), url: createdTab.url() });
    `,
    runId: 'browser-code-tab-group-test',
    stepIndex: 2,
  });

  assert.equal(directAction.ok, true, directAction.actual);
  const actionResult = JSON.parse(directAction.actual) as Record<string, unknown>;
  assert.equal('domChanges' in actionResult, true, 'tab operations should return an incremental DOM result even when it is empty');
  assert.equal('postActionObservation' in actionResult, false);
  const tabs = session.getTabsSnapshot();
  assert.equal(tabs.length, 3, 'new code-mode tabs should be registered without opening preview');
  assert.equal(tabs.filter((tab) => tab.active).length, 1);
  assert.match(session.currentUrl(), /^data:text\/html,/);
  const groupId = Reflect.get(session, 'pageGroupId') as string;
  const inventoryAction = await session.executeBrowserCode({
    code: `
      var continuationTabInventory = await browser.user.openTabs();
      nodeRepl.write(continuationTabInventory);
    `,
    runId: 'browser-code-tab-group-test',
    stepIndex: 3,
  });
  assert.equal(inventoryAction.ok, true, inventoryAction.actual);
  const inventoryResult = JSON.parse(inventoryAction.actual) as {
    result?: Array<{ active?: boolean; groupId?: string; groupTitle?: string }>;
  };
  assert.equal(inventoryResult.result?.length, 3);
  assert.equal(inventoryResult.result?.filter((tab) => tab.active).length, 1);
  assert.ok(inventoryResult.result?.every((tab) => tab.groupId === groupId));
  assert.ok(inventoryResult.result?.every((tab) => tab.groupTitle === 'ai-p-test'));
  const ownedPages = Array.from(Reflect.get(session, 'ownedPages') as Set<Page>);
  assert.equal(ownedPages.length, 3);
  const markerStates = await Promise.all(ownedPages.map((page) => page.evaluate(() => ({
    groupId: document.documentElement.getAttribute('data-ai-web-test-session-group-id'),
    groupTitle: document.documentElement.getAttribute('data-ai-web-test-session-group-title'),
  }))));
  assert.ok(markerStates.every((marker) => marker.groupId === groupId));
  assert.deepEqual(new Set(markerStates.map((marker) => marker.groupTitle)), new Set(['ai-p-test']));
});

test('live preview screencast follows a clicked popup and tab switching without reconnecting', async (context) => {
  const session = new BrowserSession('dom', {
    headless: true,
    isolated: true,
    runId: 'browser-live-preview-tab-test',
  });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  await page.goto(`data:text/html,${encodeURIComponent(`
    <!doctype html>
    <html><body style="margin:0">
      <button id="open-detail" style="height:80px;width:240px" onclick="window.open('about:blank#detail', '_blank')">
        Open detail
      </button>
    </body></html>
  `)}`);

  const mutableSession = session as unknown as {
    applyConfiguredViewport: (target: Page) => Promise<void>;
  };
  const applyConfiguredViewport = mutableSession.applyConfiguredViewport.bind(session);
  let previewViewportApplications = 0;
  mutableSession.applyConfiguredViewport = async (target) => {
    previewViewportApplications += 1;
    await applyConfiguredViewport(target);
  };

  const initialTabs = await session.refreshTabsSnapshot();
  assert.equal(initialTabs.length, 1);
  const originalTabId = initialTabs[0].id;
  const initialFrames: Array<{ capturedAt: string; url: string }> = [];
  const firstHandle = await session.startScreencast({
    onFrame: (frame) => { initialFrames.push({ capturedAt: frame.capturedAt, url: frame.url }); },
  });
  assert.ok(initialFrames.length >= 1, 'screencast attach should emit an initial frame');
  assert.equal(previewViewportApplications, 0, 'opening preview must not reapply viewport or window state');

  const buttonBox = await page.locator('#open-detail').boundingBox();
  const viewport = page.viewportSize();
  assert.ok(buttonBox && viewport);
  const click = await session.dispatchLiveInput({
    kind: 'click',
    xRatio: (buttonBox.x + buttonBox.width / 2) / viewport.width,
    yRatio: (buttonBox.y + buttonBox.height / 2) / viewport.height,
    button: 'left',
    clickCount: 1,
  });
  assert.equal(click.ok, true, click.actual);
  assert.equal(await page.locator('#__ai_mouse_cursor__').count(), 0, 'user live-preview input must not create the AI cursor');

  let popupTabs = await session.refreshTabsSnapshot();
  await waitForCondition(async () => {
    popupTabs = await session.refreshTabsSnapshot();
    return popupTabs.length === 2 && popupTabs.some((tab) => tab.active && tab.url.endsWith('#detail'));
  });
  await waitForCondition(() => initialFrames.some((frame) => frame.url.endsWith('#detail')));

  const switchResult = await session.switchLivePreviewTab(originalTabId);
  assert.equal(switchResult.ok, true, switchResult.actual);
  const switchedTabs = await session.refreshTabsSnapshot();
  assert.equal(switchedTabs.length, 2);
  assert.equal(
    switchedTabs.find((tab) => tab.id === originalTabId)?.active,
    true,
    `original tab should remain selected after refresh: ${JSON.stringify(switchedTabs)}`,
  );

  await waitForCondition(() => initialFrames.at(-1)?.url === page.url());
  const navigatedUrl = `data:text/html,${encodeURIComponent('<title>Updated preview</title><main>Updated preview</main>')}`;
  await page.goto(navigatedUrl);
  await waitForCondition(() => initialFrames.at(-1)?.url === navigatedUrl);
  await firstHandle.stop();
});

test('live preview repeats the latest native frame at the configured output rate', async (context) => {
  const previousFps = process.env.BROWSER_PREVIEW_FPS;
  process.env.BROWSER_PREVIEW_FPS = '30';
  const session = new BrowserSession('dom', {
    headless: true,
    isolated: true,
    runId: 'browser-live-preview-cadence-test',
  });
  context.after(async () => {
    await session.close();
    if (previousFps === undefined) delete process.env.BROWSER_PREVIEW_FPS;
    else process.env.BROWSER_PREVIEW_FPS = previousFps;
  });
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  await page.setContent('<!doctype html><html><body><main>Static preview</main></body></html>');
  const mutableSession = session as unknown as {
    refreshSessionGroupPages: (options?: { forceNativeRefresh?: boolean }) => Promise<Page[]>;
  };
  const refreshSessionGroupPages = mutableSession.refreshSessionGroupPages.bind(session);
  let refreshCalls = 0;
  mutableSession.refreshSessionGroupPages = async (options) => {
    refreshCalls += 1;
    if (refreshCalls > 1) await new Promise((resolve) => setTimeout(resolve, 500));
    return refreshSessionGroupPages(options);
  };

  const capturedAt: number[] = [];
  const handle = await session.startScreencast({
    onFrame: (frame) => { capturedAt.push(Date.parse(frame.capturedAt)); },
  });
  await waitForCondition(() => capturedAt.length >= 6, 1_500);
  await handle.stop();

  assert.ok(capturedAt.length >= 6, 'static pages must continue producing preview frames');
  assert.ok(
    capturedAt[5] - capturedAt[0] < 750,
    `30 FPS output should not degrade to multi-second updates: ${JSON.stringify(capturedAt)}`,
  );
});

test('live preview supports drag and does not drive the AI cursor', async (context) => {
  const session = new BrowserSession('dom', {
    headless: true,
    isolated: true,
    runId: 'browser-live-preview-drag-test',
  });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  await page.goto(`data:text/html,${encodeURIComponent(`
    <!doctype html>
    <html><body style="margin:0;padding:40px;display:flex;gap:240px">
      <div id="source" draggable="true" style="width:120px;height:100px;background:#2563eb">Source</div>
      <div id="target" style="width:180px;height:140px;background:#e5e7eb">Target</div>
      <script>
        source.addEventListener('dragstart', (event) => event.dataTransfer.setData('text/plain', 'source'));
        target.addEventListener('dragover', (event) => event.preventDefault());
        target.addEventListener('drop', (event) => {
          event.preventDefault();
          document.body.dataset.dropped = event.dataTransfer.getData('text/plain');
        });
      </script>
    </body></html>
  `)}`);

  const sourceBox = await page.locator('#source').boundingBox();
  const targetBox = await page.locator('#target').boundingBox();
  const viewport = page.viewportSize();
  assert.ok(sourceBox && targetBox && viewport);
  const drag = await session.dispatchLiveInput({
    kind: 'drag',
    xRatio: (sourceBox.x + sourceBox.width / 2) / viewport.width,
    yRatio: (sourceBox.y + sourceBox.height / 2) / viewport.height,
    toXRatio: (targetBox.x + targetBox.width / 2) / viewport.width,
    toYRatio: (targetBox.y + targetBox.height / 2) / viewport.height,
    button: 'left',
  });

  assert.equal(drag.ok, true, drag.actual);
  assert.equal(await page.locator('body').getAttribute('data-dropped'), 'source');
  assert.equal(await page.locator('#__ai_mouse_cursor__').count(), 0, 'user live-preview drag must not create the AI cursor');
});

test('browser viewport size and output pixel ratio are independent', async () => {
  const previousMode = process.env.BROWSER_VIEWPORT_MODE;
  const previousWidth = process.env.BROWSER_VIEWPORT_WIDTH;
  const previousHeight = process.env.BROWSER_VIEWPORT_HEIGHT;
  const previousPixelRatio = process.env.BROWSER_OUTPUT_PIXEL_RATIO;
  const previousFormat = process.env.BROWSER_SCREENCAST_FORMAT;
  const previousVideoSourceFormat = process.env.BROWSER_PREVIEW_VIDEO_SOURCE_FORMAT;
  const previousVideoMaxWidth = process.env.BROWSER_PREVIEW_VIDEO_MAX_WIDTH;
  const previousVideoMaxHeight = process.env.BROWSER_PREVIEW_VIDEO_MAX_HEIGHT;
  process.env.BROWSER_VIEWPORT_MODE = 'fixed';
  process.env.BROWSER_VIEWPORT_WIDTH = '800';
  process.env.BROWSER_VIEWPORT_HEIGHT = '600';
  process.env.BROWSER_OUTPUT_PIXEL_RATIO = '2';
  process.env.BROWSER_SCREENCAST_FORMAT = 'png';
  process.env.BROWSER_PREVIEW_VIDEO_SOURCE_FORMAT = 'png';
  process.env.BROWSER_PREVIEW_VIDEO_MAX_WIDTH = '1600';
  process.env.BROWSER_PREVIEW_VIDEO_MAX_HEIGHT = '1200';
  const session = new BrowserSession('code', {
    headless: true,
    isolated: true,
    runId: 'browser-output-pixel-ratio-test',
  });

  try {
    await session.start();
    const page = Reflect.get(session, 'activePage') as Page;
    await page.setContent('<!doctype html><html><body><main>Pixel ratio test</main></body></html>');
    assert.deepEqual(page.viewportSize(), { width: 800, height: 600 });

    const screenshotPath = await session.takeScreenshot(
      'browser-output-pixel-ratio-test',
      1,
      'manual',
      { capture: 'viewport' },
    );
    assert.deepEqual(readPngDimensions(await readFile(screenshotPath)), { width: 1600, height: 1200 });

    const browserContext = page.context();
    const originalNewCdpSession = browserContext.newCDPSession.bind(browserContext);
    const previewCdpMethods: string[] = [];
    const previewCaptureClips: Array<{ height?: number; scale?: number; width?: number }> = [];
    Reflect.set(browserContext, 'newCDPSession', async (target: Page) => {
      const cdpSession = await originalNewCdpSession(target);
      const originalSend = cdpSession.send.bind(cdpSession) as (method: string, params?: object) => Promise<unknown>;
      Reflect.set(cdpSession, 'send', (method: string, params?: object) => {
        previewCdpMethods.push(method);
        if (method === 'Page.captureScreenshot') {
          const clip = (params as { clip?: { height?: number; scale?: number; width?: number } } | undefined)?.clip;
          if (clip) previewCaptureClips.push(clip);
        }
        return originalSend(method, params);
      });
      return cdpSession;
    });
    const frames: Array<{ contentType: string; data: string; viewport: { width: number; height: number } }> = [];
    const handle = await session.startScreencast({
      onFrame: (frame) => { frames.push(frame); },
      video: true,
    });
    assert.ok(frames.length >= 1, 'screencast should emit an initial frame');
    assert.equal(frames[0].contentType, 'image/png');
    assert.deepEqual(readPngDimensions(Buffer.from(frames[0].data, 'base64')), { width: 800, height: 600 });
    assert.deepEqual(frames[0].viewport, { width: 800, height: 600 });
    const frameDeadline = Date.now() + 1_000;
    while (frames.length < 3 && Date.now() < frameDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(frames.length >= 3, 'screencast should continue emitting frames');
    assert.equal(previewCdpMethods.includes('Page.startScreencast'), true, 'video preview must use the native CDP screencast stream');
    assert.deepEqual(previewCaptureClips, [], 'opening video preview must not request a scaled compositor clip');
    assert.equal(previewCdpMethods.includes('Emulation.setDeviceMetricsOverride'), false, 'preview must not mutate page device metrics');
    assert.deepEqual(await page.evaluate(() => ({
      devicePixelRatio: window.devicePixelRatio,
      height: window.innerHeight,
      width: window.innerWidth,
    })), { devicePixelRatio: 1, height: 600, width: 800 });
    await handle.stop();
    assert.deepEqual(await page.evaluate(() => ({
      devicePixelRatio: window.devicePixelRatio,
      height: window.innerHeight,
      width: window.innerWidth,
    })), { devicePixelRatio: 1, height: 600, width: 800 });

    process.env.BROWSER_VIEWPORT_WIDTH = '1366';
    process.env.BROWSER_VIEWPORT_HEIGHT = '768';
    const resizeAction = await session.executeBrowserCode({
      code: 'nodeRepl.write({ viewport: page.viewportSize() });',
      runId: 'browser-output-pixel-ratio-test',
      stepIndex: 2,
    });
    assert.equal(resizeAction.ok, true, resizeAction.actual);
    assert.deepEqual(page.viewportSize(), { width: 1366, height: 768 });
  } finally {
    await session.close({ force: true }).catch(() => undefined);
    if (previousMode === undefined) delete process.env.BROWSER_VIEWPORT_MODE;
    else process.env.BROWSER_VIEWPORT_MODE = previousMode;
    if (previousWidth === undefined) delete process.env.BROWSER_VIEWPORT_WIDTH;
    else process.env.BROWSER_VIEWPORT_WIDTH = previousWidth;
    if (previousHeight === undefined) delete process.env.BROWSER_VIEWPORT_HEIGHT;
    else process.env.BROWSER_VIEWPORT_HEIGHT = previousHeight;
    if (previousPixelRatio === undefined) delete process.env.BROWSER_OUTPUT_PIXEL_RATIO;
    else process.env.BROWSER_OUTPUT_PIXEL_RATIO = previousPixelRatio;
    if (previousFormat === undefined) delete process.env.BROWSER_SCREENCAST_FORMAT;
    else process.env.BROWSER_SCREENCAST_FORMAT = previousFormat;
    if (previousVideoSourceFormat === undefined) delete process.env.BROWSER_PREVIEW_VIDEO_SOURCE_FORMAT;
    else process.env.BROWSER_PREVIEW_VIDEO_SOURCE_FORMAT = previousVideoSourceFormat;
    if (previousVideoMaxWidth === undefined) delete process.env.BROWSER_PREVIEW_VIDEO_MAX_WIDTH;
    else process.env.BROWSER_PREVIEW_VIDEO_MAX_WIDTH = previousVideoMaxWidth;
    if (previousVideoMaxHeight === undefined) delete process.env.BROWSER_PREVIEW_VIDEO_MAX_HEIGHT;
    else process.env.BROWSER_PREVIEW_VIDEO_MAX_HEIGHT = previousVideoMaxHeight;
  }
});

test('force close releases the browser', async () => {
  const session = new BrowserSession('dom', {
    headless: true,
    isolated: true,
    runId: 'browser-force-close-test',
  });
  try {
    await session.start();
    assert.equal(session.isUsable(), true);
    await session.close({ force: true });
    assert.equal(session.isUsable(), false);
  } finally {
    await session.close({ force: true }).catch(() => undefined);
  }
});

test('force close terminates an external Chromium process reached through CDP', async () => {
  const previousEndpoint = process.env.BROWSER_CDP_ENDPOINT;
  const previousSharedTabs = process.env.BROWSER_SHARED_TABS;
  const owner = new BrowserSession('dom', {
    headless: true,
    isolated: true,
    runId: 'browser-cdp-process-owner-test',
  });
  const connected = new BrowserSession('dom', {
    headless: true,
    runId: 'browser-cdp-process-connection-test',
  });
  try {
    await owner.start();
    const connection = Reflect.get(owner, 'browserCodeConnection') as { endpoint?: string } | undefined;
    assert.ok(connection?.endpoint);
    process.env.BROWSER_CDP_ENDPOINT = connection.endpoint;
    process.env.BROWSER_SHARED_TABS = 'false';
    await connected.start();
    assert.equal(connected.isUsable(), true);

    await connected.close({ force: true });
    await waitForCondition(async () => !await fetch(`${connection.endpoint}/json/version`)
      .then((response) => response.ok)
      .catch(() => false));
  } finally {
    if (previousEndpoint === undefined) delete process.env.BROWSER_CDP_ENDPOINT;
    else process.env.BROWSER_CDP_ENDPOINT = previousEndpoint;
    if (previousSharedTabs === undefined) delete process.env.BROWSER_SHARED_TABS;
    else process.env.BROWSER_SHARED_TABS = previousSharedTabs;
    await connected.close({ force: true }).catch(() => undefined);
    await owner.close({ force: true }).catch(() => undefined);
  }
});

test('application shutdown closes every registered test browser', async () => {
  const first = new BrowserSession('dom', {
    headless: true,
    isolated: true,
    runId: 'browser-shutdown-first-test',
  });
  const second = new BrowserSession('dom', {
    headless: true,
    isolated: true,
    runId: 'browser-shutdown-second-test',
  });
  const sharedFirst = new BrowserSession('dom', {
    headless: true,
    sharedBrowserRuntimeKey: 'browser-shutdown-shared-test',
    runId: 'browser-shutdown-shared-first-test',
  });
  const sharedSecond = new BrowserSession('dom', {
    headless: true,
    sharedBrowserRuntimeKey: 'browser-shutdown-shared-test',
    runId: 'browser-shutdown-shared-second-test',
  });
  try {
    await Promise.all([first.start(), second.start()]);
    await sharedFirst.start();
    await sharedSecond.start();
    await first.close({ keepOpen: true });
    assert.equal(first.isUsable(), true);
    assert.equal(second.isUsable(), true);
    assert.equal(sharedFirst.isUsable(), true);
    assert.equal(sharedSecond.isUsable(), true);

    await closeAllBrowserSessions();
    assert.equal(first.isUsable(), false);
    assert.equal(second.isUsable(), false);
    assert.equal(sharedFirst.isUsable(), false);
    assert.equal(sharedSecond.isUsable(), false);
  } finally {
    await Promise.all([
      first.close({ force: true }).catch(() => undefined),
      second.close({ force: true }).catch(() => undefined),
      sharedFirst.close({ force: true }).catch(() => undefined),
      sharedSecond.close({ force: true }).catch(() => undefined),
    ]);
  }
});
