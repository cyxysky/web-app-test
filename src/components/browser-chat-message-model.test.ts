import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBrowserChatAiCycleRenderEntries,
  buildBrowserChatLogIndex,
  buildBrowserChatMessageRenderEntries,
  browserChatAssistantMessageHasVisibleText,
  browserChatLogsForMessage,
} from './browser-chat-message-model';

test('groups consecutive assistant messages without visible text', () => {
  const messages = [
    { content: 'start', id: 'u1', role: 'user' as const },
    { content: '', id: 'a1', role: 'assistant' as const, stepIndexes: [1] },
    { content: '  ', id: 'a2', role: 'assistant' as const, stepIndexes: [2] },
    { content: 'done', id: 'a3', role: 'assistant' as const },
  ];
  const logIndex = buildBrowserChatLogIndex([{ id: 'l1', stepIndex: 1 }, { id: 'l2', stepIndex: 2 }]);
  const entries = buildBrowserChatMessageRenderEntries(
    messages,
    logIndex,
    (message, logs) => browserChatAssistantMessageHasVisibleText(message, logs, () => []),
    (message) => Boolean(message.stepIndexes?.length),
  );

  assert.equal(entries.length, 3);
  assert.equal(entries[1]?.kind, 'executed-group');
  if (entries[1]?.kind !== 'executed-group') return;
  assert.deepEqual(entries[1].items.map((item) => item.id), ['a1', 'a2']);
});

test('drops an empty assistant message when it has no executed tool', () => {
  const messages = [
    { content: '', id: 'a1', role: 'assistant' as const },
    { content: 'done', id: 'a2', role: 'assistant' as const },
  ];
  const entries = buildBrowserChatMessageRenderEntries(
    messages,
    buildBrowserChatLogIndex([]),
    (message, logs) => browserChatAssistantMessageHasVisibleText(message, logs, () => []),
    () => false,
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.kind, 'message');
  if (entries[0]?.kind !== 'message') return;
  assert.equal(entries[0].item.id, 'a2');
});

test('reads message logs only from the direct message id', () => {
  const logIndex = buildBrowserChatLogIndex([
    { id: 'step', stepIndex: 2 },
    { id: 'direct', messageId: 'a1' },
  ]);

  const logs = browserChatLogsForMessage({ content: '', id: 'a1', role: 'assistant', stepIndexes: [2] }, logIndex);

  assert.deepEqual(logs.map((log) => log.id), ['direct']);
});

test('groups ai cycles without text into executed entries', () => {
  const entries = buildBrowserChatAiCycleRenderEntries([
    { id: 'c1', output: { texts: [] } },
    { id: 'c2', output: { texts: ['   '] } },
    { id: 'c3', output: { texts: ['visible'] } },
  ]);

  assert.equal(entries[0]?.kind, 'executed');
  assert.equal(entries[1]?.kind, 'cycle');
});

test('does not render an executed group for an AI tool request without a real execution', () => {
  const entries = buildBrowserChatAiCycleRenderEntries([
    { id: 'c1', output: { texts: [] } },
  ], () => false);

  assert.deepEqual(entries, []);
});

test('keeps reasoning-only cycles out of the executed group', () => {
  const entries = buildBrowserChatAiCycleRenderEntries([
    { id: 'c1', output: { reasoning: ['checking the file'], texts: [] } },
  ], () => false);

  assert.equal(entries[0]?.kind, 'cycle');
});
