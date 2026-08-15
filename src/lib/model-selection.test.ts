import assert from 'node:assert/strict';
import test from 'node:test';
import { modelProviderDefinition } from '../config/settings';
import {
  modelSelectionOptionsForConfig,
  modelSelectionDiagnosticLabel,
  modelSelectionValueForConfig,
  resolveRuntimeModelSelection,
  type RuntimeModelConfig,
} from './model-selection';

const config: RuntimeModelConfig = {
  provider: 'deepseek',
  providers: {
    deepseek: {
      enabled: true,
      apiKey: '',
      baseURL: '',
      defaultModel: 'deepseek-v4-pro',
      model: 'deepseek-v4-pro',
      models: ['deepseek-v4-pro', 'deepseek-v3'],
    },
  },
  updatedAt: '',
};

test('DeepSeek exposes a configurable API base URL', () => {
  const definition = modelProviderDefinition('deepseek');

  assert.equal(definition.baseUrlLabel, 'DeepSeek 服务地址');
  assert.equal(definition.defaultBaseURL, 'https://api.deepseek.com');
});

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

test('model selection only exposes models from enabled providers', () => {
  const options = modelSelectionOptionsForConfig({
    ...config,
    providers: {
      ...config.providers,
      openai: {
        enabled: false,
        model: 'gpt-5.5',
        models: ['gpt-5.5'],
      },
    },
  });

  assert.equal(options.length >= 2, true);
  assert.equal(options.every((option) => option.group === 'DeepSeek'), true);
});

test('model selection is empty when every provider is disabled', () => {
  const options = modelSelectionOptionsForConfig({
    ...config,
    providers: {
      deepseek: { ...config.providers.deepseek!, enabled: false },
    },
  });

  assert.deepEqual(options, []);
});

test('modelSelectionDiagnosticLabel includes current and default model source', () => {
  const label = modelSelectionDiagnosticLabel(config, { model: 'deepseek-v3', provider: 'deepseek' });

  assert.match(label, /DeepSeek/);
  assert.match(label, /deepseek-v3/);
  assert.match(label, /deepseek-v4-pro/);
  assert.match(label, /自选模型/);
});
