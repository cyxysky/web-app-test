import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import test from 'node:test';
import { publishRealtimeRefreshEvent } from './ws-refresh';

test('failed realtime publish cleanup does not leak an unhandled rejection', async () => {
  const blocker = createServer((socket) => socket.destroy());
  blocker.listen(0, '127.0.0.1');
  await once(blocker, 'listening');
  const address = blocker.address();
  assert.ok(address && typeof address === 'object');

  const previousPort = process.env.PORT;
  const previousToken = process.env.WEBPILOT_REALTIME_PUBLISH_TOKEN;
  const previousWarn = console.warn;
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
  process.env.PORT = String(address.port);
  process.env.WEBPILOT_REALTIME_PUBLISH_TOKEN = 'realtime-test-token';
  console.warn = () => undefined;
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    await assert.rejects(publishRealtimeRefreshEvent({
      entityType: 'browserChatSession',
      id: 'session-unhandled-rejection-test',
      updatedAt: '2026-08-10T00:00:00.000Z',
      userId: 'user-1',
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
    console.warn = previousWarn;
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    if (previousToken === undefined) delete process.env.WEBPILOT_REALTIME_PUBLISH_TOKEN;
    else process.env.WEBPILOT_REALTIME_PUBLISH_TOKEN = previousToken;
    blocker.close();
    await once(blocker, 'close');
  }
});
