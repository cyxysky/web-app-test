import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserChatSessionNavigationHref,
  browserChatViewNavigationHref,
  findRequestedBrowserChatSession,
  loadRequestedBrowserChatSessionDetail,
  shouldAcceptBrowserChatViewportPosition,
  shouldActivateRequestedBrowserChatSession,
  shouldFinishBrowserChatSessionLoading,
} from './browser-chat-session-selection';

test('updates the selected conversation and drops client-declared identity', () => {
  assert.equal(
    browserChatSessionNavigationHref('https://example.com/webpilot/browser-chat?userId=42&sessionId=old&targetUrl=https%3A%2F%2Fexample.com', 'chat-new'),
    '/webpilot/browser-chat?sessionId=chat-new',
  );
  assert.equal(
    browserChatSessionNavigationHref('https://example.com/webpilot/browser-chat?userId=42&sessionId=old', ''),
    '/webpilot/browser-chat',
  );
});

test('selects the session requested by the mounted browser-chat URL', () => {
  const sessions = [{ id: 'chat-old' }, { id: 'chat-mounted' }];

  assert.equal(findRequestedBrowserChatSession(sessions, ' chat-mounted '), sessions[1]);
});

test('preserves mounted view state without carrying client-declared identity', () => {
  assert.equal(
    browserChatViewNavigationHref('/webpilot/settings', 'https://example.com/webpilot/browser-chat?webpilotEmbed=1&userId=42&sessionId=chat-1'),
    '/webpilot/settings?webpilotEmbed=1&sessionId=chat-1',
  );
});

test('does not activate an unrelated session when the requested id is absent', () => {
  const sessions = [{ id: 'chat-old' }];

  assert.equal(findRequestedBrowserChatSession(sessions, ''), undefined);
  assert.equal(findRequestedBrowserChatSession(sessions, 'chat-missing'), undefined);
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
