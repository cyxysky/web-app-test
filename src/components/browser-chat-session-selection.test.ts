import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserChatSessionNavigationHref,
  compactBrowserChatSessionForList,
  loadRequestedBrowserChatSessionDetail,
  shouldAcceptBrowserChatViewportPosition,
  shouldActivateRequestedBrowserChatSession,
  shouldFinishBrowserChatSessionLoading,
} from './browser-chat-session-selection';

test('keeps only list metadata for an inactive conversation', () => {
  const compacted = compactBrowserChatSessionForList({
    id: 'chat-1',
    title: 'Retained title',
    messages: [{ content: 'large message' }],
    logs: [{ details: 'large log' }],
    steps: [{ prompt: 'large prompt' }],
    outputCycles: [{ text: 'large output' }],
    subagents: [{ content: 'large child result' }],
    consoleErrors: ['error'],
    networkErrors: ['error'],
    queuedTurns: [{ content: 'queued' }],
    pendingToolConfirmation: { prompt: 'confirm' },
    contextUsage: { currentTokens: 100 },
    targetUrl: 'https://example.com/private',
  });

  assert.equal(compacted.hasMessages, true);
  assert.equal(compacted.title, 'Retained title');
  assert.deepEqual(compacted.messages, []);
  assert.deepEqual(compacted.logs, []);
  assert.deepEqual(compacted.steps, []);
  assert.deepEqual(compacted.outputCycles, []);
  assert.deepEqual(compacted.subagents, []);
  assert.equal(compacted.pendingToolConfirmation, undefined);
  assert.equal(compacted.contextUsage, undefined);
  assert.equal(compacted.targetUrl, '');
});

test('updates the selected conversation and drops client-declared identity', () => {
  assert.equal(
    browserChatSessionNavigationHref('https://example.com/webpilot/browser-chat?userId=42&sessionId=old&targetUrl=https%3A%2F%2Fexample.com&onboarding=1', 'chat-new'),
    '/webpilot/browser-chat?sessionId=chat-new',
  );
  assert.equal(
    browserChatSessionNavigationHref('https://example.com/webpilot/browser-chat?userId=42&sessionId=old', ''),
    '/webpilot/browser-chat',
  );
});

test('does not let a stale route request replace the conversation selected by the user', () => {
  assert.equal(shouldActivateRequestedBrowserChatSession({
    activeSessionId: 'chat-selected',
    currentSelectionIntent: 2,
    requestedSessionId: 'chat-mounted',
    selectionIntent: 1,
  }), false);
  assert.equal(shouldActivateRequestedBrowserChatSession({
    activeSessionId: 'chat-selected',
    currentSelectionIntent: 2,
    requestedSessionId: 'chat-selected',
    selectionIntent: 2,
  }), true);
});

test('ignores a viewport-ready callback emitted by the previous conversation', () => {
  assert.equal(shouldAcceptBrowserChatViewportPosition({
    activeSessionId: 'chat-new',
    positionedSessionId: 'chat-old',
  }), false);
  assert.equal(shouldAcceptBrowserChatViewportPosition({
    activeSessionId: 'chat-new',
    positionedSessionId: 'chat-new',
  }), true);
});

test('keeps session loading visible until time and viewport gates are both ready', () => {
  assert.equal(shouldFinishBrowserChatSessionLoading({
    loadingSessionId: 'chat-new',
    minimumLoadingElapsed: false,
    viewportReady: true,
  }), false);
  assert.equal(shouldFinishBrowserChatSessionLoading({
    loadingSessionId: 'chat-new',
    minimumLoadingElapsed: true,
    viewportReady: false,
  }), false);
  assert.equal(shouldFinishBrowserChatSessionLoading({
    loadingSessionId: 'chat-new',
    minimumLoadingElapsed: true,
    viewportReady: true,
  }), true);
});

test('loads a requested session even when it is outside the first summary page', async () => {
  const detail = { id: 'chat-mounted', messages: ['existing message'], title: 'Mounted chat' };
  const requestedIds: string[] = [];

  const loaded = await loadRequestedBrowserChatSessionDetail(' chat-mounted ', async (sessionId) => {
    requestedIds.push(sessionId);
    return detail;
  });

  assert.deepEqual(requestedIds, ['chat-mounted']);
  assert.equal(loaded, detail);
  assert.deepEqual(loaded?.messages, ['existing message']);
});
