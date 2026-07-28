import assert from 'node:assert/strict';
import test from 'node:test';
import { selectEmbeddedBrowserChatSessionId } from './browser-chat-init';

test('mount selects the latest real conversation and skips empty placeholders', () => {
  const sessions = [
    { id: 'empty-placeholder', messages: [] },
    { id: 'latest-history', messages: [{ role: 'user' }] },
    { id: 'older-history', messages: [{ role: 'user' }] },
  ];
  assert.equal(selectEmbeddedBrowserChatSessionId(sessions, ''), 'latest-history');
});

test('mount keeps an explicitly requested session and creates no fallback id', () => {
  assert.equal(selectEmbeddedBrowserChatSessionId([], ' requested-session '), 'requested-session');
  assert.equal(selectEmbeddedBrowserChatSessionId([], ''), '');
});
