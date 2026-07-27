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

test('BrowserSession executes browserCode against the controlled Playwright page', async (context) => {
  const session = new BrowserSession('dom', { headless: true, isolated: true, runId: 'browser-code-session-test' });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  await page.setContent(`
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
      <button type="button" onclick="console.log('apply-clicked'); document.body.dataset.applied = 'yes'; document.getElementById('status').textContent = 'Applied'">Apply</button>
      <p id="status">Pending</p>
    </body></html>
  `);

  const screenshotAction = await session.executeBrowserCode({
    code: `
      console.info('session-cell-started');
      const name = page.locator('[aria-label="Name"]');
      await name.click();
      var nameBox = await name.boundingBox();
      var locatorCursor = await page.locator('#__ai_mouse_cursor__').evaluate((element) => ({
        x: Number(element.dataset.x),
        y: Number(element.dataset.y),
      }));
      await page.keyboard.type('Alice');
      await page.getByLabel('Role').selectOption('admin');
      const button = page.getByRole('button', { name: 'Apply' });
      var buttonLabel = await button.evaluate((element, suffix) => element.textContent + suffix, '!');
      var buttonBox = await button.boundingBox();
      if (!buttonBox) throw new Error('Apply button is not visible');
      await nodeRepl.emitImage(await page.screenshot({ type: 'png', fullPage: false }));
      nodeRepl.write({ screenshotReady: true });
    `,
    runId: 'browser-code-session-test',
    stepIndex: 1,
  });

  assert.equal(screenshotAction.ok, true, screenshotAction.actual);
  assert.equal(screenshotAction.referenceImagePaths?.length, 1);
  assert.equal((await readFile(screenshotAction.referenceImagePaths?.[0] || '')).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const screenshotResult = JSON.parse(screenshotAction.actual) as {
    console?: { code?: Array<{ level?: string; text?: string }> };
  };
  assert.ok(screenshotResult.console?.code?.some((entry) => entry.level === 'info' && entry.text === 'session-cell-started'));

  const action = await session.executeBrowserCode({
    code: `
      await page.mouse.click(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2);
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
    stepIndex: 2,
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
    domSnapshot?: {
      content?: string;
      generationId?: string;
      mode?: string;
    };
    console?: {
      code?: Array<{ level?: string; text?: string }>;
      page?: Array<{ level?: string; text?: string }>;
    };
  };
  assert.deepEqual(result.result?.state, { name: 'Alice', role: 'admin', applied: 'yes', status: 'Applied' });
  assert.equal(result.result?.buttonLabel, 'Apply!');
  assert.ok(result.result?.nameBox);
  assert.ok(Math.abs((result.result?.locatorCursor?.x || 0) - (result.result.nameBox.x + result.result.nameBox.width / 2)) <= 1);
  assert.ok(Math.abs((result.result?.locatorCursor?.y || 0) - (result.result.nameBox.y + result.result.nameBox.height / 2)) <= 1);
  assert.match(result.result?.url || '', /^about:blank$/);
  assert.equal(result.result?.uidType, 'undefined');
  assert.equal(result.result?.nativeContext, true);
  assert.equal(result.result?.pageCount, 1);
  assert.match(result.domSnapshot?.content || '', /Applied/);
  assert.equal(result.domSnapshot?.mode, 'full');
  assert.ok(result.domSnapshot?.generationId);
  assert.deepEqual(result.console?.code, []);
  assert.ok(result.console?.page?.some((entry) => entry.level === 'log' && entry.text === 'apply-clicked'));
  assert.equal(action.autoSnapshot?.generationId, result.domSnapshot?.generationId);
  assert.equal(action.autoSnapshot?.refreshed, true);
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
});

test('live preview follows a clicked popup and emits an initial frame after tab switching', async (context) => {
  const session = new BrowserSession('dom', {
    headless: true,
    isolated: true,
    runId: 'browser-live-preview-tab-test',
  });
  context.after(async () => session.close());
  await session.start();
  const page = Reflect.get(session, 'activePage') as Page;
  await page.setContent(`
    <!doctype html>
    <html><body style="margin:0">
      <button id="open-detail" style="height:80px;width:240px" onclick="window.open('about:blank#detail', '_blank')">
        Open detail
      </button>
    </body></html>
  `);

  const initialTabs = await session.refreshTabsSnapshot();
  assert.equal(initialTabs.length, 1);
  const originalTabId = initialTabs[0].id;
  const initialFrames: Array<{ url: string }> = [];
  let activePageChanged = false;
  const firstHandle = await session.startScreencast({
    onActivePageChanged: () => { activePageChanged = true; },
    onFrame: (frame) => { initialFrames.push({ url: frame.url }); },
  });
  assert.ok(initialFrames.length >= 1, 'screencast attach should emit an initial frame');

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

  let popupTabs = await session.refreshTabsSnapshot();
  await waitForCondition(async () => {
    popupTabs = await session.refreshTabsSnapshot();
    return popupTabs.length === 2 && popupTabs.some((tab) => tab.active && tab.url.endsWith('#detail'));
  });
  await waitForCondition(() => activePageChanged);
  await firstHandle.stop();

  const switchResult = await session.switchLivePreviewTab(originalTabId);
  assert.equal(switchResult.ok, true, switchResult.actual);
  const switchedTabs = await session.refreshTabsSnapshot();
  assert.equal(switchedTabs.length, 2);
  assert.equal(switchedTabs.find((tab) => tab.id === originalTabId)?.active, true);

  const switchedFrames: Array<{ url: string }> = [];
  const switchedHandle = await session.startScreencast({
    onFrame: (frame) => { switchedFrames.push({ url: frame.url }); },
  });
  assert.ok(switchedFrames.length >= 1, 'switched static tab should emit a frame immediately');
  assert.equal(switchedFrames.at(-1)?.url, 'about:blank');
  await switchedHandle.stop();
});

test('force close releases a browser even when the debug keep-open flag is enabled', async () => {
  const previousKeepOpen = process.env.KEEP_BROWSER_OPEN_AFTER_RUN;
  const session = new BrowserSession('dom', {
    headless: true,
    isolated: true,
    runId: 'browser-force-close-test',
  });
  try {
    await session.start();
    assert.equal(session.isUsable(), true);
    process.env.KEEP_BROWSER_OPEN_AFTER_RUN = 'true';
    await session.close({ force: true });
    assert.equal(session.isUsable(), false);
  } finally {
    if (previousKeepOpen === undefined) delete process.env.KEEP_BROWSER_OPEN_AFTER_RUN;
    else process.env.KEEP_BROWSER_OPEN_AFTER_RUN = previousKeepOpen;
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
