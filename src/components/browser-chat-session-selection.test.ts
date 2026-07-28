import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findRequestedBrowserChatSession,
  loadRequestedBrowserChatSessionDetail,
} from './browser-chat-session-selection';

test('selects the session requested by the mounted browser-chat URL', () => {
  const sessions = [{ id: 'chat-old' }, { id: 'chat-mounted' }];

  assert.equal(findRequestedBrowserChatSession(sessions, ' chat-mounted '), sessions[1]);
});

test('does not activate an unrelated session when the requested id is absent', () => {
  const sessions = [{ id: 'chat-old' }];

  assert.equal(findRequestedBrowserChatSession(sessions, ''), undefined);
  assert.equal(findRequestedBrowserChatSession(sessions, 'chat-missing'), undefined);
});

test('loads the requested session detail instead of rendering the list summary as history', async () => {
  const summary = { id: 'chat-mounted', messages: [] as string[], title: 'Mounted chat' };
  const detail = { ...summary, messages: ['existing message'] };
  const requestedIds: string[] = [];

  const loaded = await loadRequestedBrowserChatSessionDetail([summary], summary.id, async (session) => {
    requestedIds.push(session.id);
    return detail;
  });

  assert.deepEqual(requestedIds, ['chat-mounted']);
  assert.equal(loaded, detail);
  assert.deepEqual(loaded?.messages, ['existing message']);
});
