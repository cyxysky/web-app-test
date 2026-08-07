import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserChatHasEarlierMessages,
  mergeBrowserChatHistoryChunkData,
  mergeBrowserChatSessionWindowData,
  type BrowserChatHistoryState,
} from './browser-chat-history-controller';

test('continues loading while logs or steps still have earlier pages', () => {
  assert.equal(browserChatHasEarlierMessages({
    messages: { hasMore: false },
    steps: { cursor: 'older-steps', hasMore: true },
    logs: { cursor: 'older-logs', hasMore: true },
  }), true);
  assert.equal(browserChatHasEarlierMessages({
    messages: { cursor: 'older-messages', hasMore: true },
    steps: { hasMore: false },
    logs: { hasMore: false },
  }), true);
});

test('window refresh keeps already loaded older records while accepting current records', () => {
  const history = {
    messages: { cursor: 'older', hasMore: true },
    steps: { hasMore: false },
    logs: { hasMore: false },
  };
  const existing = { id: 'chat', history, messages: [{ id: 'old', createdAt: '1' }], steps: [], logs: [] };
  const incoming = { id: 'chat', history: { ...history, messages: { cursor: 'newer', hasMore: true } }, messages: [{ id: 'new', createdAt: '2' }], steps: [], logs: [] };
  const merged = mergeBrowserChatSessionWindowData(existing, incoming);
  assert.deepEqual(merged.messages.map((message) => message.id), ['old', 'new']);
  assert.equal(merged.history?.messages.cursor, 'older');
});

test('older history chunks merge without duplicating messages', () => {
  const current: {
    history?: BrowserChatHistoryState;
    id: string;
    logs: Array<{ id: string; time?: string }>;
    messages: Array<{ id: string; createdAt: string }>;
    steps: Array<{ index: number }>;
  } = { id: 'chat', messages: [{ id: 'new', createdAt: '2' }], steps: [], logs: [] };
  const merged = mergeBrowserChatHistoryChunkData(current, {
    messages: [{ id: 'old', createdAt: '1' }, { id: 'new', createdAt: '2' }],
    history: { messages: { hasMore: false } },
  });
  assert.deepEqual(merged.messages.map((message) => message.id), ['old', 'new']);
  assert.equal(merged.history?.messages.hasMore, false);
});
