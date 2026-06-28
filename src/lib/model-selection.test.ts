import assert from 'node:assert/strict';
import test from 'node:test';
import {
  modelSelectionDiagnosticLabel,
  modelSelectionValueForConfig,
  resolveRuntimeModelSelection,
  type RuntimeModelConfig,
} from './model-selection';

const config: RuntimeModelConfig = {
  provider: 'deepseek',
  providers: {
    deepseek: {
      apiKey: '',
      baseURL: '',
      defaultModel: 'deepseek-v4-pro',
      model: 'deepseek-v4-pro',
      models: ['deepseek-v4-pro', 'deepseek-v3'],
    },
  },
  updatedAt: '',
};

test('resolveRuntimeModelSelection falls back to configured provider default', () => {
  const selection = resolveRuntimeModelSelection(config, { model: 'missing-model', provider: 'deepseek' });

  assert.deepEqual(selection, {
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
  });
});

test('modelSelectionValueForConfig normalizes provider and model together', () => {
  const value = modelSelectionValueForConfig(config, { model: 'deepseek-v3', provider: 'deepseek' });

  assert.equal(value, 'deepseek::model::deepseek-v3');
});

test('modelSelectionDiagnosticLabel includes current and default model source', () => {
  const label = modelSelectionDiagnosticLabel(config, { model: 'deepseek-v3', provider: 'deepseek' });

  assert.match(label, /DeepSeek/);
  assert.match(label, /deepseek-v3/);
  assert.match(label, /deepseek-v4-pro/);
  assert.match(label, /自选模型/);
});
