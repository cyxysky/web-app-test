import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelMessage } from 'ai';
import {
  appendInterruptedBrowserChatTurn,
  appendTerminalBrowserChatTurn,
  compactBrowserChatModelTranscript,
  normalizeBrowserChatModelContext,
  serializableBrowserChatModelMessages,
} from './browser-chat-model-context';

test('retains the complete historical model transcript without a message-count limit', () => {
  const messages = Array.from({ length: 200 }, (_, index) => ({
    role: 'user' as const,
    content: `message-${index}`,
  }));
  const compacted = compactBrowserChatModelTranscript(messages);

  assert.equal(compacted.length, 200);
  assert.equal(compacted[0]?.content, 'message-0');
  assert.equal(compacted.at(-1)?.content, 'message-199');
});

test('keeps the native AI SDK user, tool call, tool result, and final assistant chain', () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: '读取订单状态' },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'browserCode', input: { code: 'nodeRepl.write(await page.title())' } }],
    },
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'browserCode', output: { type: 'text', value: '订单已完成' } }],
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

test('omits binary AI SDK file parts from persistent model context', () => {
  const messages: ModelMessage[] = [{
    role: 'user',
    content: [
      { type: 'text', text: '参考图片' },
      { type: 'file', data: Buffer.from('image-bytes'), mediaType: 'image/png' },
    ],
  }];

  const stored = serializableBrowserChatModelMessages(messages);
  assert.equal(Array.isArray(stored[0]?.content), true);
  assert.equal(Array.isArray(stored[0]?.content) ? stored[0].content.length : 0, 1);
  assert.doesNotMatch(JSON.stringify(stored), /base64|image-bytes/);
});

test('removes legacy persisted data URL file parts while loading model context', () => {
  const context = normalizeBrowserChatModelContext({
    version: 1,
    transcript: [],
    activeMessages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'keep this instruction' },
        { type: 'file', data: 'data:image/png;base64,aW1hZ2UtYnl0ZXM=', mediaType: 'image/png' },
      ],
    }],
  });

  assert.equal(Array.isArray(context.activeMessages[0]?.content), true);
  assert.equal(Array.isArray(context.activeMessages[0]?.content) ? context.activeMessages[0].content.length : 0, 1);
  assert.doesNotMatch(JSON.stringify(context), /base64/);
});

test('falls back to the transcript when an active chain was not stored', () => {
  const context = normalizeBrowserChatModelContext({
    version: 1,
    transcript: [{ role: 'user', content: '继续' }],
  });
  assert.deepEqual(context.activeMessages, context.transcript);
});

test('retains the complete active model working set', () => {
  const activeMessages = Array.from({ length: 220 }, (_, index) => ({
    role: 'user' as const,
    content: `active-${index}`,
  }));
  const context = normalizeBrowserChatModelContext({ version: 1, transcript: [], activeMessages });
  assert.equal(context.activeMessages.length, 220);
  assert.equal(context.activeMessages[0]?.content, 'active-0');
  assert.equal(context.activeMessages.at(-1)?.content, 'active-219');
});

test('a failed terminal turn remains available to the next model cycle without duplicating its user message', () => {
  const stored = appendTerminalBrowserChatTurn(
    [{ role: 'user', content: 'finish the report' }],
    'finish the report',
    'Execution failed: upstream timeout.',
  );

  assert.deepEqual(stored, [
    { role: 'user', content: 'finish the report' },
    { role: 'assistant', content: 'Execution failed: upstream timeout.' },
  ]);
});

test('retains the durable continuation summary independently from active message markers', () => {
  const context = normalizeBrowserChatModelContext({
    version: 1,
    transcript: [],
    activeMessages: [{ role: 'user', content: '继续' }],
    lastCompression: {
      compressedAt: '2026-08-24T00:00:00.000Z',
      continuationSummary: '{"completed":["已读取需求"],"nextStep":"继续生成"}',
      estimatedTokensAfter: 40_000,
      estimatedTokensBefore: 220_000,
      retainedMessageCount: 3,
      summarizedMessageCount: 150,
      targetCeilingTokens: 51_200,
      targetFloorTokens: 25_600,
      thresholdTokens: 217_600,
      windowTokens: 256_000,
    },
  });

  assert.match(context.lastCompression?.continuationSummary || '', /已读取需求/);
});

test('does not separate a large tool result from its tool call', () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: '读取大页面' },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'call-large', toolName: 'browserCode', input: { code: 'read page' } }],
    },
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'call-large', toolName: 'browserCode', output: { type: 'text', value: 'x'.repeat(3 * 1024 * 1024) } }],
    },
  ];

  const compacted = compactBrowserChatModelTranscript(messages);
  assert.deepEqual(compacted, messages);
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
