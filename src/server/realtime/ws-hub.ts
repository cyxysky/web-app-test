import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Duplex } from 'node:stream';

export type RealtimeWsEvent = {
  entityType: string;
  id: string;
  event: 'snapshot' | 'refresh' | 'deleted';
  reason?: string;
  time: string;
  version?: number;
};

type RealtimeClient = {
  socket: Duplex;
  topics: Set<string>;
};

type RealtimeHubState = {
  clients: Set<RealtimeClient>;
  host: string;
  port?: number;
  server?: Server;
  starting?: Promise<void>;
};

declare global {
  // eslint-disable-next-line no-var
  var __aiWebTestRealtimeWsHub: RealtimeHubState | undefined;
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function hubState() {
  if (!globalThis.__aiWebTestRealtimeWsHub) {
    globalThis.__aiWebTestRealtimeWsHub = {
      clients: new Set<RealtimeClient>(),
      host: process.env.REALTIME_WS_HOST || '127.0.0.1',
    };
  }
  return globalThis.__aiWebTestRealtimeWsHub;
}

function configuredPort() {
  const value = Number(process.env.REALTIME_WS_PORT || 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function parseTopics(url?: string) {
  const parsed = new URL(url || '/', 'http://localhost');
  return new Set(
    (parsed.searchParams.get('topics') || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function acceptKey(key: string) {
  return createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
}

function sendFrame(socket: Duplex, text: string) {
  if (socket.destroyed || !socket.writable) return;
  const payload = Buffer.from(text);
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function sendClose(socket: Duplex) {
  if (socket.destroyed || !socket.writable) return;
  socket.write(Buffer.from([0x88, 0]));
  socket.end();
}

function handleClientFrame(client: RealtimeClient, chunk: Buffer) {
  if (chunk.length < 2) return;
  const opcode = chunk[0] & 0x0f;
  if (opcode === 0x8) {
    sendClose(client.socket);
    return;
  }
  if (opcode === 0x9) {
    client.socket.write(Buffer.from([0x8a, 0]));
  }
}

function addClient(socket: Duplex, topics: Set<string>) {
  const state = hubState();
  const client = { socket, topics };
  state.clients.add(client);
  socket.on('data', (chunk: Buffer) => handleClientFrame(client, chunk));
  socket.on('close', () => state.clients.delete(client));
  socket.on('error', () => state.clients.delete(client));
  sendFrame(socket, JSON.stringify({
    entityType: 'realtime',
    id: 'connection',
    event: 'refresh',
    reason: 'connected',
    time: new Date().toISOString(),
  } satisfies RealtimeWsEvent));
}

export async function ensureRealtimeWebSocketServer() {
  const state = hubState();
  if (state.server && state.port) return state;
  if (state.starting) {
    await state.starting;
    return state;
  }

  state.server = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });

  state.server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key'];
    if (!key || Array.isArray(key)) {
      socket.destroy();
      return;
    }
    const topics = parseTopics(request.url);
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '',
      '',
    ].join('\r\n'));
    addClient(socket, topics);
  });

  state.starting = new Promise<void>((resolve, reject) => {
    state.server!.once('error', reject);
    state.server!.listen(configuredPort(), state.host, () => {
      const address = state.server!.address();
      state.port = typeof address === 'object' && address ? address.port : configuredPort();
      state.server!.off('error', reject);
      resolve();
    });
  }).finally(() => {
    state.starting = undefined;
  });

  await state.starting;
  return state;
}

function eventTopics(event: RealtimeWsEvent) {
  const topics = new Set(['*', `${event.entityType}:*`, `${event.entityType}:${event.id}`]);
  if (event.entityType === 'run' || event.entityType === 'testCase' || event.entityType === 'group' || event.entityType === 'schedule') {
    topics.add('dashboard');
  }
  return topics;
}

export function publishRealtimeEvent(event: Omit<RealtimeWsEvent, 'time'> & { time?: string }) {
  const payload: RealtimeWsEvent = {
    ...event,
    time: event.time || new Date().toISOString(),
  };
  void ensureRealtimeWebSocketServer().then((state) => {
    const topics = eventTopics(payload);
    const text = JSON.stringify(payload);
    for (const client of [...state.clients]) {
      if (![...topics].some((topic) => client.topics.has(topic))) continue;
      sendFrame(client.socket, text);
    }
  }).catch(() => undefined);
}

export async function realtimeWebSocketUrl(request: Request, topics: string[]) {
  const state = await ensureRealtimeWebSocketServer();
  const requestUrl = new URL(request.url);
  const hostname = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(requestUrl.hostname)
    ? requestUrl.hostname.replace(/^\[|\]$/g, '')
    : state.host;
  const url = new URL(`ws://${hostname}:${state.port || configuredPort()}/`);
  url.searchParams.set('topics', Array.from(new Set(topics.filter(Boolean))).join(','));
  return url.toString();
}
