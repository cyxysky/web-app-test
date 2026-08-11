import assert from 'node:assert/strict';
import test from 'node:test';
import { createLatestOnlyAsyncScheduler } from './latest-only-async-scheduler';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('keeps only the newest pending value while a publish is in flight', async () => {
  const first = deferred();
  const firstStarted = deferred();
  const latestStarted = deferred();
  const published: string[] = [];
  const scheduler = createLatestOnlyAsyncScheduler<string, string>({
    delayMs: () => 0,
    publish: async (_key, value) => {
      published.push(value);
      if (value === 'a') {
        firstStarted.resolve();
        await first.promise;
      } else {
        latestStarted.resolve();
      }
    },
  });

  scheduler.schedule('session', 'a');
  await firstStarted.promise;
  scheduler.schedule('session', 'b');
  scheduler.schedule('session', 'complete');
  assert.deepEqual(published, ['a']);

  first.resolve();
  await latestStarted.promise;
  assert.deepEqual(published, ['a', 'complete']);
});
