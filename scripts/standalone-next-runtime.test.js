/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  assertCompleteNextRuntime,
  copyCompleteNextRuntime,
} = require('./standalone-next-runtime');

function writeFixtureFile(root, relativePath, content = '') {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

test('replaces a traced partial Next package with the complete installed runtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-next-runtime-'));
  try {
    const source = path.join(root, 'node_modules', 'next');
    const server = path.join(root, 'dist-server');
    const target = path.join(server, 'node_modules', 'next');
    writeFixtureFile(source, 'package.json', '{"name":"next"}');
    writeFixtureFile(source, path.join('dist', 'compiled', 'webpack', 'webpack.js'), 'module.exports = {};');
    writeFixtureFile(target, 'package.json', '{"name":"next","partial":true}');

    copyCompleteNextRuntime(root, server);

    assert.equal(
      fs.readFileSync(path.join(target, 'dist', 'compiled', 'webpack', 'webpack.js'), 'utf8'),
      'module.exports = {};',
    );
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('rejects a package that is missing the custom-server webpack runtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-next-runtime-missing-'));
  try {
    writeFixtureFile(root, 'package.json', '{"name":"next"}');
    assert.throws(
      () => assertCompleteNextRuntime(root, 'Packaged Next runtime'),
      /dist[\\/]compiled[\\/]webpack[\\/]webpack\.js/,
    );
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});
