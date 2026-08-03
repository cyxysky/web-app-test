'use client';

import { withWebPilotBasePath } from '@/lib/webpilot-base-path';

export type RealtimeRefreshEvent = {
  type: 'refresh';
  entityType: 'run' | 'browserChatSession';
  id: string;
  updatedAt: string;
  version: number;
  deleted?: boolean;
  patch?: unknown;
};

type RealtimeMessage = RealtimeRefreshEvent | {
  type: 'heartbeat' | 'hello';
  [key: string]: unknown;
};

type RefreshListener = (event: RealtimeRefreshEvent) => void;

const listeners = new Set<RefreshListener>();

let socket: WebSocket | undefined;
let reconnectTimer: number | undefined;
let reconnectDelay = 800;
let connecting = false;
let currentUserId = '0';

function scheduleReconnect() {
  if (reconnectTimer || !listeners.size) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    void connectRefreshWebSocket();
  }, reconnectDelay);
  reconnectDelay = Math.min(8_000, Math.round(reconnectDelay * 1.6));
}

async function refreshWebSocketUrl() {
  const endpoint = `${withWebPilotBasePath('/api/realtime/ws')}?userId=${encodeURIComponent(currentUserId)}`;
  const response = await fetch(endpoint, { cache: 'no-store' });
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
    const nextSocket = new WebSocket(url);
    socket = nextSocket;
    nextSocket.onopen = () => {
      reconnectDelay = 800;
    };
    nextSocket.onmessage = (message) => {
      let payload: RealtimeMessage | undefined;
      try {
        payload = JSON.parse(String(message.data)) as RealtimeMessage;
      } catch {
        return;
      }
      if (payload?.type !== 'refresh') return;
      for (const listener of [...listeners]) listener(payload);
    };
    nextSocket.onclose = () => {
      if (socket !== nextSocket) return;
      socket = undefined;
      scheduleReconnect();
    };
    nextSocket.onerror = () => {
      nextSocket.close();
    };
  } catch {
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
}

export function subscribeRealtimeRefresh(
  listener: RefreshListener,
  options: { userId?: string } = {},
) {
  const nextUserId = options.userId?.trim() || '0';
  if (!listeners.size) currentUserId = nextUserId;
  listeners.add(listener);
  void connectRefreshWebSocket();
  return () => {
    listeners.delete(listener);
    closeIfIdle();
  };
}
