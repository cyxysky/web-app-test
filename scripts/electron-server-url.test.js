/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  compiledServerBasePath,
  loadDevelopmentEnvironment,
  serverRouteUrl,
  withServerBasePath,
} = require('../electron/server-url');

test('loads Next development environment before Electron derives server URLs', () => {
  const calls = [];
  const result = loadDevelopmentEnvironment('C:\\project', (projectDir, dev) => {
    calls.push({ projectDir, dev });
    return { loadedEnvFiles: [{ path: '.env' }] };
  });

  assert.deepEqual(calls, [{ projectDir: 'C:\\project', dev: true }]);
  assert.deepEqual(result, { loadedEnvFiles: [{ path: '.env' }] });
});

test('uses the compiled base path for the Electron local server URL', () => {
  const serverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-electron-server-'));
  try {
    const manifestDir = path.join(serverDir, '.next');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(path.join(manifestDir, 'required-server-files.json'), JSON.stringify({
      config: { basePath: '/webpilot' },
    }));
    assert.equal(compiledServerBasePath(serverDir), '/webpilot');
    assert.equal(withServerBasePath('http://127.0.0.1:17891', compiledServerBasePath(serverDir)), 'http://127.0.0.1:17891/webpilot');
    assert.equal(serverRouteUrl('http://127.0.0.1:17891', compiledServerBasePath(serverDir), '/embedded-browser-library'), 'http://127.0.0.1:17891/webpilot/embedded-browser-library');
  } finally {
    fs.rmSync(serverDir, { recursive: true, force: true });
  }
});

test('does not add the compiled base path twice', () => {
  assert.equal(withServerBasePath('http://127.0.0.1:17891/webpilot', '/webpilot'), 'http://127.0.0.1:17891/webpilot');
  assert.equal(serverRouteUrl('http://127.0.0.1:17891/webpilot', '/webpilot', '/dashboard'), 'http://127.0.0.1:17891/webpilot/dashboard');
  assert.equal(serverRouteUrl('http://127.0.0.1:17891/webpilot', '/webpilot', '/browser-chat'), 'http://127.0.0.1:17891/webpilot/browser-chat');
});
