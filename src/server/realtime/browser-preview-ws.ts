import http from 'node:http';
import type { Socket } from 'node:net';
import { dispatchBrowserChatPreviewInput, startBrowserChatScreencast } from '@/server/ai/agents/browser-chat.service';
import type { BrowserLiveInput, BrowserScreencastFrame, BrowserTabSnapshot } from '@/server/browser/browser-session';
import { browserPreviewFramesPerSecond } from '@/server/browser/browser-preview-cadence';
import type { BrowserPreviewFramePumpMetrics } from '@/server/browser/browser-preview-frame-pump';
import {
  acceptWebSocketUpgrade,
  consumeWebSocketFrames,
  encodeWebSocketBinary,
  encodeWebSocketControl,
  encodeWebSocketText,
  listenWebSocketServer,
} from '@/server/realtime/websocket-transport';
import {
  BrowserPreviewVideoEncoder,
  browserPreviewVideoDimensions,
} from './browser-preview-video-encoder';
import { consumeWebSocketTicket } from '@/server/auth/websocket-ticket';

type BrowserPreviewTransport = 'image' | 'video';

type BrowserPreviewWebSocketInfo = {
  port: number;
  url: string;
};

type BrowserPreviewClient = {
  actionChain: Promise<void>;
  buffer: Buffer;
  frameBlocked: boolean;
  pendingFrame?: Buffer;
  pendingMove?: Extract<BrowserLiveInput, { kind: 'move' }>;
  moveActive: boolean;
  sessionId: string;
  socket: Socket;
  streamKey: string;
  transport: BrowserPreviewTransport;
  userId: string;
};

type BrowserPreviewStream = {
  backpressureDrops: number;
  clients: Set<BrowserPreviewClient>;
  generation: number;
  key: string;
  lastTabs?: BrowserTabSnapshot[];
  lastTabsKey?: string;
  lastFrame?: BrowserScreencastFrame;
  lastUrl?: string;
  lastViewport?: BrowserScreencastFrame['viewport'];
  lastViewportKey?: string;
  metrics?: () => BrowserPreviewFramePumpMetrics;
  metricsTimer?: ReturnType<typeof setInterval>;
  networkBytes: number;
  payloadBuildMs: number;
  reattachTimer?: ReturnType<typeof setTimeout>;
  sequence: number;
  sessionId: string;
  starting?: Promise<void>;
  stop?: () => Promise<void>;
  transport: BrowserPreviewTransport;
  videoEncoder?: BrowserPreviewVideoEncoder;
  videoInitialization?: Buffer;
  videoMimeType?: string;
  wireFrames: number;
  userId: string;
};

type BrowserPreviewWebSocketState = {
  clients: Set<BrowserPreviewClient>;
  heartbeat?: ReturnType<typeof setInterval>;
  implementationVersion?: number;
  port?: number;
  server?: http.Server;
  starting?: Promise<BrowserPreviewWebSocketInfo>;
  streams: Map<string, BrowserPreviewStream>;
};

const BROWSER_PREVIEW_IMPLEMENTATION_VERSION = 22;

declare global {
  var __browserChatPreviewWebSocketState: BrowserPreviewWebSocketState | undefined;
}

function state() {
  if (!globalThis.__browserChatPreviewWebSocketState) {
    globalThis.__browserChatPreviewWebSocketState = {
      clients: new Set<BrowserPreviewClient>(),
      streams: new Map<string, BrowserPreviewStream>(),
    };
  }
  globalThis.__browserChatPreviewWebSocketState.streams ??= new Map<string, BrowserPreviewStream>();
  return globalThis.__browserChatPreviewWebSocketState;
}

function previewWebSocketPortStart() {
  const raw = Number(process.env.BROWSER_CHAT_PREVIEW_WS_PORT || 18021);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 18021;
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
  client.pendingFrame = undefined;
  client.pendingMove = undefined;
  const stream = state().streams.get(client.streamKey);
  stream?.clients.delete(client);
  if (stream && stream.clients.size === 0) await stopStream(stream);
  client.socket.destroy();
}

function flushPendingFrame(client: BrowserPreviewClient) {
  client.frameBlocked = false;
  const frame = client.pendingFrame;
  client.pendingFrame = undefined;
  if (frame !== undefined) sendFrameToClient(client, frame);
}

export function browserPreviewPreferredTransport(value = process.env.BROWSER_PREVIEW_TRANSPORT): BrowserPreviewTransport {
  return String(value || '').trim().toLowerCase() === 'image' ? 'image' : 'video';
}

function sendVideoToClient(client: BrowserPreviewClient, payload: Buffer): 'blocked' | 'closed' | 'sent' {
  if (client.frameBlocked) {
    // Encoded fragments form one byte stream, so replacing an arbitrary
    // pending fragment (the JPEG strategy) would corrupt the decoder state.
    void removeClient(client);
    return 'closed';
  }
  try {
    if (client.socket.destroyed) return 'closed';
    if (client.socket.write(payload)) return 'sent';
    client.frameBlocked = true;
    client.socket.once('drain', () => { client.frameBlocked = false; });
    return 'blocked';
  } catch {
    void removeClient(client);
    return 'closed';
  }
}

function sendFrameToClient(client: BrowserPreviewClient, payload: Buffer): 'closed' | 'pending' | 'replaced' | 'sent' {
  if (client.frameBlocked) {
    const replaced = client.pendingFrame !== undefined;
    client.pendingFrame = payload;
    return replaced ? 'replaced' : 'pending';
  }
  try {
    if (!client.socket.destroyed && client.socket.write(payload)) return 'sent';
  } catch {
    void removeClient(client);
    return 'closed';
  }
  if (client.socket.destroyed) return 'closed';
  client.frameBlocked = true;
  client.pendingFrame = undefined;
  client.socket.once('drain', () => flushPendingFrame(client));
  return 'sent';
}

function binaryFramePayload(frame: BrowserScreencastFrame, sequence: number) {
  const image = Buffer.from(frame.data, 'base64');
  const metadata = Buffer.from(JSON.stringify({
    capturedAt: frame.capturedAt,
    contentType: frame.contentType,
    sequence,
    type: 'frame',
  }), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(metadata.length, 0);
  return encodeWebSocketBinary(Buffer.concat([header, metadata, image]));
}

function binaryVideoPayload(type: 'videoChunk' | 'videoInit', data: Buffer, sequence: number, contentType: string) {
  const metadata = Buffer.from(JSON.stringify({
    contentType,
    sequence,
    type,
  }), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(metadata.length, 0);
  return encodeWebSocketBinary(Buffer.concat([header, metadata, data]));
}

function broadcastText(stream: BrowserPreviewStream, payload: unknown) {
  for (const client of [...stream.clients]) sendToClient(client, payload);
}

function sendLatestFrameState(client: BrowserPreviewClient, stream: BrowserPreviewStream) {
  sendToClient(client, { type: 'transportChanged', transport: stream.transport });
  if (stream.lastTabs) sendToClient(client, { type: 'tabsChanged', tabs: stream.lastTabs, sequence: stream.sequence });
  if (stream.lastUrl !== undefined) sendToClient(client, { type: 'navigationChanged', url: stream.lastUrl, sequence: stream.sequence });
  if (stream.lastViewport) sendToClient(client, { type: 'viewportChanged', viewport: stream.lastViewport, sequence: stream.sequence });
  if (stream.lastFrame) {
    sendFrameToClient(client, binaryFramePayload(stream.lastFrame, ++stream.sequence));
  }
  if (stream.transport === 'video' && stream.videoInitialization && stream.videoMimeType) {
    const payload = binaryVideoPayload('videoInit', stream.videoInitialization, ++stream.sequence, stream.videoMimeType);
    const result = sendVideoToClient(client, payload);
    if (result !== 'closed') stream.networkBytes += payload.length;
  }
}

function broadcastTabsChanged(stream: BrowserPreviewStream, tabs: BrowserTabSnapshot[]) {
  const nextSequence = stream.sequence + 1;
  const tabsKey = JSON.stringify(tabs);
  if (tabsKey !== stream.lastTabsKey) {
    stream.lastTabs = tabs;
    stream.lastTabsKey = tabsKey;
    broadcastText(stream, { type: 'tabsChanged', tabs, sequence: nextSequence });
  }
}

function broadcastFrameStateChanges(stream: BrowserPreviewStream, frame: BrowserScreencastFrame) {
  const nextSequence = stream.sequence + 1;
  if (frame.url !== stream.lastUrl) {
    stream.lastUrl = frame.url;
    broadcastText(stream, { type: 'navigationChanged', url: frame.url, sequence: nextSequence });
  }
  const viewportKey = `${frame.viewport.width}x${frame.viewport.height}`;
  if (viewportKey !== stream.lastViewportKey) {
    stream.lastViewport = frame.viewport;
    stream.lastViewportKey = viewportKey;
    broadcastText(stream, { type: 'viewportChanged', viewport: frame.viewport, sequence: nextSequence });
  }
}

function broadcastFrame(stream: BrowserPreviewStream, frame: BrowserScreencastFrame) {
  broadcastFrameStateChanges(stream, frame);
  const payloadStartedAt = performance.now();
  const payload = binaryFramePayload(frame, ++stream.sequence);
  stream.payloadBuildMs += performance.now() - payloadStartedAt;
  let recipients = 0;
  for (const client of [...stream.clients]) {
    const result = sendFrameToClient(client, payload);
    if (result !== 'closed') recipients += 1;
    if (result === 'replaced') stream.backpressureDrops += 1;
  }
  stream.wireFrames += 1;
  stream.networkBytes += payload.length * recipients;
}

function broadcastVideoData(stream: BrowserPreviewStream, type: 'videoChunk' | 'videoInit', data: Buffer) {
  if (!stream.videoMimeType) return;
  const payloadStartedAt = performance.now();
  const payload = binaryVideoPayload(type, data, ++stream.sequence, stream.videoMimeType);
  stream.payloadBuildMs += performance.now() - payloadStartedAt;
  let recipients = 0;
  for (const client of [...stream.clients]) {
    const result = sendVideoToClient(client, payload);
    if (result !== 'closed') recipients += 1;
    if (result === 'blocked') stream.backpressureDrops += 1;
  }
  if (type === 'videoChunk') stream.wireFrames += 1;
  stream.networkBytes += payload.length * recipients;
}

function fallbackStreamToImages(stream: BrowserPreviewStream, error: unknown) {
  const encoder = stream.videoEncoder;
  stream.videoEncoder = undefined;
  stream.videoInitialization = undefined;
  stream.videoMimeType = undefined;
  stream.transport = 'image';
  broadcastText(stream, {
    type: 'transportChanged',
    transport: 'image',
    error: error instanceof Error ? error.message : String(error || 'Video encoder unavailable'),
  });
  void encoder?.stop().catch(() => undefined);
}

function pushVideoFrame(stream: BrowserPreviewStream, frame: BrowserScreencastFrame) {
  broadcastFrameStateChanges(stream, frame);
  if (!stream.videoEncoder) {
    // Show the captured page immediately while FFmpeg is still producing the
    // fragmented-MP4 initialization segment. This removes the blank startup
    // interval without changing the selected video transport.
    broadcastFrame(stream, frame);
    const dimensions = browserPreviewVideoDimensions({
      height: frame.metadata?.deviceHeight || frame.viewport.height,
      width: frame.metadata?.deviceWidth || frame.viewport.width,
    });
    let encoder!: BrowserPreviewVideoEncoder;
    try {
      encoder = new BrowserPreviewVideoEncoder({
        contentType: frame.contentType,
        framesPerSecond: browserPreviewFramesPerSecond(process.env.BROWSER_PREVIEW_FPS),
        height: dimensions.height,
        onError: (error) => {
          if (stream.videoEncoder === encoder) fallbackStreamToImages(stream, error);
        },
        onFragment: (fragment) => {
          if (stream.videoEncoder === encoder && stream.transport === 'video') {
            broadcastVideoData(stream, 'videoChunk', fragment);
          }
        },
        onInitialization: (initialization, mimeType) => {
          if (stream.videoEncoder !== encoder || stream.transport !== 'video') return;
          stream.videoInitialization = initialization;
          stream.videoMimeType = mimeType;
          broadcastText(stream, {
            type: 'videoReady',
            contentType: mimeType,
            height: dimensions.height,
            transport: 'video',
            width: dimensions.width,
          });
          broadcastVideoData(stream, 'videoInit', initialization);
        },
        width: dimensions.width,
      });
      stream.videoEncoder = encoder;
    } catch (error) {
      fallbackStreamToImages(stream, error);
    }
  }
  if (stream.transport === 'video' && stream.videoEncoder) {
    stream.videoEncoder.pushFrame(Buffer.from(frame.data, 'base64'));
  } else {
    broadcastFrame(stream, frame);
  }
}

function handlePreviewFrame(stream: BrowserPreviewStream, frame: BrowserScreencastFrame) {
  stream.lastFrame = frame;
  if (stream.transport === 'video') pushVideoFrame(stream, frame);
  else broadcastFrame(stream, frame);
}

function stopStreamMetrics(stream: BrowserPreviewStream) {
  if (stream.metricsTimer) clearInterval(stream.metricsTimer);
  stream.metricsTimer = undefined;
  stream.metrics = undefined;
}

function startStreamMetrics(stream: BrowserPreviewStream, metrics: () => BrowserPreviewFramePumpMetrics) {
  stopStreamMetrics(stream);
  stream.metrics = metrics;
  const initialMetrics = metrics();
  let previousSample = {
    at: performance.now(),
    backpressureDrops: stream.backpressureDrops,
    nativeFrames: initialMetrics.nativeFrames,
    networkBytes: stream.networkBytes,
    transmittedFrames: initialMetrics.transmittedFrames,
    wireFrames: stream.wireFrames,
  };
  stream.metricsTimer = setInterval(() => {
    const pumpMetrics = stream.metrics?.();
    if (!pumpMetrics) return;
    const sampledAt = performance.now();
    const sampleSeconds = Math.max(0.001, (sampledAt - previousSample.at) / 1_000);
    const elapsedSeconds = Math.max(0.001, pumpMetrics?.elapsedSeconds || 0.001);
    broadcastText(stream, {
      type: 'frameHeartbeat',
      sequence: stream.sequence,
      time: new Date().toISOString(),
      metrics: {
        ...pumpMetrics,
        ...(stream.videoEncoder?.metrics() || {}),
        backpressureDrops: stream.backpressureDrops,
        backpressureDropsPerSecond: (stream.backpressureDrops - previousSample.backpressureDrops) / sampleSeconds,
        captureFps: (pumpMetrics.nativeFrames - previousSample.nativeFrames) / sampleSeconds,
        duplicateFrames: 0,
        networkBytes: stream.networkBytes,
        networkBytesPerSecond: stream.networkBytes / elapsedSeconds,
        recentNetworkBytesPerSecond: (stream.networkBytes - previousSample.networkBytes) / sampleSeconds,
        payloadBuildMs: stream.payloadBuildMs,
        payloadBuildMsPerFrame: stream.wireFrames ? stream.payloadBuildMs / stream.wireFrames : 0,
        pendingClientFrames: [...stream.clients].filter((client) => client.pendingFrame !== undefined).length,
        sendFps: (stream.wireFrames - previousSample.wireFrames) / sampleSeconds,
        transmittedFpsRecent: (pumpMetrics.transmittedFrames - previousSample.transmittedFrames) / sampleSeconds,
        transport: stream.transport,
        wireFrames: stream.wireFrames,
      },
    });
    previousSample = {
      at: sampledAt,
      backpressureDrops: stream.backpressureDrops,
      nativeFrames: pumpMetrics.nativeFrames,
      networkBytes: stream.networkBytes,
      transmittedFrames: pumpMetrics.transmittedFrames,
      wireFrames: stream.wireFrames,
    };
  }, 1_000);
  stream.metricsTimer.unref?.();
}

function readLiveInput(value: unknown): BrowserLiveInput | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  if (input.kind === 'tab' && typeof input.tabId === 'string' && input.tabId.trim()) {
    return { kind: 'tab', tabId: input.tabId.trim() };
  }
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
  if (input.kind === 'drag') {
    return {
      kind: 'drag',
      xRatio: Number(input.xRatio),
      yRatio: Number(input.yRatio),
      toXRatio: Number(input.toXRatio),
      toYRatio: Number(input.toYRatio),
      button: input.button === 'right' || input.button === 'middle' ? input.button : 'left',
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
      } else if (input.kind === 'tab') {
        const stream = state().streams.get(client.streamKey);
        if (stream) {
          broadcastText(stream, { type: 'activeTabChanged', sessionId: client.sessionId });
          await restartStream(stream);
        }
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
  client.buffer = Buffer.from(consumeWebSocketFrames(client.buffer, chunk, {
    onClose: () => void removeClient(client),
    onProtocolError: () => void removeClient(client),
    onPing: (payload) => client.socket.write(encodeWebSocketControl(0xA, payload)),
    onText: (payload) => handleClientMessage(client, payload),
  }));
}

async function attachStream(stream: BrowserPreviewStream) {
  if (stream.starting) return stream.starting;
  if (stream.stop || stream.clients.size === 0) return;
  const { sessionId, userId } = stream;
  if (!sessionId) {
    broadcastText(stream, { type: 'error', error: 'Missing browser chat sessionId' });
    return;
  }
  const generation = ++stream.generation;
  stream.starting = (async () => {
    try {
      broadcastText(stream, { type: 'transportChanged', transport: stream.transport });
      const handle = await startBrowserChatScreencast(sessionId, userId, {
        onActivePageChanged: () => {
          if (generation !== stream.generation || stream.clients.size === 0) return;
          broadcastText(stream, { type: 'activeTabChanged', sessionId });
          if (stream.reattachTimer) clearTimeout(stream.reattachTimer);
          stream.reattachTimer = setTimeout(() => {
            stream.reattachTimer = undefined;
            if (generation === stream.generation && stream.clients.size > 0) void restartStream(stream);
          }, 0);
        },
        onError: (error) => broadcastText(stream, {
          type: 'error',
          error: error instanceof Error ? error.message : 'Browser screencast failed',
        }),
        onFrame: (frame) => handlePreviewFrame(stream, frame),
        onTabsChanged: (tabs) => broadcastTabsChanged(stream, tabs),
        video: stream.transport === 'video',
      });
      if (!handle) {
        broadcastText(stream, { type: 'unavailable', error: 'Browser chat session or its browser is not available' });
        return;
      }
      if (generation !== stream.generation || stream.clients.size === 0) {
        await handle.stop().catch(() => undefined);
        return;
      }
      stream.stop = async () => {
        const encoder = stream.videoEncoder;
        stream.videoEncoder = undefined;
        stream.videoInitialization = undefined;
        stream.videoMimeType = undefined;
        await Promise.all([
          handle.stop().catch(() => undefined),
          encoder?.stop().catch(() => undefined),
        ]);
      };
      startStreamMetrics(stream, handle.metrics);
      broadcastText(stream, { type: 'ready', sessionId });
    } catch (error) {
      broadcastText(stream, {
        type: 'unavailable',
        error: error instanceof Error ? error.message : 'Failed to start browser screencast',
      });
    }
  })().finally(() => {
    stream.starting = undefined;
  });
  return stream.starting;
}

async function restartStream(stream: BrowserPreviewStream) {
  stream.generation += 1;
  if (stream.reattachTimer) clearTimeout(stream.reattachTimer);
  stream.reattachTimer = undefined;
  await stream.starting?.catch(() => undefined);
  const stop = stream.stop;
  stream.stop = undefined;
  stopStreamMetrics(stream);
  await stop?.().catch(() => undefined);
  if (stream.clients.size > 0) await attachStream(stream);
}

async function stopStream(stream: BrowserPreviewStream) {
  stream.generation += 1;
  if (stream.reattachTimer) clearTimeout(stream.reattachTimer);
  stream.reattachTimer = undefined;
  await stream.starting?.catch(() => undefined);
  const stop = stream.stop;
  stream.stop = undefined;
  stopStreamMetrics(stream);
  await stop?.().catch(() => undefined);
  if (state().streams.get(stream.key) === stream) state().streams.delete(stream.key);
}

function subscribeClient(client: BrowserPreviewClient) {
  let stream = state().streams.get(client.streamKey);
  if (!stream) {
    stream = {
      backpressureDrops: 0,
      clients: new Set(),
      generation: 0,
      key: client.streamKey,
      networkBytes: 0,
      payloadBuildMs: 0,
      sequence: 0,
      sessionId: client.sessionId,
      transport: client.transport,
      userId: client.userId,
      wireFrames: 0,
    };
    state().streams.set(client.streamKey, stream);
  }
  stream.clients.add(client);
  if (stream.stop) {
    sendToClient(client, { type: 'ready', sessionId: client.sessionId });
    sendLatestFrameState(client, stream);
  }
  else void attachStream(stream);
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
    const sessionId = (url.searchParams.get('sessionId') || '').trim();
    const auth = consumeWebSocketTicket({
      origin: String(request.headers.origin || '').trim(),
      scope: 'browser-preview',
      sessionId,
      ticket: (url.searchParams.get('ticket') || '').trim(),
    });
    if (!auth) {
      netSocket.destroy();
      return;
    }
    if (!acceptWebSocketUpgrade(request, netSocket)) {
      netSocket.destroy();
      return;
    }

    const client: BrowserPreviewClient = {
      actionChain: Promise.resolve(),
      buffer: Buffer.alloc(0),
      frameBlocked: false,
      moveActive: false,
      sessionId,
      socket: netSocket,
      streamKey: '',
      transport: browserPreviewPreferredTransport(url.searchParams.get('transport') || undefined),
      userId: auth.userId,
    };
    client.streamKey = `${client.userId}\u0000${client.sessionId}\u0000${client.transport}`;
    state().clients.add(client);
    netSocket.setNoDelay(true);
    netSocket.on('data', (chunk) => handleClientData(client, chunk));
    netSocket.on('close', () => void removeClient(client));
    netSocket.on('error', () => void removeClient(client));
    sendToClient(client, { type: 'hello', connectedAt: new Date().toISOString() });
    subscribeClient(client);
  });

  return server;
}

async function closeOutdatedBrowserPreviewServer(current: BrowserPreviewWebSocketState) {
  if (!current.server) return;
  const clients = [...current.clients];
  await Promise.all(clients.map((client) => removeClient(client)));
  await Promise.all([...current.streams.values()].map((stream) => stopStream(stream)));
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
    const port = await listenWebSocketServer(server, previewWebSocketPortStart(), {
      host: '127.0.0.1',
      addressInUseMessage: (port) => `Browser preview WebSocket port ${port} is already in use. Set BROWSER_CHAT_PREVIEW_WS_PORT to an available internal port.`,
    });
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
