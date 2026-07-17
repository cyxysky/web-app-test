import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isEffectiveToolTraceFailure,
  isRecoveredTransientToolTrace,
  markRuntimeToolTraceRecovered,
  notifyRuntimeToolTrace,
  runtimeToolTraceId,
} from './runtime-tool-trace';

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

test('recovered transient traces are no longer effective failures', () => {
  const trace = { result: { ok: false } };
  assert.equal(isEffectiveToolTraceFailure(trace), true);

  markRuntimeToolTraceRecovered(trace);

  assert.equal(trace.result.ok, false);
  assert.equal(isRecoveredTransientToolTrace(trace), true);
  assert.equal(isEffectiveToolTraceFailure(trace), false);
});

test('both recovered and transient flags are required to suppress a failure', () => {
  assert.equal(isEffectiveToolTraceFailure({ result: { ok: false }, recovered: true }), true);
  assert.equal(isEffectiveToolTraceFailure({ result: { ok: false }, transient: true }), true);
  assert.equal(isEffectiveToolTraceFailure({ result: { ok: true } }), false);
});

test('a recovered trace is republished with the same id and updated outcome', async () => {
  const received: Array<{ id: string; recovered?: boolean; transient?: boolean }> = [];
  const trace: { id: string; result: { ok: boolean }; recovered?: boolean; transient?: boolean } = {
    id: 'trace-1',
    result: { ok: false },
  };
  const onTrace = (value: typeof trace) => {
    received.push({ id: value.id, recovered: value.recovered, transient: value.transient });
  };

  await notifyRuntimeToolTrace(onTrace, trace);
  markRuntimeToolTraceRecovered(trace);
  await notifyRuntimeToolTrace(onTrace, trace);

  assert.deepEqual(received, [
    { id: 'trace-1', recovered: undefined, transient: undefined },
    { id: 'trace-1', recovered: true, transient: true },
  ]);
});
