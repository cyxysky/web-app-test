/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  assertProductionRuntimeSource,
  copyProductionRuntime,
  copyServerRuntime,
  productionPackagePaths,
  serverRuntimeFilePaths,
} = require('./server-package-layout');

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-server-package-'));
}

function writeProductionRuntimeSource(root) {
  const nextRoot = path.join(root, '.next');
  fs.mkdirSync(path.join(nextRoot, 'cache'), { recursive: true });
  fs.mkdirSync(path.join(nextRoot, 'standalone'), { recursive: true });
  fs.writeFileSync(path.join(nextRoot, 'BUILD_ID'), 'build-id');
  fs.writeFileSync(path.join(nextRoot, 'required-server-files.json'), JSON.stringify({ config: { basePath: '/webpilot' } }));
  fs.writeFileSync(path.join(nextRoot, 'cache', 'ignored'), 'cache');
  fs.writeFileSync(path.join(nextRoot, 'standalone', 'ignored'), 'standalone');
  const linkedPackageSource = path.join(root, 'linked-runtime-package');
  fs.mkdirSync(linkedPackageSource, { recursive: true });
  fs.writeFileSync(path.join(linkedPackageSource, 'dynamic-resource.wasm'), 'linked-runtime-resource');
  fs.mkdirSync(path.join(nextRoot, 'node_modules'), { recursive: true });
  fs.symlinkSync(linkedPackageSource, path.join(nextRoot, 'node_modules', 'linked-runtime-hash'), 'junction');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
  fs.writeFileSync(path.join(root, '.env'), 'WEBPILOT_BASE_PATH=/webpilot\n');
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture' },
      'node_modules/runtime-package': { version: '1.0.0' },
      'node_modules/runtime-package/node_modules/nested-package': { version: '1.0.0' },
      'node_modules/optional-package': { version: '1.0.0', optional: true },
      'node_modules/dev-package': { version: '1.0.0', dev: true },
    },
  }));
  fs.mkdirSync(path.join(root, 'node_modules', 'runtime-package', 'node_modules', 'nested-package'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'dev-package'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'runtime-package', 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'node_modules', 'runtime-package', 'native.dll'), 'runtime-native');
  fs.writeFileSync(path.join(root, 'node_modules', 'runtime-package', 'node_modules', 'nested-package', 'module.wasm'), 'runtime-wasm');
  fs.writeFileSync(path.join(root, 'node_modules', 'dev-package', 'package.json'), '{}');
}

test('production runtime source requires a completed build and installed dependencies', () => {
  const root = temporaryDirectory();
  try {
    writeProductionRuntimeSource(root);
    assert.doesNotThrow(() => assertProductionRuntimeSource(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('production runtime package copies all installed production packages and excludes dev-only packages', () => {
  const root = temporaryDirectory();
  try {
    const target = path.join(root, 'package', 'server');
    writeProductionRuntimeSource(root);

    const packagePaths = copyProductionRuntime(root, target);

    assert.equal(packagePaths.includes(path.join('node_modules', 'runtime-package')), true);
    assert.equal(packagePaths.includes(path.join('node_modules', 'dev-package')), false);
    assert.equal(fs.readFileSync(path.join(target, '.next', 'BUILD_ID'), 'utf8'), 'build-id');
    assert.equal(fs.existsSync(path.join(target, '.next', 'cache')), false);
    assert.equal(fs.existsSync(path.join(target, '.next', 'standalone')), false);
    const copiedLinkedPackage = path.join(target, '.next', 'node_modules', 'linked-runtime-hash');
    assert.equal(fs.lstatSync(copiedLinkedPackage).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(copiedLinkedPackage, 'dynamic-resource.wasm'), 'utf8'), 'linked-runtime-resource');
    assert.equal(fs.readFileSync(path.join(target, '.env'), 'utf8'), 'WEBPILOT_BASE_PATH=/webpilot\n');
    assert.equal(fs.readFileSync(path.join(target, 'node_modules', 'runtime-package', 'native.dll'), 'utf8'), 'runtime-native');
    assert.equal(fs.readFileSync(path.join(target, 'node_modules', 'runtime-package', 'node_modules', 'nested-package', 'module.wasm'), 'utf8'), 'runtime-wasm');
    assert.equal(fs.existsSync(path.join(target, 'node_modules', 'dev-package')), false);
    assert.equal(fs.existsSync(path.join(target, 'node_modules', 'optional-package')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('production runtime ignores an unavailable platform-specific optional package', () => {
  const root = temporaryDirectory();
  try {
    writeProductionRuntimeSource(root);
    assert.deepEqual(productionPackagePaths(root), [
      path.join('node_modules', 'runtime-package'),
      path.join('node_modules', 'runtime-package', 'node_modules', 'nested-package'),
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('production runtime rejects a missing non-optional package from the lock file', () => {
  const root = temporaryDirectory();
  try {
    writeProductionRuntimeSource(root);
    const lockPath = path.join(root, 'package-lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    lock.packages['node_modules/missing-runtime-package'] = { version: '1.0.0' };
    fs.writeFileSync(lockPath, JSON.stringify(lock));

    assert.throws(() => productionPackagePaths(root), /missing-runtime-package/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('custom server packaging includes every runtime file and excludes tests', () => {
  const root = temporaryDirectory();
  try {
    const source = path.join(root, 'server');
    const target = path.join(root, 'package', 'server');
    fs.mkdirSync(path.join(source, 'support'), { recursive: true });
    fs.writeFileSync(path.join(source, 'webpilot-server.js'), "require('./process-memory-monitor');\n");
    fs.writeFileSync(path.join(source, 'process-memory-monitor.js'), 'module.exports = {};\n');
    fs.writeFileSync(path.join(source, 'webpilot-server.test.js'), 'throw new Error();\n');
    fs.writeFileSync(path.join(source, 'support', 'runtime.json'), '{}');

    assert.deepEqual(serverRuntimeFilePaths(root), [
      'process-memory-monitor.js',
      path.join('support', 'runtime.json'),
      'webpilot-server.js',
    ]);
    assert.deepEqual(copyServerRuntime(root, target), serverRuntimeFilePaths(root));
    assert.equal(fs.existsSync(path.join(target, 'process-memory-monitor.js')), true);
    assert.equal(fs.existsSync(path.join(target, 'support', 'runtime.json')), true);
    assert.equal(fs.existsSync(path.join(target, 'webpilot-server.test.js')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
