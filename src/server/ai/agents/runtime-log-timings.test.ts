import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeRuntimeLogTimings } from './runtime-log-timings';

test('summarizeRuntimeLogTimings separates AI request and tool time', () => {
  const timings = summarizeRuntimeLogTimings({
    stepStartedAt: 1000,
    totalElapsedMs: 1000,
    traces: [
      {
        name: 'openPage',
        startedAt: 1200,
        completedAt: 1500,
        actionElapsedMs: 260,
        postprocessTimings: {
          desktopBeforeMs: 12,
          desktopAfterMs: 20,
          notifyStartMs: 2,
        },
      },
    ],
  });

  assert.equal(timings.aiRequestElapsedMs, 200);
  assert.equal(timings.toolElapsedMs, 260);
  assert.equal(timings.toolOverheadElapsedMs, 40);
  assert.equal(timings.otherElapsedMs, 500);
  assert.equal(timings.toolCount, 1);
  assert.equal(timings.tools[0]?.name, 'openPage');
  assert.equal(timings.tools[0]?.traceElapsedMs, 300);
  assert.equal(timings.tools[0]?.overheadElapsedMs, 40);
  assert.deepEqual(timings.tools[0]?.postprocessTimings, {
    desktopBeforeMs: 12,
    desktopAfterMs: 20,
    notifyStartMs: 2,
  });
});

test('summarizeRuntimeLogTimings prefers explicit AI elapsed time', () => {
  const timings = summarizeRuntimeLogTimings({
    aiElapsedMs: 390,
    totalElapsedMs: 900,
    traces: [{ name: 'mouse', elapsedMs: 120 }],
  });

  assert.equal(timings.aiRequestElapsedMs, 390);
  assert.equal(timings.toolElapsedMs, 120);
  assert.equal(timings.toolOverheadElapsedMs, 0);
  assert.equal(timings.otherElapsedMs, 390);
});
