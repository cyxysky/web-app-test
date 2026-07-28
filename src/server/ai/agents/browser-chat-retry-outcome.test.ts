import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldCompleteRecoveredBrowserChatReply } from './browser-chat-retry-outcome';

test('completes a recovered final reply after browser tools already ran', () => {
  assert.equal(shouldCompleteRecoveredBrowserChatReply({
    recoveredAfterRetry: true,
    reply: 'The requested browser task is complete.',
    hasToolTrace: true,
    requiresToolEvidence: true,
  }), true);
});

test('does not complete a recovered tool-only response without final text', () => {
  assert.equal(shouldCompleteRecoveredBrowserChatReply({
    recoveredAfterRetry: true,
    reply: '   ',
    hasToolTrace: true,
    requiresToolEvidence: true,
  }), false);
});

test('completes a recovered text-only answer when no browser tool is required', () => {
  assert.equal(shouldCompleteRecoveredBrowserChatReply({
    recoveredAfterRetry: true,
    reply: 'Here is the answer.',
    hasToolTrace: false,
    requiresToolEvidence: false,
  }), true);
});

test('keeps tool evidence enforcement for recovered action claims without tools', () => {
  assert.equal(shouldCompleteRecoveredBrowserChatReply({
    recoveredAfterRetry: true,
    reply: 'The requested browser action is complete.',
    hasToolTrace: false,
    requiresToolEvidence: true,
  }), false);
});

test('does not alter ordinary non-retry replies', () => {
  assert.equal(shouldCompleteRecoveredBrowserChatReply({
    recoveredAfterRetry: false,
    reply: 'The requested browser task is complete.',
    hasToolTrace: true,
    requiresToolEvidence: true,
  }), false);
});
