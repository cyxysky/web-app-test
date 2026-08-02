import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

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
