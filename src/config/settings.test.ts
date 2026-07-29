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

test('browser viewport resolution setting exposes named presets and custom dimensions', () => {
  const definition = runtimeEnvDefinition('BROWSER_VIEWPORT_RESOLUTION');
  assert.ok(definition);
  assert.equal(definition.control, 'select');
  assert.equal(definition.defaultValue, 'auto');
  assert.deepEqual(definition.options?.map((option) => option.value), ['auto', '1080p', '2k', '4k', '8k', 'custom']);
  assert.equal(runtimeEnvDefinition('BROWSER_VIEWPORT_MODE'), undefined);
});

test('settings omit unused automatic screenshot and context compression controls', () => {
  for (const key of [
    'SCREENSHOT_STABILIZE_MS',
    'BROWSER_CHAT_DOM_SCREENSHOTS',
    'AI_AGENT_LOOP_SUMMARY_INPUT_MAX_CHARS',
    'AI_AGENT_LOOP_SUMMARY_OUTPUT_MAX_CHARS',
    'AI_VISUAL_COMPRESSED_HISTORY_LIMIT',
    'AI_VISUAL_COMPRESSED_PINNED_LIMIT',
    'AI_PROMPT_SCREENSHOT_REFERENCE_LIMIT',
  ]) {
    assert.equal(runtimeEnvDefinition(key), undefined, `${key} should not be exposed`);
  }
  assert.equal(runtimeEnvDefinition('SEND_SCREENSHOT_TO_AI')?.label, 'AI 图片输入');
});
