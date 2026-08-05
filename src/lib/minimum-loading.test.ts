import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForMinimumLoading } from './minimum-loading';

test('waits only for the remaining minimum loading duration', async () => {
  const startedAt = Date.now() - 20;
  const beforeWait = Date.now();

  await waitForMinimumLoading(startedAt, 60);

  assert.ok(Date.now() - beforeWait >= 25);
});

test('resolves immediately after the minimum loading duration has elapsed', async () => {
  const beforeWait = Date.now();

  await waitForMinimumLoading(Date.now() - 100, 50);

  assert.ok(Date.now() - beforeWait < 500);
});
