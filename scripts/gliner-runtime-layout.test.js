/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  assertGlinerRuntime,
  copyGlinerRuntime,
  requiredGlinerRuntimeEntries,
} = require('./gliner-runtime-layout');

function createRuntimeFixture(runtimeRoot) {
  for (const entry of requiredGlinerRuntimeEntries(runtimeRoot)) {
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, path.basename(entry), 'utf8');
  }
}

test('the prepared GLiNER runtime is validated and copied as one unit', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-gliner-layout-'));
  const sourceRoot = path.join(temporaryRoot, 'source');
  const targetRoot = path.join(temporaryRoot, 'target');

  try {
    createRuntimeFixture(sourceRoot);
    assert.equal(assertGlinerRuntime(sourceRoot), sourceRoot);
    assert.equal(copyGlinerRuntime(targetRoot, sourceRoot), targetRoot);
    assert.deepEqual(
      requiredGlinerRuntimeEntries(targetRoot).map((entry) => fs.existsSync(entry)),
      [true, true, true, true, true, true, true],
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('an incomplete GLiNER runtime cannot enter a distribution', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-gliner-layout-'));
  try {
    assert.throws(() => assertGlinerRuntime(temporaryRoot), /bundled GLiNER runtime is incomplete/);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
