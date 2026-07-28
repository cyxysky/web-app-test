import assert from 'node:assert/strict';
import test from 'node:test';
import { aiSdkFinishMessage, aiSdkFinishState } from './ai-sdk-finish-state';

test('treats stop as a normally completed AI response', () => {
  assert.deepEqual(aiSdkFinishState('stop'), {
    finishReason: 'stop',
    terminatesTurn: true,
    status: 'passed',
  });
});

test('keeps tool-calls inside the tool loop', () => {
  assert.deepEqual(aiSdkFinishState('tool-calls'), {
    finishReason: 'tool-calls',
    terminatesTurn: false,
    status: 'passed',
  });
});

test('keeps a Codex object response running when its generated object executed a tool', () => {
  assert.deepEqual(aiSdkFinishState('stop', { runtimeContinuationRequired: true }), {
    finishReason: 'stop',
    terminatesTurn: false,
    status: 'passed',
  });
});

test('terminates without retrying for all SDK terminal failure reasons', () => {
  assert.deepEqual(aiSdkFinishState('length'), {
    finishReason: 'length',
    terminatesTurn: true,
    status: 'failed',
  });
  assert.deepEqual(aiSdkFinishState('content-filter'), {
    finishReason: 'content-filter',
    terminatesTurn: true,
    status: 'blocked',
  });
  assert.deepEqual(aiSdkFinishState('error'), {
    finishReason: 'error',
    terminatesTurn: true,
    status: 'failed',
  });
  assert.deepEqual(aiSdkFinishState('other'), {
    finishReason: 'other',
    terminatesTurn: true,
    status: 'failed',
  });
});

test('treats a future nonempty SDK finish reason as terminal', () => {
  assert.deepEqual(aiSdkFinishState('provider-finished'), {
    finishReason: 'provider-finished',
    terminatesTurn: true,
    status: 'failed',
  });
});

test('does not invent a terminal state when the SDK returned no finish reason', () => {
  assert.deepEqual(aiSdkFinishState(undefined), {
    finishReason: undefined,
    terminatesTurn: false,
    status: 'passed',
  });
});

test('provides a user-facing explanation for terminal states without text', () => {
  assert.match(aiSdkFinishMessage('length'), /长度限制/);
  assert.match(aiSdkFinishMessage('content-filter'), /内容过滤器/);
  assert.match(aiSdkFinishMessage('stop'), /正常结束/);
});
