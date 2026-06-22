import { createHash } from 'node:crypto';
import http from 'node:http';
import type { Socket } from 'node:net';
import { startBrowserChatScreencast } from '@/server/ai/agents/browser-chat.service';

type BrowserPreviewWebSocketInfo = {
  port: number;
  url: string;
};

type BrowserPreviewClient = {
  buffer: Buffer;
  socket: Socket;
  stop?: () => Promise<void>;
};

type BrowserPreviewWebSocketState = {
  clients: Set<BrowserPreviewClient>;
  heartbeat?: ReturnType<typeof setInterval>;
  port?: number;
  server?: http.Server;
  starting?: Promise<BrowserPreviewWebSocketInfo>;
};

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
    client.socket.write(encodeWebSocketText(JSON.stringify(payload)));
    return true;
  } catch {
    void removeClient(client);
    return false;
  }
}

async function removeClient(client: BrowserPreviewClient) {
  state().clients.delete(client);
  const stop = client.stop;
  client.stop = undefined;
  await stop?.().catch(() => undefined);
  client.socket.destroy();
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
    server.listen(port, '0.0.0.0');
  });
}

async function attachScreencast(client: BrowserPreviewClient, url: URL) {
  const sessionId = (url.searchParams.get('sessionId') || '').trim();
  const userId = (url.searchParams.get('userId') || url.searchParams.get('qzUserId') || '').trim();
  if (!sessionId) {
    sendToClient(client, { type: 'error', error: 'Missing browser chat sessionId' });
    await removeClient(client);
    return;
  }
  try {
    const handle = await startBrowserChatScreencast(sessionId, userId, {
      onActivePageChanged: () => {
        sendToClient(client, { type: 'activeTabChanged', sessionId });
      },
      onError: (error) => sendToClient(client, {
        type: 'error',
        error: error instanceof Error ? error.message : 'Browser screencast failed',
      }),
      onFrame: (frame) => {
        sendToClient(client, {
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

    const client: BrowserPreviewClient = { buffer: Buffer.alloc(0), socket: netSocket };
    state().clients.add(client);
    netSocket.setNoDelay(true);
    netSocket.on('data', (chunk) => handleClientData(client, chunk));
    netSocket.on('close', () => void removeClient(client));
    netSocket.on('error', () => void removeClient(client));
    sendToClient(client, { type: 'hello', connectedAt: new Date().toISOString() });
    void attachScreencast(client, url);
  });

  return server;
}

export async function ensureBrowserPreviewWebSocketServer(): Promise<BrowserPreviewWebSocketInfo> {
  const current = state();
  if (current.server && current.port) {
    return { port: current.port, url: `ws://127.0.0.1:${current.port}/browser-preview` };
  }
  if (current.starting) return current.starting;

  current.starting = (async () => {
    const server = createBrowserPreviewServer();
    const port = await listen(server, previewWebSocketPortStart());
    current.server = server;
    current.port = port;
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
