import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeRuntimeEnvValue,
  runtimeEnvDefinition,
} from './settings';

test('browser preview FPS setting is a bounded integer input', () => {
  const definition = runtimeEnvDefinition('BROWSER_PREVIEW_FPS');
  assert.ok(definition);
  assert.equal(definition.control, 'number');
  assert.equal(definition.defaultValue, '20');
  assert.equal(definition.min, 1);
  assert.equal(definition.max, 60);
  assert.equal(definition.step, 1);
  assert.equal(normalizeRuntimeEnvValue(definition, '0'), '1');
  assert.equal(normalizeRuntimeEnvValue(definition, '24.6'), '25');
  assert.equal(normalizeRuntimeEnvValue(definition, '100'), '60');
  assert.equal(normalizeRuntimeEnvValue(definition, ''), '20');
});
