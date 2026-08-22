import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aiSdkEmptyStopRequiresRetry,
  aiSdkFinishMessage,
  aiSdkFinishState,
  aiSdkToolResultRequiresContinuation,
} from './ai-sdk-finish-state';

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

test('continues an incomplete stream after its final tool result completed', () => {
  assert.equal(aiSdkToolResultRequiresContinuation({
    finishReason: 'other',
    responseText: '',
    toolCallCount: 1,
    toolResultCount: 1,
  }), true);
  assert.deepEqual(aiSdkFinishState('other', { runtimeContinuationRequired: true }), {
    finishReason: 'other',
    retryRequest: false,
    terminatesTurn: false,
    status: 'passed',
  });
  assert.equal(aiSdkToolResultRequiresContinuation({
    finishReason: 'other',
    responseText: '正在并行分析链接。',
    toolCallCount: 1,
    toolResultCount: 1,
  }), true);
});

test('continues when a provider stops with reasoning only after a completed tool round', () => {
  assert.equal(aiSdkToolResultRequiresContinuation({
    finishReason: 'stop',
    responseText: '',
    toolCallCount: 1,
    toolResultCount: 1,
  }), true);
  assert.deepEqual(aiSdkFinishState('stop', { runtimeContinuationRequired: true }), {
    finishReason: 'stop',
    retryRequest: false,
    terminatesTurn: false,
    status: 'passed',
  });
});

test('accepts stop after a completed tool round only when visible final text exists', () => {
  assert.equal(aiSdkToolResultRequiresContinuation({
    finishReason: 'stop',
    responseText: '文档已经生成完成。',
    toolCallCount: 1,
    toolResultCount: 1,
  }), false);
});

test('retries a reasoning-only stop when no tool round can continue it', () => {
  assert.equal(aiSdkEmptyStopRequiresRetry({
    finishReason: 'stop',
    responseText: '',
    toolCallCount: 0,
  }), true);
  assert.equal(aiSdkEmptyStopRequiresRetry({
    finishReason: 'stop',
    responseText: '已完成。',
    toolCallCount: 0,
  }), false);
  assert.equal(aiSdkEmptyStopRequiresRetry({
    finishReason: 'stop',
    responseText: '',
    toolCallCount: 1,
  }), false);
});

test('does not continue other when a completed tool result is missing', () => {
  assert.equal(aiSdkToolResultRequiresContinuation({
    finishReason: 'other',
    responseText: '',
    toolCallCount: 1,
    toolResultCount: 0,
  }), false);
});

test('retries SDK error states instead of treating them as task completion', () => {
  assert.deepEqual(aiSdkFinishState('error'), {
    finishReason: 'error',
    retryRequest: true,
    terminatesTurn: false,
    status: 'failed',
  });
  assert.deepEqual(aiSdkFinishState('other'), {
    finishReason: 'other',
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
