import assert from 'node:assert/strict';
import test from 'node:test';
import { compactBrowserChatLogForClient, compactBrowserChatLogsForClient } from './browser-chat-log-client';

test('keeps compact request metadata and token estimates while removing messages', () => {
  const compacted = compactBrowserChatLogForClient({
    id: 'request',
    phase: 'ai:runtime:request',
    details: JSON.stringify({
      __browserChatFullLogDetails: true,
      value: {
        aiInput: {
          provider: 'azure-openai',
          model: 'deepseek-v4-flash',
          messages: [{ role: 'user', content: 'large prompt' }],
          tools: ['readFile'],
        },
        aiInputTokens: { estimatedTextTokens: 100, estimatedTotalTokens: 140 },
      },
      execution: { attemptId: 'attempt-1' },
    }),
  });
  const details = JSON.parse(compacted.details || '{}');

  assert.equal(details.aiInput.provider, 'azure-openai');
  assert.equal(details.aiInput.model, 'deepseek-v4-flash');
  assert.deepEqual(details.aiInput.tools, ['readFile']);
  assert.equal(details.aiInput.messages, undefined);
  assert.equal(details.aiInputTokens.estimatedTotalTokens, 140);
  assert.equal(details.execution.attemptId, 'attempt-1');
});

test('keeps renderable model output and removes raw provider payloads', () => {
  const compacted = compactBrowserChatLogForClient({
    id: 'response',
    phase: 'ai:runtime:response',
    details: JSON.stringify({
      __browserChatFullLogDetails: true,
      value: {
        aiOutput: {
          responseType: 'text',
          text: 'done',
          timings: { totalElapsedMs: 1200, aiRequestElapsedMs: 1000 },
          response: {
            content: [{ type: 'text', text: 'done' }],
            usage: { inputTokens: 100, outputTokens: 20 },
            request: { prompt: 'large request' },
            response: { body: 'large response' },
            providerMetadata: { trace: 'large metadata' },
          },
        },
      },
      execution: { attemptId: 'attempt-1' },
    }),
  });
  const details = JSON.parse(compacted.details || '{}');

  assert.equal(details.aiOutput.text, 'done');
  assert.deepEqual(details.aiOutput.response, {
    content: [{ type: 'text', text: 'done' }],
    usage: { inputTokens: 100, outputTokens: 20 },
  });
  assert.deepEqual(details.aiOutput.timings, { totalElapsedMs: 1200, aiRequestElapsedMs: 1000 });
  assert.equal(details.execution.attemptId, 'attempt-1');
  assert.equal(details.aiOutput.response.request, undefined);
  assert.equal(details.aiOutput.response.response, undefined);
});

test('does not alter details used by other timeline phases', () => {
  const log = { id: 'tool', phase: 'ai:tool', details: '{"tool":"browserCode"}' };
  assert.equal(compactBrowserChatLogForClient(log), log);
});

test('deduplicates repeated final tool lifecycle logs with the same execution identity', () => {
  const logs = compactBrowserChatLogsForClient([
    { id: 'started', phase: 'ai:tool', message: 'readFile -> running', stepIndex: 19, toolCallId: 'call-1' },
    { id: 'result', phase: 'ai:tool', message: 'readFile -> ok', stepIndex: 19, toolCallId: 'call-1' },
    { id: 'complete', phase: 'ai:tool', message: 'readFile -> ok', stepIndex: 19, toolCallId: 'call-1' },
  ]);

  assert.deepEqual(logs.map((log) => log.id), ['started', 'complete']);
});
