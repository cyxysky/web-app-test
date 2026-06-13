import { createHash } from 'node:crypto';
import http from 'node:http';
import type { Socket } from 'node:net';

export type RefreshEntityType = 'run' | 'browserChatSession';

export type RefreshWebSocketEvent = {
  type: 'refresh';
  entityType: RefreshEntityType;
  id: string;
  updatedAt: string;
  version: number;
  deleted?: boolean;
};

type RefreshWebSocketInfo = {
  url: string;
  port: number;
};

type RefreshClient = {
  buffer: Buffer;
  socket: Socket;
};

type RefreshWebSocketState = {
  clients: Set<RefreshClient>;
  heartbeat?: ReturnType<typeof setInterval>;
  pending: RefreshWebSocketEvent[];
  port?: number;
  server?: http.Server;
  starting?: Promise<RefreshWebSocketInfo>;
  versions: Map<string, number>;
};

declare global {
  // eslint-disable-next-line no-var
  var __aiWebTestRefreshWebSocketState: RefreshWebSocketState | undefined;
}

function state() {
  if (!globalThis.__aiWebTestRefreshWebSocketState) {
    globalThis.__aiWebTestRefreshWebSocketState = {
      clients: new Set<RefreshClient>(),
      pending: [],
      versions: new Map<string, number>(),
    };
  }
  return globalThis.__aiWebTestRefreshWebSocketState;
}

function refreshWebSocketPortStart() {
  const raw = Number(process.env.AI_REFRESH_WS_PORT || process.env.AI_WEB_TEST_REFRESH_WS_PORT || 17991);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 17991;
}

function websocketAcceptKey(key: string) {
  return createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
}

function encodeWebSocketText(payload: string) {
  const data = Buffer.from(payload);
  if (data.length < 126) return Buffer.concat([Buffer.from([0x81, data.length]), data]);
  if (data.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
    return Buffer.concat([header, data]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(data.length), 2);
  return Buffer.concat([header, data]);
}

function encodeControlFrame(opcode: number, payload = Buffer.alloc(0)) {
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}

function sendToClient(client: RefreshClient, payload: unknown) {
  if (client.socket.destroyed) return false;
  try {
    client.socket.write(encodeWebSocketText(JSON.stringify(payload)));
    return true;
  } catch {
    client.socket.destroy();
    return false;
  }
}

function broadcast(payload: unknown) {
  const current = state();
  for (const client of [...current.clients]) {
    if (!sendToClient(client, payload)) current.clients.delete(client);
  }
}

function flushPendingRefreshEvents() {
  const current = state();
  if (!current.clients.size || !current.pending.length) return;
  const events = current.pending.splice(0);
  for (const event of events) broadcast(event);
}

function removeClient(client: RefreshClient) {
  state().clients.delete(client);
  client.socket.destroy();
}

function handleClientData(client: RefreshClient, chunk: Buffer) {
  client.buffer = Buffer.concat([client.buffer, chunk]);
  while (client.buffer.length >= 2) {
    const first = client.buffer[0];
    const second = client.buffer[1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (client.buffer.length < offset + 2) return;
      length = client.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (client.buffer.length < offset + 8) return;
      const bigLength = client.buffer.readBigUInt64BE(offset);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        removeClient(client);
        return;
      }
      length = Number(bigLength);
      offset += 8;
    }
    const maskOffset = offset;
    if (masked) offset += 4;
    if (client.buffer.length < offset + length) return;
    const payload = client.buffer.subarray(offset, offset + length);
    const unmasked = masked
      ? Buffer.from(payload.map((byte, index) => byte ^ client.buffer[maskOffset + (index % 4)]))
      : Buffer.from(payload);
    client.buffer = client.buffer.subarray(offset + length);

    if (opcode === 0x8) {
      removeClient(client);
      return;
    }
    if (opcode === 0x9) {
      client.socket.write(encodeControlFrame(0xA, unmasked.subarray(0, 125)));
    }
  }
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    const onListening = () => {
      cleanup();
      resolve(port);
    };
    const onError = (error: NodeJS.ErrnoException) => {
      cleanup();
      if (error.code === 'EADDRINUSE') {
        listen(server, port + 1).then(resolve, reject);
        return;
      }
      reject(error);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

function createRefreshServer() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: true }));
  });

  server.on('upgrade', (request, socket) => {
    const netSocket = socket as Socket;
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname !== '/refresh') {
      netSocket.destroy();
      return;
    }
    const key = String(request.headers['sec-websocket-key'] || '');
    if (!key) {
      netSocket.destroy();
      return;
    }
    netSocket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${websocketAcceptKey(key)}`,
      '',
      '',
    ].join('\r\n'));

    const client: RefreshClient = { buffer: Buffer.alloc(0), socket: netSocket };
    state().clients.add(client);
    netSocket.setNoDelay(true);
    netSocket.on('data', (chunk) => handleClientData(client, chunk));
    netSocket.on('close', () => state().clients.delete(client));
    netSocket.on('error', () => removeClient(client));
    sendToClient(client, { type: 'hello', connectedAt: new Date().toISOString() });
    flushPendingRefreshEvents();
  });

  return server;
}

export async function ensureRefreshWebSocketServer(): Promise<RefreshWebSocketInfo> {
  const current = state();
  if (current.server && current.port) {
    return { port: current.port, url: `ws://127.0.0.1:${current.port}/refresh` };
  }
  if (current.starting) return current.starting;

  current.starting = (async () => {
    const server = createRefreshServer();
    const port = await listen(server, refreshWebSocketPortStart());
    current.server = server;
    current.port = port;
    current.heartbeat = setInterval(() => {
      broadcast({ type: 'heartbeat', time: new Date().toISOString() });
    }, 25_000);
    current.heartbeat.unref?.();
    flushPendingRefreshEvents();
    return { port, url: `ws://127.0.0.1:${port}/refresh` };
  })().finally(() => {
    current.starting = undefined;
  });

  return current.starting;
}

export function publishRefreshEvent(input: {
  deleted?: boolean;
  entityType: RefreshEntityType;
  id: string;
  updatedAt?: string;
}) {
  if (!input.id) return;
  const current = state();
  const key = `${input.entityType}:${input.id}`;
  const version = Math.max((current.versions.get(key) || 0) + 1, Date.now());
  current.versions.set(key, version);
  const event: RefreshWebSocketEvent = {
    type: 'refresh',
    entityType: input.entityType,
    id: input.id,
    updatedAt: input.updatedAt || new Date().toISOString(),
    version,
    ...(input.deleted ? { deleted: true } : {}),
  };
  current.pending.push(event);
  if (current.pending.length > 500) current.pending = current.pending.slice(-500);
  if (current.server && current.port) {
    flushPendingRefreshEvents();
    return;
  }
  void ensureRefreshWebSocketServer().catch((error) => {
    console.warn('[realtime] Failed to start refresh WebSocket server.', error);
  });
}
