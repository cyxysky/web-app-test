import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultModelCapabilities,
  modelCapabilities,
  normalizedModelCapabilities,
} from './model-capabilities';

test('persisted per-model image capability is authoritative', () => {
  assert.equal(modelCapabilities({
    model: 'text-only',
    modelCapabilities: { 'text-only': { imageInput: false } },
  }, 'openai', 'text-only').imageInput, false);
  assert.equal(modelCapabilities({
    model: 'custom-vision',
    modelCapabilities: { 'custom-vision': { imageInput: true } },
  }, 'openai-compatible', 'custom-vision').imageInput, true);
});

test('unknown compatible models default to text-only while known vision ids migrate safely', () => {
  assert.equal(defaultModelCapabilities('openai-compatible', 'vendor-model').imageInput, false);
  assert.equal(defaultModelCapabilities('lmstudio', 'qwen3-vl-2b-instruct').imageInput, true);
});

test('normalization retains only current model ids and preserves explicit choices', () => {
  assert.deepEqual(normalizedModelCapabilities('openai-compatible', ['text', 'vision-vl'], {
    removed: { imageInput: true },
    text: { imageInput: true },
  }), {
    text: { imageInput: true },
    'vision-vl': { imageInput: true },
  });
});
