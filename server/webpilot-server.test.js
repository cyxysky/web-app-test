/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  applicationBasePath,
  configureCompiledNextRuntime,
  configureNextDevelopmentRuntime,
  loadCompiledNextConfig,
  nextDevelopmentUpgrade,
  normalizeBasePath,
  requireRuntimeDependency,
  runtimeApiRequest,
  unsafeCrossOriginRequest,
  webSocketUpgradeTarget,
} = require('./webpilot-server');

const ticket = 'a'.repeat(43);

test('isolates API routes in the runtime process while keeping shutdown in the UI host', () => {
  assert.equal(runtimeApiRequest('/api/browser-chat/chat-1/message'), true);
  assert.equal(runtimeApiRequest('/api/artifacts/chat-1/image.png'), true);
  assert.equal(runtimeApiRequest('/api/system/shutdown'), false);
  assert.equal(runtimeApiRequest('/browser-chat'), false);
});

test('routes realtime upgrades through the configured public base path', () => {
  const basePath = normalizeBasePath('/webpilot');
  const requestUrl = new URL(`http://localhost:3000/webpilot/refresh?ticket=${ticket}`);

  assert.deepEqual(webSocketUpgradeTarget(requestUrl, basePath), {
    kind: 'refresh',
    target: `/refresh?ticket=${ticket}`,
  });
});

test('uses the compiled base path for every production request route', () => {
  assert.equal(
    applicationBasePath(false, { basePath: '/webpilot' }, { WEBPILOT_BASE_PATH: '' }),
    '/webpilot',
  );
  assert.equal(
    applicationBasePath(false, { basePath: '/webpilot' }, { WEBPILOT_BASE_PATH: '/wrong-runtime-value' }),
    '/webpilot',
  );
});

test('loads the complete compiled configuration before Next initializes', () => {
  const environment = {};
  const compiledConfig = { basePath: '/webpilot', assetPrefix: '/webpilot' };

  configureCompiledNextRuntime(compiledConfig, environment);

  assert.deepEqual(JSON.parse(environment.__NEXT_PRIVATE_STANDALONE_CONFIG), compiledConfig);
});

test('marks custom development servers before Next route modules initialize', () => {
  const developmentEnvironment = {};
  const productionEnvironment = {};

  configureNextDevelopmentRuntime(true, developmentEnvironment);
  configureNextDevelopmentRuntime(false, productionEnvironment);

  assert.equal(developmentEnvironment.__NEXT_DEV_SERVER, '1');
  assert.equal(productionEnvironment.__NEXT_DEV_SERVER, undefined);
});

test('does not route a prefixed upgrade when the custom server missed the base path', () => {
  const requestUrl = new URL(`http://localhost:3000/webpilot/refresh?ticket=${ticket}`);
  assert.equal(webSocketUpgradeTarget(requestUrl, ''), undefined);
});

test('rejects upgrade requests without a valid short-lived ticket', () => {
  const requestUrl = new URL('http://localhost:3000/webpilot/refresh?ticket=invalid');
  assert.equal(webSocketUpgradeTarget(requestUrl, '/webpilot'), undefined);
});

test('delegates the base-path-prefixed Next.js HMR socket only in development', () => {
  const requestUrl = new URL('http://localhost:3000/webpilot/_next/hmr?id=dev-client');
  assert.equal(nextDevelopmentUpgrade(requestUrl, '/webpilot', true), true);
  assert.equal(nextDevelopmentUpgrade(requestUrl, '/webpilot', false), false);
  assert.equal(nextDevelopmentUpgrade(new URL('http://localhost:3000/_next/hmr?id=dev-client'), '/webpilot', true), false);
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

test('loads the compiled configuration required by a packaged Next runtime', () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-compiled-config-'));
  try {
    const manifestDir = path.join(appDir, '.next');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(path.join(manifestDir, 'required-server-files.json'), JSON.stringify({
      config: { basePath: '/webpilot' },
    }));
    assert.deepEqual(loadCompiledNextConfig(appDir), {
      basePath: '/webpilot',
    });
  } finally {
    fs.rmSync(appDir, { force: true, recursive: true });
  }
});

test('fails clearly when a production package has no compiled configuration', () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-missing-config-'));
  try {
    assert.throws(() => loadCompiledNextConfig(appDir), /compiled Next configuration is missing/);
  } finally {
    fs.rmSync(appDir, { force: true, recursive: true });
  }
});

test('resolves runtime dependencies from the packaged server directory', () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-runtime-dependency-'));
  try {
    const dependencyDir = path.join(appDir, 'node_modules', 'runtime-fixture');
    fs.mkdirSync(dependencyDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dependencyDir, 'index.js'), 'module.exports = { packaged: true };');

    assert.deepEqual(requireRuntimeDependency(appDir, 'runtime-fixture'), { packaged: true });
    assert.throws(
      () => requireRuntimeDependency(appDir, 'missing-runtime-fixture'),
      /could not be resolved from .*Expected:/,
    );
  } finally {
    fs.rmSync(appDir, { force: true, recursive: true });
  }
});
