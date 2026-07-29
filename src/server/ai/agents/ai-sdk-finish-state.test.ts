import assert from 'node:assert/strict';
import test from 'node:test';
import { aiSdkFinishMessage, aiSdkFinishState } from './ai-sdk-finish-state';

test('treats stop as a normally completed AI response', () => {
  assert.deepEqual(aiSdkFinishState('stop'), {
    finishReason: 'stop',
    retryRequest: false,
    terminatesTurn: true,
    status: 'passed',
  });
});

test('reads AI SDK 6 structured finish reasons', () => {
  assert.deepEqual(aiSdkFinishState({ unified: 'stop', raw: 'stop' }), {
    finishReason: 'stop',
    retryRequest: false,
    terminatesTurn: true,
    status: 'passed',
  });
  assert.deepEqual(aiSdkFinishState({ unified: 'tool-calls', raw: 'tool_calls' }), {
    finishReason: 'tool-calls',
    retryRequest: false,
    terminatesTurn: false,
    status: 'passed',
  });
  assert.deepEqual(aiSdkFinishState({ unified: 'error', raw: 'provider_error' }), {
    finishReason: 'error',
    retryRequest: true,
    terminatesTurn: false,
    status: 'failed',
  });
  assert.deepEqual(aiSdkFinishState({ unified: 'content-filter', raw: 'safety' }), {
    finishReason: 'content-filter',
    retryRequest: false,
    terminatesTurn: true,
    status: 'blocked',
  });
});

test('uses a structured raw finish reason only when unified is absent', () => {
  assert.equal(aiSdkFinishState({ raw: 'stop' }).terminatesTurn, true);
  assert.equal(aiSdkFinishState({ unified: '', raw: 'tool-calls' }).terminatesTurn, false);
});

test('keeps tool-calls inside the tool loop', () => {
  assert.deepEqual(aiSdkFinishState('tool-calls'), {
    finishReason: 'tool-calls',
    retryRequest: false,
    terminatesTurn: false,
    status: 'passed',
  });
});

test('keeps a Codex object response running when its generated object executed a tool', () => {
  assert.deepEqual(aiSdkFinishState('stop', { runtimeContinuationRequired: true }), {
    finishReason: 'stop',
    retryRequest: false,
    terminatesTurn: false,
    status: 'passed',
  });
  assert.deepEqual(aiSdkFinishState('error', { runtimeContinuationRequired: true }), {
    finishReason: 'error',
    retryRequest: false,
    terminatesTurn: false,
    status: 'passed',
  });
});

test('retries an SDK error finish reason instead of treating it as task completion', () => {
  assert.deepEqual(aiSdkFinishState('error'), {
    finishReason: 'error',
    retryRequest: true,
    terminatesTurn: false,
    status: 'failed',
  });
});

test('terminates without retrying for deterministic SDK terminal reasons', () => {
  assert.deepEqual(aiSdkFinishState('length'), {
    finishReason: 'length',
    retryRequest: false,
    terminatesTurn: true,
    status: 'failed',
  });
  assert.deepEqual(aiSdkFinishState('content-filter'), {
    finishReason: 'content-filter',
    retryRequest: false,
    terminatesTurn: true,
    status: 'blocked',
  });
  assert.deepEqual(aiSdkFinishState('other'), {
    finishReason: 'other',
    retryRequest: false,
    terminatesTurn: true,
    status: 'failed',
  });
});

test('treats a future nonempty SDK finish reason as terminal', () => {
  assert.deepEqual(aiSdkFinishState('provider-finished'), {
    finishReason: 'provider-finished',
    retryRequest: false,
    terminatesTurn: true,
    status: 'failed',
  });
});

test('does not invent a terminal state when the SDK returned no finish reason', () => {
  assert.deepEqual(aiSdkFinishState(undefined), {
    finishReason: undefined,
    retryRequest: false,
    terminatesTurn: false,
    status: 'passed',
  });
});

test('provides a user-facing explanation for terminal states without text', () => {
  assert.match(aiSdkFinishMessage('length'), /长度限制/);
  assert.match(aiSdkFinishMessage('content-filter'), /内容过滤器/);
  assert.match(aiSdkFinishMessage('stop'), /正常结束/);
});
