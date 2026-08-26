import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

test('settings snapshots expose secret presence without returning the model key', async () => {
  const previousDataRoot = process.env.APP_DATA_DIR;
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  const previousSensitiveDataFilterEnabled = process.env.AI_SENSITIVE_DATA_FILTER_ENABLED;
  const dataRoot = mkdtempSync(join(tmpdir(), 'webpilot-settings-'));
  process.env.APP_DATA_DIR = dataRoot;
  process.env.AI_SENSITIVE_DATA_FILTER_ENABLED = 'true';

  const databaseModule = await import('@/server/storage/sqlite-database');
  const { store } = await import('@/server/db/store');
  const { readEnvironmentSettingsSnapshot, readModelSettingsState } = await import('./settings-snapshot');
  const secret = 'unit-test-secret-that-must-never-leave-settings';

  try {
    store.saveModelConfig({
      provider: 'openai',
      providers: {
        openai: {
          enabled: true,
          apiKey: secret,
          baseURL: 'https://api.openai.com/v1',
          defaultModel: 'gpt-4.1',
          model: 'gpt-4.1',
          models: ['gpt-4.1'],
        },
      },
    });

    const state = readModelSettingsState();
    assert.equal(state.config.providers.openai?.apiKey, '');
    assert.equal(state.config.providers.openai?.enabled, true);
    assert.equal(state.config.providers.openai?.hasApiKey, true);
    assert.equal(state.config.providers.deepseek?.enabled, false);
    assert.equal(JSON.stringify(state).includes(secret), false);
    const environmentSnapshot = readEnvironmentSettingsSnapshot();
    assert.equal(JSON.stringify(environmentSnapshot).includes(secret), false);
    assert.equal(
      environmentSnapshot.envItems.find((item) => item.key === 'AI_SENSITIVE_DATA_FILTER_ENABLED')?.value,
      'true',
    );
  } finally {
    databaseModule.getSqliteDatabase().close();
    if (previousDataRoot === undefined) delete process.env.APP_DATA_DIR;
    else process.env.APP_DATA_DIR = previousDataRoot;
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
    if (previousSensitiveDataFilterEnabled === undefined) delete process.env.AI_SENSITIVE_DATA_FILTER_ENABLED;
    else process.env.AI_SENSITIVE_DATA_FILTER_ENABLED = previousSensitiveDataFilterEnabled;
    rmSync(dataRoot, { force: true, recursive: true });
  }
});
