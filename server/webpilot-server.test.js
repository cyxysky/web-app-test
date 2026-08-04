/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  loadStandaloneNextConfig,
  normalizeBasePath,
  unsafeCrossOriginRequest,
  webSocketUpgradeTarget,
} = require('./webpilot-server');

const ticket = 'a'.repeat(43);

test('routes realtime upgrades through the configured public base path', () => {
  const basePath = normalizeBasePath('/webpilot');
  const requestUrl = new URL(`http://localhost:3000/webpilot/refresh?ticket=${ticket}`);

  assert.deepEqual(webSocketUpgradeTarget(requestUrl, basePath), {
    kind: 'refresh',
    target: `/refresh?ticket=${ticket}`,
  });
});

test('does not route a prefixed upgrade when the custom server missed the base path', () => {
  const requestUrl = new URL(`http://localhost:3000/webpilot/refresh?ticket=${ticket}`);
  assert.equal(webSocketUpgradeTarget(requestUrl, ''), undefined);
});

test('rejects upgrade requests without a valid short-lived ticket', () => {
  const requestUrl = new URL('http://localhost:3000/webpilot/refresh?ticket=invalid');
  assert.equal(webSocketUpgradeTarget(requestUrl, '/webpilot'), undefined);
});

test('accepts browser-confirmed same-origin writes behind an origin-rewriting proxy', () => {
  assert.equal(unsafeCrossOriginRequest({
    method: 'POST',
    headers: {
      host: '127.0.0.1:3000',
      origin: 'https://10.10.0.90',
      'sec-fetch-site': 'same-origin',
    },
    socket: {},
  }), false);
});

test('continues to reject browser-confirmed cross-site writes', () => {
  assert.equal(unsafeCrossOriginRequest({
    method: 'POST',
    headers: {
      host: '127.0.0.1:3000',
      origin: 'https://attacker.example',
      'sec-fetch-site': 'cross-site',
    },
    socket: {},
  }), true);
});

test('loads the compiled configuration required by a standalone Next runtime', () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-standalone-config-'));
  try {
    const manifestDir = path.join(appDir, '.next');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(path.join(manifestDir, 'required-server-files.json'), JSON.stringify({
      config: { basePath: '/webpilot', output: 'standalone' },
    }));
    assert.deepEqual(loadStandaloneNextConfig(appDir), {
      basePath: '/webpilot',
      output: 'standalone',
    });
  } finally {
    fs.rmSync(appDir, { force: true, recursive: true });
  }
});

test('fails clearly when a production package has no standalone configuration', () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-missing-config-'));
  try {
    assert.throws(() => loadStandaloneNextConfig(appDir), /standalone Next configuration is missing/);
  } finally {
    fs.rmSync(appDir, { force: true, recursive: true });
  }
});
