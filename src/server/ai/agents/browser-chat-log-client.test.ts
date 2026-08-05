import assert from 'node:assert/strict';
import test from 'node:test';
import { compactBrowserChatLogForClient } from './browser-chat-log-client';

test('removes full model request details from timeline logs', () => {
  const compacted = compactBrowserChatLogForClient({
    id: 'request',
    phase: 'ai:runtime:request',
    details: JSON.stringify({ prompt: 'large prompt' }),
  });

  assert.equal(compacted.details, undefined);
});

test('keeps renderable model output and removes raw provider payloads', () => {
  const compacted = compactBrowserChatLogForClient({
    id: 'response',
    phase: 'ai:runtime:response',
    details: JSON.stringify({
      aiOutput: {
        responseType: 'text',
        text: 'done',
        response: {
          content: [{ type: 'text', text: 'done' }],
          request: { prompt: 'large request' },
          response: { body: 'large response' },
          providerMetadata: { trace: 'large metadata' },
        },
      },
    }),
  });
  const details = JSON.parse(compacted.details || '{}');

  assert.equal(details.aiOutput.text, 'done');
  assert.deepEqual(details.aiOutput.response, { content: [{ type: 'text', text: 'done' }] });
  assert.equal(details.aiOutput.response.request, undefined);
  assert.equal(details.aiOutput.response.response, undefined);
});

test('does not alter details used by other timeline phases', () => {
  const log = { id: 'tool', phase: 'ai:tool', details: '{"tool":"browserCode"}' };
  assert.equal(compactBrowserChatLogForClient(log), log);
});
