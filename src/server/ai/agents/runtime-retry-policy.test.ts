import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyRuntimeRetry,
  parseRetryAfterMs,
  runtimeExecutionIdentity,
  runtimeRetryDelayMs,
  waitForRuntimeRetry,
} from './runtime-retry-policy';

test('runtime retry only accepts transient provider and network failures', () => {
  assert.equal(classifyRuntimeRetry({ statusCode: 429, responseHeaders: { 'retry-after': '2' } }).retryable, true);
  assert.equal(classifyRuntimeRetry({ status: 503 }).retryable, true);
  assert.equal(classifyRuntimeRetry(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })).retryable, true);
  assert.deepEqual(classifyRuntimeRetry(new Error('Cannot connect to API: other side closed')), {
    category: 'network',
    reason: 'temporary network failure',
    retryAfterMs: undefined,
    retryable: true,
    statusCode: undefined,
  });
  assert.deepEqual(
    classifyRuntimeRetry(Object.assign(
      new Error('Cannot connect to API: Connect Timeout Error (attempted address: api.deepseek.com:443, timeout: 10000ms)'),
      { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) },
    )),
    {
      category: 'request-timeout',
      reason: 'temporary request timeout',
      retryAfterMs: undefined,
      retryable: true,
      statusCode: undefined,
    },
  );
  assert.equal(classifyRuntimeRetry({ status: 401, message: 'invalid api key' }).retryable, false);
  assert.equal(classifyRuntimeRetry({ status: 400, message: 'invalid tool schema' }).retryable, false);
  assert.equal(classifyRuntimeRetry(new Error('locator.click failed')).retryable, false);
});

test('runtime retry accepts SDK error and other finish states', () => {
  assert.equal(classifyRuntimeRetry(new Error('AI SDK returned retryable finish reason "error".')).retryable, true);
  assert.equal(classifyRuntimeRetry(new Error('AI SDK returned retryable finish reason "other".')).retryable, true);
});

test('runtime retry honors Retry-After before exponential jitter', () => {
  const decision = classifyRuntimeRetry({ status: 429, headers: { 'retry-after': '1.5' } });
  assert.equal(decision.retryAfterMs, 1500);
  assert.equal(runtimeRetryDelayMs(3, decision, () => 0), 1500);
  assert.equal(parseRetryAfterMs('2'), 2000);
  assert.equal(runtimeRetryDelayMs(1, { category: 'network', reason: 'network', retryable: true }, () => 0.5), 500);
  assert.equal(runtimeRetryDelayMs(2, { category: 'network', reason: 'network', retryable: true }, () => 0.5), 1000);
});

test('runtime execution ids are stable and retry waiting is abortable', async () => {
  assert.deepEqual(runtimeExecutionIdentity('msg_1', 7, 2), {
    turnId: 'msg_1',
    attemptNumber: 2,
    attemptId: 'msg_1:step:7:attempt:2',
  });
  const controller = new AbortController();
  const waiting = waitForRuntimeRetry(10_000, controller.signal);
  controller.abort(new Error('stopped'));
  await assert.rejects(waiting, /stopped/);
});
