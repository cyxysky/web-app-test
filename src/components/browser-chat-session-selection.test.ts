import assert from 'node:assert/strict';
import test from 'node:test';
import { findRequestedBrowserChatSession } from './browser-chat-session-selection';

test('selects the session requested by the mounted browser-chat URL', () => {
  const sessions = [{ id: 'chat-old' }, { id: 'chat-mounted' }];

  assert.equal(findRequestedBrowserChatSession(sessions, ' chat-mounted '), sessions[1]);
});

test('does not activate an unrelated session when the requested id is absent', () => {
  const sessions = [{ id: 'chat-old' }];

  assert.equal(findRequestedBrowserChatSession(sessions, ''), undefined);
  assert.equal(findRequestedBrowserChatSession(sessions, 'chat-missing'), undefined);
});
