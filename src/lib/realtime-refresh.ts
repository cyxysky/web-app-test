'use client';

export type RealtimeRefreshEvent = {
  type: 'refresh';
  entityType: 'run' | 'browserChatSession';
  id: string;
  updatedAt: string;
  version: number;
  deleted?: boolean;
};

type RealtimeMessage = RealtimeRefreshEvent | {
  type: 'heartbeat' | 'hello';
  [key: string]: unknown;
};

type RefreshListener = (event: RealtimeRefreshEvent) => void;
type StatusListener = (connected: boolean) => void;

const listeners = new Set<RefreshListener>();
const statusListeners = new Set<StatusListener>();

let socket: WebSocket | undefined;
let reconnectTimer: number | undefined;
let reconnectDelay = 800;
let connecting = false;
let connected = false;

function setConnected(next: boolean) {
  if (connected === next) return;
  connected = next;
  for (const listener of [...statusListeners]) listener(next);
}

function scheduleReconnect() {
  if (reconnectTimer || !listeners.size) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    void connectRefreshWebSocket();
  }, reconnectDelay);
  reconnectDelay = Math.min(8_000, Math.round(reconnectDelay * 1.6));
}

async function refreshWebSocketUrl() {
  const response = await fetch('/api/realtime/ws', { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || typeof data.url !== 'string') throw new Error(data.error || 'Realtime WebSocket is unavailable');
  return data.url as string;
}

async function connectRefreshWebSocket() {
  if (connecting || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  if (!listeners.size) return;
  connecting = true;
  try {
    const url = await refreshWebSocketUrl();
    if (!listeners.size) return;
    socket = new WebSocket(url);
    socket.onopen = () => {
      reconnectDelay = 800;
      setConnected(true);
    };
    socket.onmessage = (message) => {
      let payload: RealtimeMessage | undefined;
      try {
        payload = JSON.parse(String(message.data)) as RealtimeMessage;
      } catch {
        return;
      }
      if (payload?.type !== 'refresh') return;
      for (const listener of [...listeners]) listener(payload);
    };
    socket.onclose = () => {
      socket = undefined;
      setConnected(false);
      scheduleReconnect();
    };
    socket.onerror = () => {
      setConnected(false);
      socket?.close();
    };
  } catch {
    setConnected(false);
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

function closeIfIdle() {
  if (listeners.size) return;
  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  socket?.close();
  socket = undefined;
  setConnected(false);
}

export function subscribeRealtimeRefresh(
  listener: RefreshListener,
  options: { onStatus?: StatusListener } = {},
) {
  listeners.add(listener);
  if (options.onStatus) {
    statusListeners.add(options.onStatus);
    options.onStatus(connected);
  }
  void connectRefreshWebSocket();
  return () => {
    listeners.delete(listener);
    if (options.onStatus) statusListeners.delete(options.onStatus);
    closeIfIdle();
  };
}
