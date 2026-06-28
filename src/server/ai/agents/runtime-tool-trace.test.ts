import assert from 'node:assert/strict';
import test from 'node:test';
import { notifyRuntimeToolTrace, runtimeToolTraceId } from './runtime-tool-trace';

test('runtimeToolTraceId is stable for supplied timestamp', () => {
  assert.equal(runtimeToolTraceId({
    runId: 'run-1',
    stepIndex: 2,
    traceIndex: 3,
    timestamp: 36,
  }), 'run-1:2:3:10');
});

test('notifyRuntimeToolTrace swallows progress callback errors', async () => {
  await assert.doesNotReject(() => notifyRuntimeToolTrace(async () => {
    throw new Error('persistence failed');
  }, { id: 'trace-1' }));
});
