import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBrowserCodeRuntimeMode } from './browser-code-runtime-mode';

test('browser code runtime mode defaults safely to existing free behavior', () => {
  assert.equal(resolveBrowserCodeRuntimeMode(undefined), 'free');
  assert.equal(resolveBrowserCodeRuntimeMode('free'), 'free');
  assert.equal(resolveBrowserCodeRuntimeMode('unexpected'), 'free');
  assert.equal(resolveBrowserCodeRuntimeMode(' restricted '), 'restricted');
});

