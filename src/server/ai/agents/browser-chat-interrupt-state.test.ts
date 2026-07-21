import assert from 'node:assert/strict';
import test from 'node:test';
import { revokeBrowserChatTurn, runtimeSnapshotIsNewer } from './browser-chat-interrupt-state';

test('revokes turn ownership before dispatching abort and does not await settlement', () => {
  const controller = new AbortController();
  const session = {
    activeAbortController: controller,
    activeAssistantMessageId: 'assistant-1',
    pendingToolConfirmation: { id: 'confirmation-1' },
    busy: true,
    status: 'running' as const,
    error: 'old error',
    updatedAt: '2026-07-21T00:00:00.000Z',
  };
  let stateAtAbort: unknown;
  controller.signal.addEventListener('abort', () => {
    stateAtAbort = {
      activeAbortController: session.activeAbortController,
      activeAssistantMessageId: session.activeAssistantMessageId,
      busy: session.busy,
      status: session.status,
    };
  });

  const result = revokeBrowserChatTurn(
    session,
    '2026-07-21T00:00:01.000Z',
    new Error('interrupted'),
  );

  assert.equal(result.assistantMessageId, 'assistant-1');
  assert.equal(result.abortDispatched, true);
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(stateAtAbort, {
    activeAbortController: undefined,
    activeAssistantMessageId: undefined,
    busy: false,
    status: 'idle',
  });
  assert.equal(session.pendingToolConfirmation, undefined);
  assert.equal(session.error, undefined);
});

test('does not revive a newer in-memory interruption from an older persisted snapshot', () => {
  assert.equal(runtimeSnapshotIsNewer(
    '2026-07-21T00:00:02.000Z',
    '2026-07-21T00:00:01.000Z',
  ), true);
  assert.equal(runtimeSnapshotIsNewer(
    '2026-07-21T00:00:01.000Z',
    '2026-07-21T00:00:02.000Z',
  ), false);
});
