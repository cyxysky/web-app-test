/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  boundedIntervalMs,
  memoryPressure,
} = require('./process-memory-monitor');

test('uses a one-minute memory log interval by default and bounds overrides', () => {
  assert.equal(boundedIntervalMs(undefined), 60_000);
  assert.equal(boundedIntervalMs(1), 10_000);
  assert.equal(boundedIntervalMs(120_000), 120_000);
  assert.equal(boundedIntervalMs(10_000_000), 3_600_000);
});

test('classifies V8 heap pressure before the process reaches its limit', () => {
  assert.equal(memoryPressure(700, 1_000), 'normal');
  assert.equal(memoryPressure(750, 1_000), 'high');
  assert.equal(memoryPressure(900, 1_000), 'critical');
});
