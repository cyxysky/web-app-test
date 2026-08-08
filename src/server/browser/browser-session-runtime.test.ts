import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('browser launch falls back to headless on Linux without a display server', async () => {
  const { browserHeadlessEnabled } = await import('./browser-session-runtime');

  assert.equal(browserHeadlessEnabled({}, {
    env: { HEADLESS_BROWSER: 'false' },
    platform: 'linux',
  }), true);
  assert.equal(browserHeadlessEnabled({}, {
    env: { DISPLAY: ':99', HEADLESS_BROWSER: 'false' },
    platform: 'linux',
  }), false);
  assert.equal(browserHeadlessEnabled({}, {
    env: { HEADLESS_BROWSER: 'false', WAYLAND_DISPLAY: 'wayland-0' },
    platform: 'linux',
  }), false);
});

test('explicit browser launch options take precedence over automatic headless detection', async () => {
  const { browserHeadlessEnabled } = await import('./browser-session-runtime');
  const linuxWithoutDisplay = { env: {}, platform: 'linux' as const };

  assert.equal(browserHeadlessEnabled({ headless: false }, linuxWithoutDisplay), false);
  assert.equal(browserHeadlessEnabled({ headless: true }, linuxWithoutDisplay), true);
  assert.equal(browserHeadlessEnabled({ debugDevtools: true, headless: true }, linuxWithoutDisplay), false);
});

test('managed profile cleanup removes only transient browser caches', async () => {
  const previousDataRoot = process.env.APP_DATA_DIR;
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'webpilot-browser-profile-'));
  process.env.APP_DATA_DIR = dataRoot;
  const runtime = await import('./browser-session-runtime');
  const profileDir = path.join(runtime.managedBrowserProfilesRoot(), 'tab-groups', 'user-test');
  const outsideProfileDir = path.join(dataRoot, 'outside-profile');
  const cacheDirectories = [
    path.join(profileDir, 'Cache'),
    path.join(profileDir, 'DawnGraphiteCache'),
    path.join(profileDir, 'Default', 'Code Cache'),
    path.join(profileDir, 'Default', 'GPUCache'),
    path.join(profileDir, 'Default', 'DawnCustomCache'),
  ];
  const persistentDirectories = [
    path.join(profileDir, 'Default', 'Local Storage'),
    path.join(profileDir, 'Default', 'IndexedDB'),
  ];
  try {
    for (const directory of [...cacheDirectories, ...persistentDirectories]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(path.join(profileDir, 'Default', 'Cookies'), 'keep');
    mkdirSync(path.join(outsideProfileDir, 'Cache'), { recursive: true });

    assert.equal(await runtime.clearManagedBrowserProfileCaches(outsideProfileDir), 0);
    assert.equal(await runtime.clearManagedBrowserProfileCaches(profileDir), cacheDirectories.length);
    for (const directory of cacheDirectories) assert.equal(existsSync(directory), false);
    for (const directory of persistentDirectories) assert.equal(existsSync(directory), true);
    assert.equal(existsSync(path.join(profileDir, 'Default', 'Cookies')), true);
    assert.equal(existsSync(path.join(outsideProfileDir, 'Cache')), true);
  } finally {
    if (previousDataRoot === undefined) delete process.env.APP_DATA_DIR;
    else process.env.APP_DATA_DIR = previousDataRoot;
    rmSync(dataRoot, { force: true, recursive: true });
  }
});
