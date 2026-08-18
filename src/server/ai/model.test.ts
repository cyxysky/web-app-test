import assert from 'node:assert/strict';
import test from 'node:test';
import type { LanguageModelV4, LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { getModel, withModelSettings } from './model';

const minimalCall = {
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
} as LanguageModelV4CallOptions;

test('blank provider base URLs are treated as unset before lazy provider imports', async () => {
  const previousFetch = globalThis.fetch;
  const previousAnthropicBaseURL = process.env.ANTHROPIC_BASE_URL;
  const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const previousOpenAIBaseURL = process.env.OPENAI_BASE_URL;
  const previousOpenAIApiKey = process.env.OPENAI_API_KEY;
  const previousMiniMaxBaseURL = process.env.MINIMAX_BASE_URL;
  const previousMiniMaxApiKey = process.env.MINIMAX_API_KEY;
  globalThis.fetch = async () => {
    throw new Error('provider-loaded');
  };
  process.env.ANTHROPIC_BASE_URL = '   ';
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.OPENAI_BASE_URL = '   ';
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.MINIMAX_BASE_URL = '   ';
  process.env.MINIMAX_API_KEY = 'test-key';

  try {
    for (const settings of [
      { provider: 'anthropic', model: 'claude-sonnet-4-5' },
      { provider: 'minimax', model: 'minimax-m3' },
      { provider: 'openai', model: 'gpt-5.5' },
    ]) {
      const model = withModelSettings(settings, () => getModel()) as LanguageModelV4;
      await assert.rejects(async () => await model.doGenerate(minimalCall), /provider-loaded/);
    }
    assert.equal(process.env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(process.env.MINIMAX_BASE_URL, undefined);
    assert.equal(process.env.OPENAI_BASE_URL, undefined);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironmentValue('ANTHROPIC_BASE_URL', previousAnthropicBaseURL);
    restoreEnvironmentValue('ANTHROPIC_API_KEY', previousAnthropicApiKey);
    restoreEnvironmentValue('OPENAI_BASE_URL', previousOpenAIBaseURL);
    restoreEnvironmentValue('OPENAI_API_KEY', previousOpenAIApiKey);
    restoreEnvironmentValue('MINIMAX_BASE_URL', previousMiniMaxBaseURL);
    restoreEnvironmentValue('MINIMAX_API_KEY', previousMiniMaxApiKey);
  }
});

function restoreEnvironmentValue(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
