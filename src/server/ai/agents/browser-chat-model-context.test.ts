import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelMessage } from 'ai';
import {
  appendInterruptedBrowserChatTurn,
  compactBrowserChatModelTranscript,
  normalizeBrowserChatModelContext,
  serializableBrowserChatModelMessages,
} from './browser-chat-model-context';

test('bounds the historical model transcript while retaining the newest messages', () => {
  const messages = Array.from({ length: 200 }, (_, index) => ({
    role: 'user' as const,
    content: `message-${index}`,
  }));
  const compacted = compactBrowserChatModelTranscript(messages);

  assert.equal(compacted.length, 160);
  assert.equal(compacted[0]?.content, 'message-40');
  assert.equal(compacted.at(-1)?.content, 'message-199');
});

test('keeps the native AI SDK user, tool call, tool result, and final assistant chain', () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: '读取订单状态' },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'inspect', input: { action: 'capture' } }],
    },
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'inspect', output: { type: 'text', value: '订单已完成' } }],
    },
    { role: 'assistant', content: '订单已完成。' },
  ];

  const stored = serializableBrowserChatModelMessages(messages);
  assert.deepEqual(stored, messages);
  assert.deepEqual(normalizeBrowserChatModelContext({ version: 1, transcript: stored, activeMessages: stored }), {
    version: 1,
    transcript: messages,
    activeMessages: messages,
  });
});

test('serializes binary AI SDK file parts as valid data URLs', () => {
  const messages: ModelMessage[] = [{
    role: 'user',
    content: [
      { type: 'text', text: '参考图片' },
      { type: 'file', data: Buffer.from('image-bytes'), mediaType: 'image/png' },
    ],
  }];

  const stored = serializableBrowserChatModelMessages(messages);
  const file = Array.isArray(stored[0]?.content) ? stored[0].content[1] : undefined;
  assert.equal(file?.type, 'file');
  if (file?.type !== 'file') assert.fail('expected a file part');
  assert.equal(file.data, 'data:image/png;base64,aW1hZ2UtYnl0ZXM=');
});

test('falls back to the transcript when an active chain was not stored', () => {
  const context = normalizeBrowserChatModelContext({
    version: 1,
    transcript: [{ role: 'user', content: '继续' }],
  });
  assert.deepEqual(context.activeMessages, context.transcript);
});

test('bounds the active model working set as well as the historical transcript', () => {
  const activeMessages = Array.from({ length: 220 }, (_, index) => ({
    role: 'user' as const,
    content: `active-${index}`,
  }));
  const context = normalizeBrowserChatModelContext({ version: 1, transcript: [], activeMessages });
  assert.equal(context.activeMessages.length, 160);
  assert.equal(context.activeMessages[0]?.content, 'active-60');
  assert.equal(context.activeMessages.at(-1)?.content, 'active-219');
});

test('an interrupted turn keeps completed tool messages and the partial assistant response in the native chain', () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: '读取需求 31471' },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'browserCode', input: { code: 'read page' } }],
    },
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'browserCode', output: { type: 'text', value: 'PRD data' } }],
    },
  ];

  const interrupted = appendInterruptedBrowserChatTurn(messages, '读取需求 31471', '已经读取到 PRD 数据');
  assert.equal(interrupted.filter((message) => message.role === 'user').length, 1);
  assert.equal(interrupted[2]?.role, 'tool');
  assert.match(String(interrupted.at(-1)?.content), /已经读取到 PRD 数据/);
  assert.match(String(interrupted.at(-1)?.content), /Historical context only/);
  assert.match(String(interrupted.at(-1)?.content), /never quote or copy this marker/);

  const repeated = appendInterruptedBrowserChatTurn(interrupted, '读取需求 31471', '已经读取到 PRD 数据');
  assert.deepEqual(repeated, interrupted);
});
