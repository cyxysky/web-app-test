import http from 'node:http';
import type { Socket } from 'node:net';
import {
  acceptWebSocketUpgrade,
  consumeWebSocketFrames,
  encodeWebSocketControl,
  encodeWebSocketText,
  listenWebSocketServer,
} from '@/server/realtime/websocket-transport';

export type RefreshEntityType = 'browserChatSession';

export type RefreshWebSocketEvent = {
  type: 'refresh';
  entityType: RefreshEntityType;
  id: string;
  updatedAt: string;
  version: number;
  userId: string;
  deleted?: boolean;
  patch?: unknown;
};

type RefreshWebSocketInfo = {
  url: string;
  port: number;
};

type RefreshClient = {
  buffer: Buffer;
  socket: Socket;
  userId: string;
};

type RefreshWebSocketState = {
  clients: Set<RefreshClient>;
  heartbeat?: ReturnType<typeof setInterval>;
  pending: RefreshWebSocketEvent[];
  port?: number;
  publishQueues?: Map<string, Promise<void>>;
  relayPort?: number;
  server?: http.Server;
  serviceVersion: number;
  starting?: Promise<RefreshWebSocketInfo>;
  versions: Map<string, number>;
};

const REFRESH_STATE_VERSION = 2;
const REFRESH_RELAY_PATH = '/publish';
const REFRESH_SERVICE_NAME = 'webpilot-refresh-websocket';
const REFRESH_SERVICE_HEADER = 'x-webpilot-refresh-service';
const MAX_RELAY_BODY_BYTES = 8 * 1024 * 1024;

declare global {
  var __aiWebTestRefreshWebSocketState: RefreshWebSocketState | undefined;
}

function state() {
  const existing = globalThis.__aiWebTestRefreshWebSocketState;
  if (!existing || existing.serviceVersion !== REFRESH_STATE_VERSION) {
    if (existing) {
      if (existing.heartbeat) clearInterval(existing.heartbeat);
      for (const client of existing.clients || []) client.socket.destroy();
      existing.server?.close();
    }
    const initialized: RefreshWebSocketState = {
      clients: new Set<RefreshClient>(),
      pending: [],
      publishQueues: new Map<string, Promise<void>>(),
      serviceVersion: REFRESH_STATE_VERSION,
      versions: new Map<string, number>(),
    };
    globalThis.__aiWebTestRefreshWebSocketState = initialized;
    return initialized;
  }
  existing.publishQueues ||= new Map<string, Promise<void>>();
  return existing;
}

function refreshWebSocketPortStart() {
  const raw = Number(process.env.AI_REFRESH_WS_PORT || process.env.AI_WEB_TEST_REFRESH_WS_PORT || 17991);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 17991;
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

function broadcast(payload: unknown, userId?: string) {
  const current = state();
  for (const client of [...current.clients]) {
    if (userId && client.userId !== userId) continue;
    if (!sendToClient(client, payload)) current.clients.delete(client);
  }
}

function flushPendingRefreshEvents() {
  const current = state();
  if (!current.clients.size || !current.pending.length) return;
  const connectedUsers = new Set([...current.clients].map((client) => client.userId));
  const events = current.pending.filter((event) => connectedUsers.has(event.userId));
  current.pending = current.pending.filter((event) => !connectedUsers.has(event.userId));
  for (const event of events) broadcast(event, event.userId);
}

function enqueueRefreshEvent(event: RefreshWebSocketEvent) {
  const current = state();
  current.pending.push(event);
  if (current.pending.length > 500) current.pending = current.pending.slice(-500);
  flushPendingRefreshEvents();
}

function refreshEventFromUnknown(value: unknown): RefreshWebSocketEvent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<RefreshWebSocketEvent>;
  if (
    candidate.type !== 'refresh'
    || candidate.entityType !== 'browserChatSession'
    || typeof candidate.id !== 'string'
    || !candidate.id
    || typeof candidate.updatedAt !== 'string'
    || typeof candidate.version !== 'number'
    || !Number.isFinite(candidate.version)
    || typeof candidate.userId !== 'string'
    || !candidate.userId
  ) return undefined;
  return candidate as RefreshWebSocketEvent;
}

function readRequestBody(request: http.IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_RELAY_BODY_BYTES) {
        reject(new Error('Refresh relay payload is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function relayRefreshEvent(event: RefreshWebSocketEvent, port = refreshWebSocketPortStart()) {
  return new Promise<void>((resolve, reject) => {
    const body = JSON.stringify(event);
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: REFRESH_RELAY_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (response) => {
      response.resume();
      if (
        response.statusCode
        && response.statusCode >= 200
        && response.statusCode < 300
        && response.headers[REFRESH_SERVICE_HEADER] === REFRESH_SERVICE_NAME
      ) {
        resolve();
        return;
      }
      reject(new Error(`Refresh relay returned ${response.statusCode || 0}`));
    });
    request.setTimeout(3_000, () => {
      request.destroy(new Error('Refresh relay request timed out'));
    });
    request.once('error', reject);
    request.end(body);
  });
}

function discoverRefreshWebSocketServerAtPort(port: number) {
  return new Promise<RefreshWebSocketInfo | undefined>((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/' }, (response) => {
      response.resume();
      if (response.headers[REFRESH_SERVICE_HEADER] === REFRESH_SERVICE_NAME) {
        resolve({ port, url: `ws://127.0.0.1:${port}/refresh` });
        return;
      }
      resolve(undefined);
    });
    request.setTimeout(500, () => request.destroy());
    request.once('error', () => resolve(undefined));
  });
}

async function discoverRefreshWebSocketServer() {
  const firstPort = refreshWebSocketPortStart();
  const candidates = await Promise.all(
    Array.from({ length: 20 }, (_, index) => discoverRefreshWebSocketServerAtPort(firstPort + index)),
  );
  return candidates.find((candidate) => candidate !== undefined);
}

function removeClient(client: RefreshClient) {
  state().clients.delete(client);
  client.socket.destroy();
}

function handleClientData(client: RefreshClient, chunk: Buffer) {
  client.buffer = Buffer.from(consumeWebSocketFrames(client.buffer, chunk, {
    onClose: () => removeClient(client),
    onProtocolError: () => removeClient(client),
    onPing: (payload) => client.socket.write(encodeWebSocketControl(0xA, payload)),
  }));
}

function createRefreshServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (request.method === 'POST' && url.pathname === REFRESH_RELAY_PATH) {
      void readRequestBody(request).then((body) => {
        const event = refreshEventFromUnknown(JSON.parse(body));
        if (!event) {
          response.writeHead(400, {
            'Content-Type': 'application/json; charset=utf-8',
            [REFRESH_SERVICE_HEADER]: REFRESH_SERVICE_NAME,
          });
          response.end(JSON.stringify({ error: 'Invalid refresh event' }));
          return;
        }
        enqueueRefreshEvent(event);
        response.writeHead(202, {
          'Content-Type': 'application/json; charset=utf-8',
          [REFRESH_SERVICE_HEADER]: REFRESH_SERVICE_NAME,
        });
        response.end(JSON.stringify({ ok: true }));
      }).catch((error) => {
        response.writeHead(400, {
          'Content-Type': 'application/json; charset=utf-8',
          [REFRESH_SERVICE_HEADER]: REFRESH_SERVICE_NAME,
        });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Invalid refresh event' }));
      });
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      [REFRESH_SERVICE_HEADER]: REFRESH_SERVICE_NAME,
    });
    response.end(JSON.stringify({ ok: true, service: REFRESH_SERVICE_NAME }));
  });

  server.on('upgrade', (request, socket) => {
    const netSocket = socket as Socket;
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname !== '/refresh') {
      netSocket.destroy();
      return;
    }
    const userId = (url.searchParams.get('userId') || url.searchParams.get('qzUserId') || '').trim() || '0';
    if (!acceptWebSocketUpgrade(request, netSocket)) {
      netSocket.destroy();
      return;
    }

    const client: RefreshClient = { buffer: Buffer.alloc(0), socket: netSocket, userId };
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
  if (current.relayPort) {
    return { port: current.relayPort, url: `ws://127.0.0.1:${current.relayPort}/refresh` };
  }
  if (current.starting) return current.starting;

  current.starting = (async () => {
    const requestedPort = refreshWebSocketPortStart();
    const existing = await discoverRefreshWebSocketServer();
    if (existing) {
      current.relayPort = existing.port;
      return existing;
    }
    const server = createRefreshServer();
    const port = await listenWebSocketServer(server, requestedPort, {
      host: '127.0.0.1',
      nextPortOnAddressInUse: true,
    });
    current.server = server;
    current.port = port;
    current.relayPort = port;
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

export function publishBrowserChatRefreshEvent(input: {
  deleted?: boolean;
  entityType: RefreshEntityType;
  id: string;
  patch?: unknown;
  updatedAt?: string;
  userId: string;
}) {
  if (!input.id) return Promise.resolve();
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
    userId: input.userId,
    ...(input.deleted ? { deleted: true } : {}),
    ...(input.patch === undefined ? {} : { patch: input.patch }),
  };
  const publishQueues = current.publishQueues || (current.publishQueues = new Map<string, Promise<void>>());
  const previous = publishQueues.get(key) || Promise.resolve();
  const delivery = previous.catch(() => undefined).then(async () => {
    try {
      let info = await ensureRefreshWebSocketServer();
      try {
        await relayRefreshEvent(event, info.port);
      } catch {
        const retryState = state();
        if (!retryState.server) retryState.relayPort = undefined;
        info = await ensureRefreshWebSocketServer();
        await relayRefreshEvent(event, info.port);
      }
    } catch (error) {
      console.warn('[realtime] Failed to publish refresh WebSocket event.', error);
      throw error;
    }
  });
  publishQueues.set(key, delivery);
  void delivery.finally(() => {
    if (publishQueues.get(key) === delivery) publishQueues.delete(key);
  });
  return delivery;
}
