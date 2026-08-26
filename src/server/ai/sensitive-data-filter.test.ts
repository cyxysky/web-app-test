import assert from 'node:assert/strict';
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { test } from 'vitest';
import { filterSensitiveData, redactSensitiveTexts } from './sensitive-data-filter';

const environmentNames = [
  'AI_SENSITIVE_DATA_FILTER_ENABLED',
  'AI_SENSITIVE_DATA_FILTER_FAILURE_MODE',
  'AI_SENSITIVE_DATA_FILTER_TIMEOUT_MS',
  'AI_SENSITIVE_DATA_FILTER_THRESHOLD',
  'AI_SENSITIVE_DATA_FILTER_LABELS',
  'GLINER_RUNTIME_MODE',
  'GLINER_SERVICE_URL',
  'GLINER_SERVICE_API_KEY',
] as const;

function restoreEnvironment(previous: Record<string, string | undefined>) {
  for (const name of environmentNames) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
}

test('filters all model-visible prompt text while preserving protocol fields', async () => {
  const previousFetch = globalThis.fetch;
  const previousEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));
  let requestURL = '';
  let requestHeaders = new Headers();
  let requestPayload: { texts: string[]; labels?: string[]; threshold?: number } = { texts: [] };

  process.env.AI_SENSITIVE_DATA_FILTER_ENABLED = 'true';
  process.env.AI_SENSITIVE_DATA_FILTER_FAILURE_MODE = 'closed';
  process.env.AI_SENSITIVE_DATA_FILTER_LABELS = 'person, email address';
  process.env.AI_SENSITIVE_DATA_FILTER_THRESHOLD = '0.65';
  process.env.GLINER_RUNTIME_MODE = 'external';
  process.env.GLINER_SERVICE_URL = 'http://gliner.test/private';
  process.env.GLINER_SERVICE_API_KEY = 'sidecar-secret';
  globalThis.fetch = async (input, init) => {
    requestURL = input instanceof URL ? input.href : String(input);
    requestHeaders = new Headers(init?.headers);
    requestPayload = JSON.parse(String(init?.body)) as typeof requestPayload;
    return Response.json({
      texts: requestPayload.texts.map((text) => text
        .replaceAll('Alice', '[SENSITIVE_PERSON_1]')
        .replaceAll('alice@example.com', '[SENSITIVE_EMAIL_ADDRESS_1]')),
    });
  };

  const options = {
    prompt: [
      { role: 'system', content: 'Help Alice.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Email alice@example.com' },
          { type: 'file', mediaType: 'text/plain', filename: 'Alice.txt', data: { type: 'text', text: 'Alice profile' } },
        ],
      },
      {
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: 'call-Alice',
          toolName: 'lookupAlice',
          input: { owner: 'Alice', email: 'alice@example.com' },
        }],
      },
      {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 'call-Alice',
          toolName: 'lookupAlice',
          output: { type: 'json', value: { contact: 'alice@example.com' } },
        }],
      },
    ],
  } as LanguageModelV4CallOptions;

  try {
    const result = await filterSensitiveData(options);
    assert.equal(requestURL, 'http://gliner.test/private/redact');
    assert.equal(requestHeaders.get('x-api-key'), 'sidecar-secret');
    assert.deepEqual(requestPayload.labels, ['person', 'email address']);
    assert.equal(requestPayload.threshold, 0.65);
    assert.equal(requestPayload.texts.filter((text) => text === 'alice@example.com').length, 1);

    assert.equal(result.prompt[0].role, 'system');
    assert.equal(result.prompt[0].content, 'Help [SENSITIVE_PERSON_1].');
    const user = result.prompt[1];
    assert.equal(user.role, 'user');
    assert.equal(user.content[0].type, 'text');
    assert.equal(user.content[0].text, 'Email [SENSITIVE_EMAIL_ADDRESS_1]');
    assert.equal(user.content[1].type, 'file');
    assert.equal(user.content[1].filename, '[SENSITIVE_PERSON_1].txt');
    assert.deepEqual(user.content[1].data, { type: 'text', text: '[SENSITIVE_PERSON_1] profile' });

    const assistant = result.prompt[2];
    assert.equal(assistant.role, 'assistant');
    const toolCall = assistant.content[0];
    assert.equal(toolCall.type, 'tool-call');
    assert.equal(toolCall.toolCallId, 'call-Alice');
    assert.equal(toolCall.toolName, 'lookupAlice');
    assert.deepEqual(toolCall.input, {
      owner: '[SENSITIVE_PERSON_1]',
      email: '[SENSITIVE_EMAIL_ADDRESS_1]',
    });

    const tool = result.prompt[3];
    assert.equal(tool.role, 'tool');
    const toolResult = tool.content[0];
    assert.equal(toolResult.type, 'tool-result');
    assert.equal(toolResult.toolCallId, 'call-Alice');
    assert.equal(toolResult.toolName, 'lookupAlice');
    assert.deepEqual(toolResult.output, {
      type: 'json',
      value: { contact: '[SENSITIVE_EMAIL_ADDRESS_1]' },
    });
    assert.notEqual(result, options);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment(previousEnvironment);
  }
});

test('blocks requests by default when the GLiNER service fails', async () => {
  const previousFetch = globalThis.fetch;
  const previousEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));
  process.env.AI_SENSITIVE_DATA_FILTER_ENABLED = 'true';
  process.env.AI_SENSITIVE_DATA_FILTER_FAILURE_MODE = 'closed';
  process.env.GLINER_RUNTIME_MODE = 'external';
  process.env.GLINER_SERVICE_URL = 'http://gliner.test';
  globalThis.fetch = async () => { throw new Error('offline'); };

  try {
    await assert.rejects(
      () => filterSensitiveData({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Alice' }] }],
      }),
      /AI request was blocked/,
    );
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment(previousEnvironment);
  }
});

test('returns safe replacement metadata for the settings test interface', async () => {
  const previousFetch = globalThis.fetch;
  const previousEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));
  process.env.GLINER_RUNTIME_MODE = 'external';
  process.env.GLINER_SERVICE_URL = 'http://gliner.test';
  globalThis.fetch = async () => Response.json({
    texts: ['Contact [SENSITIVE_EMAIL_ADDRESS_1]'],
    replacements: [
      {
        textIndex: 0,
        start: 8,
        end: 21,
        label: 'email address',
        placeholder: '[SENSITIVE_EMAIL_ADDRESS_1]',
      },
      {
        textIndex: 4,
        start: 0,
        end: 2,
        label: 'invalid',
        placeholder: '[INVALID]',
      },
    ],
  });

  try {
    assert.deepEqual(await redactSensitiveTexts(['Contact a@example.com']), {
      texts: ['Contact [SENSITIVE_EMAIL_ADDRESS_1]'],
      replacements: [{
        textIndex: 0,
        start: 8,
        end: 21,
        label: 'email address',
        placeholder: '[SENSITIVE_EMAIL_ADDRESS_1]',
      }],
    });
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment(previousEnvironment);
  }
});

test('does not call GLiNER when filtering is disabled', async () => {
  const previousFetch = globalThis.fetch;
  const previousEnabled = process.env.AI_SENSITIVE_DATA_FILTER_ENABLED;
  delete process.env.AI_SENSITIVE_DATA_FILTER_ENABLED;
  globalThis.fetch = async () => { throw new Error('must not be called'); };
  const options = {
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'Alice' }] }],
  } as LanguageModelV4CallOptions;

  try {
    assert.equal(await filterSensitiveData(options), options);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousEnabled === undefined) delete process.env.AI_SENSITIVE_DATA_FILTER_ENABLED;
    else process.env.AI_SENSITIVE_DATA_FILTER_ENABLED = previousEnabled;
  }
});
