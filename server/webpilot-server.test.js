/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  applyTrustedIdentityHeaders,
  applicationBasePath,
  boundedDevelopmentMemoryThreshold,
  createApiRuntimeSupervisor,
  configureCompiledNextRuntime,
  configureNextDevelopmentRuntime,
  developmentMemoryRestartStats,
  loadCompiledNextConfig,
  nextDevelopmentUpgrade,
  normalizeBasePath,
  proxyRequestHeaders,
  requireRuntimeDependency,
  runtimeApiRequest,
  splitRuntimeEnabled,
  unsafeCrossOriginRequest,
  webSocketUpgradeTarget,
} = require('./webpilot-server');

const ticket = 'a'.repeat(43);

test('restarts only the development child after configurable V8 heap pressure', () => {
  assert.equal(boundedDevelopmentMemoryThreshold('0.2'), 0.5);
  assert.equal(boundedDevelopmentMemoryThreshold('0.9'), 0.9);
  assert.equal(boundedDevelopmentMemoryThreshold('invalid'), 0.8);

  const originalArgv = process.argv;
  process.argv = [...originalArgv, '--development-child'];
  try {
    const heap = { heap_size_limit: 100, used_heap_size: 81 };
    assert.deepEqual(developmentMemoryRestartStats(true, false, {}, heap), {
      heapSizeLimit: 100,
      heapUsed: 81,
      threshold: 0.8,
    });
    assert.equal(developmentMemoryRestartStats(false, false, {}, heap), undefined);
    assert.equal(developmentMemoryRestartStats(true, true, {}, heap), undefined);
    assert.equal(developmentMemoryRestartStats(true, false, { WEBPILOT_DEV_MEMORY_RESTART: 'false' }, heap), undefined);
  } finally {
    process.argv = originalArgv;
  }
});

test('replaces identity headers in both normalized and raw request views', () => {
  const request = {
    headers: {
      host: 'localhost:3000',
      'x-webpilot-identity-user-id': 'spoofed',
      'x-webpilot-identity-proof': 'spoofed-proof',
    },
    rawHeaders: [
      'Host', 'localhost:3000',
      'X-WebPilot-Identity-User-Id', 'spoofed',
      'X-WebPilot-Identity-Proof', 'spoofed-proof',
    ],
  };

  applyTrustedIdentityHeaders(request, {
    userId: '1',
    username: 'admin',
    roles: ['user'],
  }, 'trusted-proof');

  assert.equal(request.headers['x-webpilot-identity-user-id'], '1');
  assert.equal(request.headers['x-webpilot-identity-username'], 'admin');
  assert.equal(request.headers['x-webpilot-identity-proof'], 'trusted-proof');
  assert.deepEqual(request.rawHeaders, [
    'Host', 'localhost:3000',
    'x-webpilot-identity-user-id', '1',
    'x-webpilot-identity-username', 'admin',
    'x-webpilot-identity-roles', 'user',
    'x-webpilot-identity-proof', 'trusted-proof',
  ]);
});

test('never injects an undefined identity proof into a proxied request', () => {
  const request = {
    headers: {
      host: 'localhost:3000',
      'x-webpilot-identity-user-id': 'spoofed',
      'x-webpilot-identity-proof': 'spoofed-proof',
    },
    rawHeaders: [
      'Host', 'localhost:3000',
      'X-WebPilot-Identity-User-Id', 'spoofed',
      'X-WebPilot-Identity-Proof', 'spoofed-proof',
    ],
  };

  applyTrustedIdentityHeaders(request, {
    userId: '1',
    username: 'admin',
    roles: ['user'],
  }, undefined);

  assert.equal(request.headers['x-webpilot-identity-user-id'], undefined);
  assert.equal(request.headers['x-webpilot-identity-proof'], undefined);
  assert.deepEqual(request.rawHeaders, ['Host', 'localhost:3000']);
});

test('drops undefined request header values before API runtime proxying', () => {
  assert.deepEqual(proxyRequestHeaders({
    host: 'localhost:3000',
    accept: '*/*',
    'x-webpilot-identity-proof': undefined,
  }, { hostname: '127.0.0.1', port: 41000 }), {
    host: 'localhost:3000',
    accept: '*/*',
  });
});

test('isolates API routes in the runtime process while keeping shutdown in the UI host', () => {
  assert.equal(runtimeApiRequest('/api/browser-chat/chat-1/message'), true);
  assert.equal(runtimeApiRequest('/api/artifacts/chat-1/image.png'), true);
  assert.equal(runtimeApiRequest('/api/system/shutdown'), false);
  assert.equal(runtimeApiRequest('/browser-chat'), false);
});

test('uses one Next compiler in development and isolates the production API runtime', () => {
  assert.equal(splitRuntimeEnabled(true, false, {}), false);
  assert.equal(splitRuntimeEnabled(false, false, {}), true);
  assert.equal(splitRuntimeEnabled(false, false, { WEBPILOT_SPLIT_RUNTIME: 'false' }), false);
  assert.equal(splitRuntimeEnabled(false, true, {}), false);
});

test('restarts the API runtime after the child process exits', async () => {
  let starts = 0;
  const runtimes = [];
  const supervisor = createApiRuntimeSupervisor({
    appDir: process.cwd(),
    dev: true,
    externalPort: 3000,
    restartDelayMs: 1,
    startRuntime: async () => {
      starts += 1;
      const child = new EventEmitter();
      child.exitCode = null;
      child.killed = false;
      child.kill = () => {
        child.killed = true;
        child.exitCode = 0;
      };
      const runtime = {
        child,
        hostname: '127.0.0.1',
        port: 41_000 + starts,
        ready: Promise.resolve(),
      };
      runtimes.push(runtime);
      return runtime;
    },
  });

  const first = await supervisor.ensure();
  first.child.exitCode = 1;
  first.child.emit('exit', 1, null);
  const second = await supervisor.ensure();

  assert.equal(first.port, 41_001);
  assert.equal(second.port, 41_002);
  assert.equal(starts, 2);
  supervisor.stop();
  assert.equal(runtimes[1].child.killed, true);
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
