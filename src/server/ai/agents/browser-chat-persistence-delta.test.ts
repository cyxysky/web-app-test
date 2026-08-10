import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyBrowserChatPersistenceDelta,
  collectBrowserChatPersistenceDelta,
  seedBrowserChatPersistenceCursor,
} from './browser-chat-persistence-delta';

test('browser chat persistence tracker emits changed and removed records', () => {
  const original = {
    id: 'chat-1',
    messages: [{ id: 'm1', text: 'old' }],
    steps: [{ index: 1, state: 'old' }],
    logs: [{ id: 'l1', text: 'old' }],
  };
  const cursor = seedBrowserChatPersistenceCursor(original);
  const changed = {
    id: 'chat-1',
    messages: [{ id: 'm1', text: 'new' }, { id: 'm2', text: 'new' }],
    steps: [],
    logs: original.logs,
  };
  const delta = collectBrowserChatPersistenceDelta(changed, cursor);
  assert.deepEqual(delta.messages.map((item) => item.id), ['m1', 'm2']);
  assert.deepEqual(delta.removedStepIndexes, [1]);
  assert.deepEqual(delta.logs, []);
  applyBrowserChatPersistenceDelta(cursor, delta);
  assert.deepEqual([...cursor.messages.keys()], ['m1', 'm2']);
  assert.deepEqual([...cursor.steps.keys()], []);
});
