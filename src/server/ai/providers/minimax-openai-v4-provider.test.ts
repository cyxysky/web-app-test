import assert from 'node:assert/strict';
import test from 'node:test';
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { createMiniMaxOpenAIV4 } from './minimax-openai-v4-provider';

const minimalCall = {
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
} as LanguageModelV4CallOptions;

function requestBody(init?: RequestInit) {
  return JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
}

test('MiniMax project provider is native V4 and maps non-stream reasoning_details', async () => {
  let url = '';
  let body: Record<string, unknown> = {};
  const provider = createMiniMaxOpenAIV4({
    apiKey: 'test-key',
    baseURL: 'https://api.minimax.io/v1/',
    fetch: async (input, init) => {
      url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      body = requestBody(init);
      return Response.json({
        id: 'response-1',
        model: 'MiniMax-M2.7',
        choices: [{
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'pong',
            reasoning_details: [{ id: 'reasoning-1', type: 'reasoning.text', text: 'think first' }],
          },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      });
    },
  });
  const model = provider('MiniMax-M2.7');

  assert.equal(provider.specificationVersion, 'v4');
  assert.equal(model.specificationVersion, 'v4');
  const result = await model.doGenerate(minimalCall);

  assert.equal(url, 'https://api.minimax.io/v1/chat/completions');
  assert.equal(body.reasoning_split, true);
  assert.deepEqual(result.content.map((part) => part.type), ['text', 'reasoning']);
  const reasoning = result.content.find((part) => part.type === 'reasoning');
  assert.equal(reasoning?.text, 'think first');
  assert.deepEqual(reasoning?.providerMetadata?.minimax?.reasoningDetails, [
    { id: 'reasoning-1', type: 'reasoning.text', text: 'think first' },
  ]);
});

test('MiniMax project provider preserves reasoning_details in the next tool turn', async () => {
  let body: Record<string, unknown> = {};
  const details = [{ id: 'reasoning-1', type: 'reasoning.text', text: 'preserve exactly' }];
  const model = createMiniMaxOpenAIV4({
    apiKey: 'test-key',
    baseURL: 'https://api.minimax.io/v1',
    fetch: async (_input, init) => {
      body = requestBody(init);
      return Response.json({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  })('MiniMax-M2.7');

  await model.doGenerate({
    prompt: [{
      role: 'assistant',
      content: [{
        type: 'reasoning',
        text: 'preserve exactly',
        providerOptions: { minimax: { reasoningDetails: details } },
      }],
    }, { role: 'user', content: [{ type: 'text', text: 'continue' }] }],
  });

  const messages = body.messages as Array<Record<string, unknown>>;
  assert.deepEqual(messages[0].reasoning_details, details);
  assert.equal(messages[0].reasoning_content, undefined);
});

test('MiniMax project provider converts cumulative streaming reasoning and retains metadata', async () => {
  const events = [
    { id: 'response-1', choices: [{ delta: { role: 'assistant', reasoning_details: [{ id: 'reasoning-1', type: 'reasoning.text', text: 'think' }] }, finish_reason: null }] },
    { id: 'response-1', choices: [{ delta: { reasoning_details: [{ id: 'reasoning-1', type: 'reasoning.text', text: 'thinking' }] }, finish_reason: null }] },
    { id: 'response-1', choices: [{ delta: { content: 'done' }, finish_reason: null }] },
    { id: 'response-1', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
  ];
  const model = createMiniMaxOpenAIV4({
    fetch: async () => new Response(
      `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    ),
  })('MiniMax-M2.7');

  const result = await model.doStream(minimalCall);
  const parts: LanguageModelV4StreamPart[] = [];
  const reader = result.stream.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    parts.push(next.value);
  }

  assert.deepEqual(
    parts.filter((part) => part.type === 'reasoning-delta').map((part) => part.delta),
    ['think', 'ing'],
  );
  const reasoningEnd = parts.find((part) => part.type === 'reasoning-end');
  assert.deepEqual(reasoningEnd?.providerMetadata?.minimax?.reasoningDetails, [
    { id: 'reasoning-1', type: 'reasoning.text', text: 'thinking' },
  ]);
  assert.equal(parts.some((part) => part.type === 'raw'), false);
});
