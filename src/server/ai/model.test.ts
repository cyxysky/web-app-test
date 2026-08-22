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

test('MiniMax uses the OpenAI-compatible endpoint and tool schema', async () => {
  const previousFetch = globalThis.fetch;
  const previousMiniMaxBaseURL = process.env.MINIMAX_BASE_URL;
  const previousMiniMaxApiKey = process.env.MINIMAX_API_KEY;
  let requestUrl = '';
  let requestBody: Record<string, unknown> = {};

  globalThis.fetch = async (input, init) => {
    requestUrl = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    requestBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    throw new Error('openai-compatible-provider-called');
  };
  process.env.MINIMAX_BASE_URL = 'https://api.minimaxi.com/anthropic/v1';
  process.env.MINIMAX_API_KEY = 'test-key';

  try {
    const model = withModelSettings(
      { provider: 'minimax', model: 'minimax-m3' },
      () => getModel(),
    ) as LanguageModelV4;
    const call = {
      ...minimalCall,
      tools: [{
        type: 'function',
        name: 'file',
        description: 'Create a document',
        inputSchema: {
          type: 'object',
          properties: {
            blocks: { type: 'array', items: { type: 'object' } },
            render: { type: 'boolean' },
          },
          required: ['blocks'],
        },
      }],
    } as LanguageModelV4CallOptions;

    await assert.rejects(
      async () => await model.doGenerate(call),
      /openai-compatible-provider-called/,
    );
    assert.equal(requestUrl, 'https://api.minimaxi.com/v1/chat/completions');
    assert.equal(requestBody.reasoning_split, true);
    assert.deepEqual(requestBody.tools, [{
      type: 'function',
      function: {
        name: 'file',
        description: 'Create a document',
        parameters: {
          type: 'object',
          properties: {
            blocks: { type: 'array', items: { type: 'object' } },
            render: { type: 'boolean' },
          },
          required: ['blocks'],
        },
      },
    }]);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironmentValue('MINIMAX_BASE_URL', previousMiniMaxBaseURL);
    restoreEnvironmentValue('MINIMAX_API_KEY', previousMiniMaxApiKey);
  }
});

test('custom OpenAI-compatible provider uses its independent Base URL and key', async () => {
  const previousFetch = globalThis.fetch;
  const previousBaseURL = process.env.OPENAI_COMPATIBLE_BASE_URL;
  const previousApiKey = process.env.OPENAI_COMPATIBLE_API_KEY;
  let requestUrl = '';
  let authorization = '';

  globalThis.fetch = async (input, init) => {
    requestUrl = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    authorization = new Headers(init?.headers).get('authorization') || '';
    throw new Error('custom-openai-compatible-provider-called');
  };
  process.env.OPENAI_COMPATIBLE_BASE_URL = 'https://gateway.example/v1';
  process.env.OPENAI_COMPATIBLE_API_KEY = 'custom-key';

  try {
    const model = withModelSettings(
      { provider: 'openai-compatible', model: 'vendor-model' },
      () => getModel(),
    ) as LanguageModelV4;
    await assert.rejects(
      async () => await model.doGenerate(minimalCall),
      /custom-openai-compatible-provider-called/,
    );
    assert.equal(requestUrl, 'https://gateway.example/v1/chat/completions');
    assert.equal(authorization, 'Bearer custom-key');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironmentValue('OPENAI_COMPATIBLE_BASE_URL', previousBaseURL);
    restoreEnvironmentValue('OPENAI_COMPATIBLE_API_KEY', previousApiKey);
  }
});

test('the second and third OpenAI-compatible providers use isolated endpoints and keys', async () => {
  const previousFetch = globalThis.fetch;
  const environments = [
    {
      provider: 'openai-compatible-2',
      baseName: 'OPENAI_COMPATIBLE_2_BASE_URL',
      keyName: 'OPENAI_COMPATIBLE_2_API_KEY',
      baseURL: 'https://second.example/v1',
      apiKey: 'second-key',
    },
    {
      provider: 'openai-compatible-3',
      baseName: 'OPENAI_COMPATIBLE_3_BASE_URL',
      keyName: 'OPENAI_COMPATIBLE_3_API_KEY',
      baseURL: 'https://third.example/v1',
      apiKey: 'third-key',
    },
  ] as const;
  const previous = environments.map((item) => ({
    baseURL: process.env[item.baseName],
    apiKey: process.env[item.keyName],
  }));
  let requestUrl = '';
  let authorization = '';
  globalThis.fetch = async (input, init) => {
    requestUrl = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    authorization = new Headers(init?.headers).get('authorization') || '';
    throw new Error('isolated-compatible-provider-called');
  };
  try {
    for (const item of environments) {
      process.env[item.baseName] = item.baseURL;
      process.env[item.keyName] = item.apiKey;
      const model = withModelSettings(
        { provider: item.provider, model: 'vendor-model' },
        () => getModel(),
      ) as LanguageModelV4;
      await assert.rejects(
        async () => await model.doGenerate(minimalCall),
        /isolated-compatible-provider-called/,
      );
      assert.equal(requestUrl, `${item.baseURL}/chat/completions`);
      assert.equal(authorization, `Bearer ${item.apiKey}`);
    }
  } finally {
    globalThis.fetch = previousFetch;
    environments.forEach((item, index) => {
      restoreEnvironmentValue(item.baseName, previous[index].baseURL);
      restoreEnvironmentValue(item.keyName, previous[index].apiKey);
    });
  }
});
