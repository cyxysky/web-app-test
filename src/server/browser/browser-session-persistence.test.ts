import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Page } from 'playwright';
import { BrowserSession, type BrowserTabSnapshot } from '@webpilot/capability-browser/node';

const environmentKeys = [
  'AI_WEB_TEST_BROWSER_PROFILE_DIR',
  'BROWSER_CDP_ENDPOINT',
  'BROWSER_CONNECT_CDP_ENDPOINT',
  'BROWSER_USER_DATA_DIR',
] as const;

test('a headless user profile preserves login storage after the browser is recycled', async () => {
  const previousDataRoot = process.env.APP_DATA_DIR;
  const previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'webpilot-headless-profile-'));
  const profileKey = 'user-persistence-test';
  let first: BrowserSession | undefined;
  let second: BrowserSession | undefined;
  try {
    process.env.APP_DATA_DIR = dataRoot;
    for (const key of environmentKeys) delete process.env[key];

    first = new BrowserSession({
      browserProfileKey: profileKey,
      headless: true,
      runId: 'profile-first-conversation',
      sharedBrowserRuntimeKey: profileKey,
    });
    await first.start();
    const firstPage = Reflect.get(first, 'activePage') as Page;
    await firstPage.context().route('https://profile-persistence.test/**', (route) => route.fulfill({
      body: '<!doctype html><title>Profile persistence</title>',
      contentType: 'text/html',
    }));
    await firstPage.goto('https://profile-persistence.test/account');
    await firstPage.evaluate(() => {
      document.cookie = 'session=kept; Max-Age=3600; SameSite=Lax';
      localStorage.setItem('login-state', 'signed-in');
    });
    await first.close({ force: true });
    first = undefined;

    second = new BrowserSession({
      browserProfileKey: profileKey,
      headless: true,
      runId: 'profile-second-conversation',
      sharedBrowserRuntimeKey: profileKey,
    });
    await second.start();
    const secondPage = Reflect.get(second, 'activePage') as Page;
    await secondPage.context().route('https://profile-persistence.test/**', (route) => route.fulfill({
      body: '<!doctype html><title>Profile persistence</title>',
      contentType: 'text/html',
    }));
    await secondPage.goto('https://profile-persistence.test/account');
    const restored = await secondPage.evaluate(() => ({
      cookie: document.cookie,
      loginState: localStorage.getItem('login-state'),
    }));

    assert.match(restored.cookie, /(?:^|;\s*)session=kept(?:;|$)/);
    assert.equal(restored.loginState, 'signed-in');
    assert.equal(
      existsSync(path.join(dataRoot, '.data', 'browser-profiles', 'tab-groups', profileKey)),
      true,
    );
  } finally {
    await first?.close({ force: true }).catch(() => undefined);
    await second?.close({ force: true }).catch(() => undefined);
    if (previousDataRoot === undefined) delete process.env.APP_DATA_DIR;
    else process.env.APP_DATA_DIR = previousDataRoot;
    for (const key of environmentKeys) {
      const previous = previousEnvironment[key];
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    rmSync(dataRoot, { force: true, recursive: true });
  }
});

test('application tab snapshots restore URL order and the active tab in headless mode', async () => {
  const session = new BrowserSession({
    headless: true,
    isolated: true,
    runId: 'headless-tab-restore-test',
  });
  const firstUrl = `data:text/html,${encodeURIComponent('<title>First restored tab</title>')}`;
  const secondUrl = `data:text/html,${encodeURIComponent('<title>Second restored tab</title>')}`;
  const savedTabs: BrowserTabSnapshot[] = [
    { id: 'saved-1', index: 0, url: firstUrl, active: false, groupId: 'headless-tab-restore-test' },
    { id: 'saved-2', index: 1, url: secondUrl, active: true, groupId: 'headless-tab-restore-test' },
  ];
  try {
    await session.start();
    const result = await session.restoreTabsFromSnapshot(savedTabs);

    assert.equal(result.attempted, 2);
    assert.equal(result.restored, 2);
    assert.deepEqual(result.failedUrls, []);
    assert.deepEqual(result.tabs.map((tab) => tab.url), [firstUrl, secondUrl]);
    assert.deepEqual(result.tabs.map((tab) => tab.active), [false, true]);
    assert.equal(session.currentUrl(), secondUrl);
  } finally {
    await session.close({ force: true }).catch(() => undefined);
  }
});
