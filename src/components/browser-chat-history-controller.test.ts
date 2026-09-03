import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserChatHasEarlierMessages,
  browserChatReachedHistoryTop,
  mergeBrowserChatHistoryChunkData,
  mergeBrowserChatSessionWindowData,
  type BrowserChatHistoryState,
} from './browser-chat-history-controller';

test('loads earlier messages only on the transition from a nonzero position to the exact top', () => {
  assert.equal(browserChatReachedHistoryTop(120, 1), false);
  assert.equal(browserChatReachedHistoryTop(1, 0), true);
  assert.equal(browserChatReachedHistoryTop(0, 0), false);
  assert.equal(browserChatReachedHistoryTop(0, 10), false);
});

test('offers earlier-message loading only while the message page has a cursor', () => {
  assert.equal(browserChatHasEarlierMessages({
    messages: { hasMore: false },
    steps: { cursor: 'older-steps', hasMore: true },
    logs: { cursor: 'older-logs', hasMore: true },
  }), false);
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

test('window refresh keeps historical subagent details when the new page omits them', () => {
  type OutputCycle = { id: string; refreshed?: boolean };
  const history = {
    messages: { hasMore: false },
    steps: { hasMore: false },
    logs: { hasMore: false },
  };
  const existing = {
    id: 'chat',
    history,
    messages: [],
    steps: [],
    logs: [],
    outputCycles: [{ id: 'main-cycle' }, { id: 'subagent-cycle' }] as OutputCycle[],
    subagents: [{ id: 'subagent-1' }],
  };
  const incoming = {
    id: 'chat',
    history,
    messages: [],
    steps: [],
    logs: [],
    outputCycles: [{ id: 'main-cycle', refreshed: true }] as OutputCycle[],
    subagents: [],
  };
  const merged = mergeBrowserChatSessionWindowData(existing, incoming);
  assert.deepEqual(merged.outputCycles?.map((cycle) => cycle.id), ['main-cycle', 'subagent-cycle']);
  assert.deepEqual(merged.subagents?.map((subagent) => subagent.id), ['subagent-1']);
  assert.equal(merged.outputCycles?.[0]?.refreshed, true);
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

test('first historical subagent query adds details without replacing main output cycles', () => {
  const current = {
    id: 'chat',
    messages: [],
    steps: [],
    logs: [],
    outputCycles: [{ id: 'main-cycle' }],
    subagents: [] as Array<{ id: string }>,
  };
  const merged = mergeBrowserChatHistoryChunkData(current, {
    outputCycles: [{ id: 'subagent-cycle' }],
    subagents: [{ id: 'subagent-1' }],
  });
  assert.deepEqual(merged.outputCycles?.map((cycle) => cycle.id), ['main-cycle', 'subagent-cycle']);
  assert.deepEqual(merged.subagents?.map((subagent) => subagent.id), ['subagent-1']);
});
