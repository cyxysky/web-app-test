import assert from 'node:assert/strict';
import test from 'node:test';
import {
  transitionBrowserChatSession,
  type BrowserChatSessionLifecycleState,
} from './browser-chat-session-state';

test('browser-chat lifecycle keeps turn state atomic', () => {
  const session: BrowserChatSessionLifecycleState<unknown> = {
    status: 'idle',
    turnState: 'idle',
    busy: false,
    updatedAt: 'before',
  };
  const abortController = new AbortController();
  transitionBrowserChatSession(session, {
    type: 'turnStarted',
    assistantMessageId: 'assistant-1',
    abortController,
    at: 'started',
  });
  assert.equal(session.status, 'running');
  assert.equal(session.turnState, 'running');
  assert.equal(session.busy, true);
  assert.equal(session.activeAssistantMessageId, 'assistant-1');

  transitionBrowserChatSession(session, { type: 'turnFinished', at: 'finished' });
  assert.equal(session.status, 'idle');
  assert.equal(session.turnState, 'completed');
  assert.equal(session.busy, false);
  assert.equal(session.activeAssistantMessageId, undefined);
  assert.equal(session.activeAbortController, undefined);
});

test('browser-chat confirmation requires an active turn', () => {
  const session: BrowserChatSessionLifecycleState<{ id: string }> = {
    status: 'idle',
    turnState: 'idle',
    busy: false,
    updatedAt: 'before',
  };
  assert.throws(() => transitionBrowserChatSession(session, {
    type: 'confirmationPending',
    confirmation: { id: 'confirmation-1' },
    at: 'pending',
  }), /active browser-chat turn/);
});

test('browser-chat lifecycle exposes confirmation, human wait, and stopping states', () => {
  const session: BrowserChatSessionLifecycleState<{ id: string }> = {
    status: 'idle',
    turnState: 'idle',
    busy: false,
    updatedAt: 'before',
  };
  const abortController = new AbortController();
  transitionBrowserChatSession(session, {
    type: 'turnStarted',
    assistantMessageId: 'assistant-1',
    abortController,
    at: 'started',
  });
  transitionBrowserChatSession(session, {
    type: 'confirmationPending',
    confirmation: { id: 'confirmation-1' },
    at: 'confirmation',
  });
  assert.equal(session.turnState, 'awaiting_confirmation');
  transitionBrowserChatSession(session, { type: 'confirmationCleared' });
  assert.equal(session.turnState, 'running');
  transitionBrowserChatSession(session, { type: 'turnStopping', at: 'stopping' });
  assert.equal(session.turnState, 'stopping');
  transitionBrowserChatSession(session, { type: 'turnBlocked', at: 'blocked' });
  assert.equal(session.turnState, 'awaiting_human');
});
