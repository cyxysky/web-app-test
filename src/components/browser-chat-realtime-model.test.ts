import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeBrowserChatRealtimeCollections,
  mergeBrowserChatRealtimeRecords,
  parseBrowserChatRealtimePatch,
} from './browser-chat-realtime-model';

test('realtime record patches retain rendered subagents while updating their status', () => {
  const current = [
    { id: 'subagent-1', status: 'running', steps: [{ index: 1 }] },
    { id: 'subagent-2', status: 'passed', steps: [{ index: 2 }] },
  ];
  const merged = mergeBrowserChatRealtimeRecords(current, [
    { id: 'subagent-1', status: 'passed' },
  ]);
  assert.deepEqual(merged, [
    { id: 'subagent-1', status: 'passed', steps: [{ index: 1 }] },
    { id: 'subagent-2', status: 'passed', steps: [{ index: 2 }] },
  ]);
  assert.deepEqual(mergeBrowserChatRealtimeRecords(current, []), current);
});

test('browser-chat realtime collections replace newer records and prune removals', () => {
  const merged = mergeBrowserChatRealtimeCollections({
    messages: [
      { id: 'old', createdAt: '1', updatedAt: '1' },
      { id: 'keep', createdAt: '2', updatedAt: '2', value: 'before' },
    ],
    steps: [{ index: 1, value: 'remove' }, { index: 2, value: 'before' }],
    logs: [{ id: 'old-log', time: '1' }],
  }, {
    removedMessageIds: ['old'],
    removedStepIndexes: [1],
    removedLogIds: ['old-log'],
    messages: [{ id: 'keep', createdAt: '2', updatedAt: '3', value: 'after' }],
    steps: [{ index: 2, value: 'after' }],
    logs: [{ id: 'new-log', time: '2' }],
  });
  assert.deepEqual(merged.messages, [{ id: 'keep', createdAt: '2', updatedAt: '3', value: 'after' }]);
  assert.deepEqual(merged.steps, [{ index: 2, value: 'after' }]);
  assert.deepEqual(merged.logs, [{ id: 'new-log', time: '2' }]);
});

test('browser-chat realtime patch parser rejects missing session identities', () => {
  assert.equal(parseBrowserChatRealtimePatch({ session: {} }), undefined);
  assert.deepEqual(parseBrowserChatRealtimePatch({ session: { id: 'chat-1' } }), { session: { id: 'chat-1' } });
});
