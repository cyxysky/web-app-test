import assert from 'node:assert/strict';
import test from 'node:test';

type SocketHandler = ((event?: { data?: string }) => void) | null;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onclose: SocketHandler = null;
  onerror: SocketHandler = null;
  onmessage: SocketHandler = null;
  onopen: SocketHandler = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Timed out waiting for realtime test state.');
}

test('realtime refresh requests authoritative resync after reconnect', async () => {
  const previousWindow = globalThis.window;
  const previousWebSocket = globalThis.WebSocket;
  const previousFetch = globalThis.fetch;
  Object.assign(globalThis, {
    window: {
      clearTimeout,
      setTimeout: (callback: TimerHandler) => setTimeout(callback, 0),
    },
    WebSocket: FakeWebSocket,
    fetch: async () => new Response(JSON.stringify({ url: 'ws://127.0.0.1/refresh' }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    }),
  });

  try {
    const { subscribeRealtimeRefresh } = await import('./realtime-refresh');
    let resyncs = 0;
    const unsubscribe = subscribeRealtimeRefresh(() => undefined, {
      onResync: () => { resyncs += 1; },
    });

    await waitFor(() => FakeWebSocket.instances.length === 1);
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].message({ type: 'hello' });
    assert.equal(resyncs, 0);

    FakeWebSocket.instances[0].close();
    await waitFor(() => FakeWebSocket.instances.length === 2);
    FakeWebSocket.instances[1].open();
    FakeWebSocket.instances[1].message({ type: 'hello' });
    await waitFor(() => resyncs === 1);
    assert.equal(resyncs, 1);
    unsubscribe();
  } finally {
    Object.assign(globalThis, {
      window: previousWindow,
      WebSocket: previousWebSocket,
      fetch: previousFetch,
    });
  }
});
