import { createHash } from 'node:crypto';
import http from 'node:http';
import type { Socket } from 'node:net';
import { dispatchBrowserChatPreviewInput, startBrowserChatScreencast } from '@/server/ai/agents/browser-chat.service';
import type { BrowserLiveInput } from '@/server/browser/browser-session';

type BrowserPreviewWebSocketInfo = {
  port: number;
  url: string;
};

type BrowserPreviewClient = {
  actionChain: Promise<void>;
  attachGeneration: number;
  buffer: Buffer;
  frameBlocked: boolean;
  pendingFrame?: unknown;
  pendingMove?: Extract<BrowserLiveInput, { kind: 'move' }>;
  reattachTimer?: ReturnType<typeof setTimeout>;
  moveActive: boolean;
  sessionId: string;
  socket: Socket;
  stop?: () => Promise<void>;
  userId: string;
};

type BrowserPreviewWebSocketState = {
  clients: Set<BrowserPreviewClient>;
  heartbeat?: ReturnType<typeof setInterval>;
  implementationVersion?: number;
  port?: number;
  server?: http.Server;
  starting?: Promise<BrowserPreviewWebSocketInfo>;
};

const BROWSER_PREVIEW_IMPLEMENTATION_VERSION = 6;

declare global {
  var __browserChatPreviewWebSocketState: BrowserPreviewWebSocketState | undefined;
}

function state() {
  if (!globalThis.__browserChatPreviewWebSocketState) {
    globalThis.__browserChatPreviewWebSocketState = {
      clients: new Set<BrowserPreviewClient>(),
    };
  }
  return globalThis.__browserChatPreviewWebSocketState;
}

function previewWebSocketPortStart() {
  const raw = Number(process.env.BROWSER_CHAT_PREVIEW_WS_PORT || 18021);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 18021;
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

function sendToClient(client: BrowserPreviewClient, payload: unknown) {
  if (client.socket.destroyed) return false;
  try {
    return client.socket.write(encodeWebSocketText(JSON.stringify(payload)));
  } catch {
    void removeClient(client);
    return false;
  }
}

async function removeClient(client: BrowserPreviewClient) {
  state().clients.delete(client);
  client.attachGeneration += 1;
  client.pendingFrame = undefined;
  client.pendingMove = undefined;
  if (client.reattachTimer) clearTimeout(client.reattachTimer);
  client.reattachTimer = undefined;
  const stop = client.stop;
  client.stop = undefined;
  await stop?.().catch(() => undefined);
  client.socket.destroy();
}

function flushPendingFrame(client: BrowserPreviewClient) {
  client.frameBlocked = false;
  const frame = client.pendingFrame;
  client.pendingFrame = undefined;
  if (frame !== undefined) sendFrameToClient(client, frame);
}

function sendFrameToClient(client: BrowserPreviewClient, payload: unknown) {
  if (client.frameBlocked) {
    client.pendingFrame = payload;
    return;
  }
  if (sendToClient(client, payload)) return;
  client.frameBlocked = true;
  client.pendingFrame = undefined;
  client.socket.once('drain', () => flushPendingFrame(client));
}

function readLiveInput(value: unknown): BrowserLiveInput | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  if (input.kind === 'move') {
    return { kind: 'move', xRatio: Number(input.xRatio), yRatio: Number(input.yRatio) };
  }
  if (input.kind === 'click') {
    return {
      kind: 'click',
      xRatio: Number(input.xRatio),
      yRatio: Number(input.yRatio),
      button: input.button === 'right' || input.button === 'middle' ? input.button : 'left',
      clickCount: Number(input.clickCount),
    };
  }
  if (input.kind === 'scroll') {
    return {
      kind: 'scroll',
      xRatio: Number(input.xRatio),
      yRatio: Number(input.yRatio),
      deltaX: Number(input.deltaX),
      deltaY: Number(input.deltaY),
    };
  }
  if (input.kind === 'key' && typeof input.key === 'string') return { kind: 'key', key: input.key };
  if (input.kind === 'text' && typeof input.text === 'string') return { kind: 'text', text: input.text };
  return undefined;
}

async function dispatchLatestMove(client: BrowserPreviewClient) {
  if (client.moveActive) return;
  client.moveActive = true;
  try {
    while (client.pendingMove && !client.socket.destroyed) {
      const input = client.pendingMove;
      client.pendingMove = undefined;
      const result = await dispatchBrowserChatPreviewInput(client.sessionId, client.userId, input);
      if (result?.ok === false) sendToClient(client, { type: 'inputError', error: result.actual });
    }
  } catch (error) {
    sendToClient(client, {
      type: 'inputError',
      error: error instanceof Error ? error.message : 'Live browser input failed',
    });
  } finally {
    client.moveActive = false;
    if (client.pendingMove && !client.socket.destroyed) void dispatchLatestMove(client);
  }
}

function handleClientMessage(client: BrowserPreviewClient, text: string) {
  let message: { event?: unknown; requestId?: unknown; type?: unknown };
  try {
    message = JSON.parse(text) as typeof message;
  } catch {
    sendToClient(client, { type: 'inputError', error: 'Invalid browser preview message' });
    return;
  }
  if (message.type !== 'input') return;
  const input = readLiveInput(message.event);
  if (!input) {
    sendToClient(client, { type: 'inputError', error: 'Invalid live browser input' });
    return;
  }
  if (input.kind === 'move') {
    client.pendingMove = input;
    void dispatchLatestMove(client);
    return;
  }

  client.pendingMove = undefined;
  const requestId = typeof message.requestId === 'string' ? message.requestId : undefined;
  client.actionChain = client.actionChain.then(async () => {
    try {
      const result = await dispatchBrowserChatPreviewInput(client.sessionId, client.userId, input);
      if (!result || result.ok === false) {
        sendToClient(client, {
          type: 'inputError',
          requestId,
          error: result?.actual || 'Browser chat session not found',
        });
      }
    } catch (error) {
      sendToClient(client, {
        type: 'inputError',
        requestId,
        error: error instanceof Error ? error.message : 'Live browser input failed',
      });
    }
  });
}

function handleClientData(client: BrowserPreviewClient, chunk: Buffer) {
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
        void removeClient(client);
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
      void removeClient(client);
      return;
    }
    if (opcode === 0x9) {
      client.socket.write(encodeControlFrame(0xA, unmasked.subarray(0, 125)));
      continue;
    }
    if (opcode === 0x1) handleClientMessage(client, unmasked.toString('utf8'));
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
        reject(new Error(`Browser preview WebSocket port ${port} is already in use. Set BROWSER_CHAT_PREVIEW_WS_PORT to the fixed port forwarded by Nginx.`));
        return;
      }
      reject(error);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '0.0.0.0');
  });
}

async function attachScreencast(client: BrowserPreviewClient) {
  const { sessionId, userId } = client;
  if (!sessionId) {
    sendToClient(client, { type: 'error', error: 'Missing browser chat sessionId' });
    await removeClient(client);
    return;
  }
  const generation = ++client.attachGeneration;
  try {
    const handle = await startBrowserChatScreencast(sessionId, userId, {
      onActivePageChanged: () => {
        if (client.socket.destroyed || generation !== client.attachGeneration) return;
        sendToClient(client, { type: 'activeTabChanged', sessionId });
        client.stop = undefined;
        if (client.reattachTimer) clearTimeout(client.reattachTimer);
        client.reattachTimer = setTimeout(() => {
          client.reattachTimer = undefined;
          if (!client.socket.destroyed && generation === client.attachGeneration) void attachScreencast(client);
        }, 0);
      },
      onError: (error) => sendToClient(client, {
        type: 'error',
        error: error instanceof Error ? error.message : 'Browser screencast failed',
      }),
      onFrame: (frame) => {
        sendFrameToClient(client, {
          ...frame,
          type: 'frame',
        });
      },
    });
    if (!handle) {
      sendToClient(client, { type: 'error', error: 'Browser chat session not found' });
      await removeClient(client);
      return;
    }
    if (client.socket.destroyed || generation !== client.attachGeneration) {
      await handle.stop().catch(() => undefined);
      return;
    }
    client.stop = handle.stop;
    sendToClient(client, { type: 'ready', sessionId });
  } catch (error) {
    sendToClient(client, {
      type: 'error',
      error: error instanceof Error ? error.message : 'Failed to start browser screencast',
    });
    await removeClient(client);
  }
}

function createBrowserPreviewServer() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: true }));
  });

  server.on('upgrade', (request, socket) => {
    const netSocket = socket as Socket;
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname !== '/browser-preview') {
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

    const client: BrowserPreviewClient = {
      actionChain: Promise.resolve(),
      attachGeneration: 0,
      buffer: Buffer.alloc(0),
      frameBlocked: false,
      moveActive: false,
      sessionId: (url.searchParams.get('sessionId') || '').trim(),
      socket: netSocket,
      userId: (url.searchParams.get('userId') || url.searchParams.get('qzUserId') || '').trim(),
    };
    state().clients.add(client);
    netSocket.setNoDelay(true);
    netSocket.on('data', (chunk) => handleClientData(client, chunk));
    netSocket.on('close', () => void removeClient(client));
    netSocket.on('error', () => void removeClient(client));
    sendToClient(client, { type: 'hello', connectedAt: new Date().toISOString() });
    void attachScreencast(client);
  });

  return server;
}

async function closeOutdatedBrowserPreviewServer(current: BrowserPreviewWebSocketState) {
  if (!current.server) return;
  const clients = [...current.clients];
  await Promise.all(clients.map((client) => removeClient(client)));
  if (current.heartbeat) clearInterval(current.heartbeat);
  current.heartbeat = undefined;
  const server = current.server;
  current.server = undefined;
  current.port = undefined;
  current.implementationVersion = undefined;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export async function ensureBrowserPreviewWebSocketServer(): Promise<BrowserPreviewWebSocketInfo> {
  const current = state();
  if (
    current.server
    && current.port
    && current.implementationVersion === BROWSER_PREVIEW_IMPLEMENTATION_VERSION
  ) {
    return { port: current.port, url: `ws://127.0.0.1:${current.port}/browser-preview` };
  }
  if (current.starting) return current.starting;

  current.starting = (async () => {
    await closeOutdatedBrowserPreviewServer(current);
    const server = createBrowserPreviewServer();
    const port = await listen(server, previewWebSocketPortStart());
    current.server = server;
    current.port = port;
    current.implementationVersion = BROWSER_PREVIEW_IMPLEMENTATION_VERSION;
    current.heartbeat = setInterval(() => {
      for (const client of [...current.clients]) sendToClient(client, { type: 'heartbeat', time: new Date().toISOString() });
    }, 25_000);
    current.heartbeat.unref?.();
    return { port, url: `ws://127.0.0.1:${port}/browser-preview` };
  })().finally(() => {
    current.starting = undefined;
  });

  return current.starting;
}
