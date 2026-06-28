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
  );

  assert.equal(entries.length, 3);
  assert.equal(entries[1]?.kind, 'executed-group');
  if (entries[1]?.kind !== 'executed-group') return;
  assert.deepEqual(entries[1].items.map((item) => item.id), ['a1', 'a2']);
});

test('keeps a single empty assistant message as a normal message', () => {
  const messages = [
    { content: '', id: 'a1', role: 'assistant' as const },
    { content: 'done', id: 'a2', role: 'assistant' as const },
  ];
  const entries = buildBrowserChatMessageRenderEntries(
    messages,
    buildBrowserChatLogIndex([]),
    (message, logs) => browserChatAssistantMessageHasVisibleText(message, logs, () => []),
  );

  assert.equal(entries[0]?.kind, 'message');
  assert.equal(entries[1]?.kind, 'message');
});

test('reads message logs from direct message id and step index', () => {
  const logIndex = buildBrowserChatLogIndex([
    { id: 'direct', messageId: 'a1' },
    { id: 'step', stepIndex: 2 },
  ]);

  const logs = browserChatLogsForMessage({ content: '', id: 'a1', role: 'assistant', stepIndexes: [2] }, logIndex);

  assert.deepEqual(logs.map((log) => log.id), ['direct', 'step']);
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
