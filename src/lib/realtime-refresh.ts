'use client';

import { withWebPilotBasePath } from '@/lib/webpilot-base-path';

export type RealtimeRefreshEvent = {
  type: 'refresh';
  entityType:
    | 'automationCase'
    | 'automationRun'
    | 'automationSchedule'
    | 'browserChatSession';
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

type RefreshSubscription = {
  listener: RefreshListener;
  onResync?: () => void | Promise<void>;
};

const subscriptions = new Set<RefreshSubscription>();

let socket: WebSocket | undefined;
let reconnectTimer: number | undefined;
let reconnectDelay = 800;
let connecting = false;
let handshakeCompleted = false;
let resyncRequired = false;

function notifyResyncRequired() {
  for (const subscription of [...subscriptions]) {
    if (!subscription.onResync) continue;
    void Promise.resolve(subscription.onResync()).catch(() => undefined);
  }
}

function scheduleReconnect() {
  if (reconnectTimer || !subscriptions.size) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    void connectRefreshWebSocket();
  }, reconnectDelay);
  reconnectDelay = Math.min(8_000, Math.round(reconnectDelay * 1.6));
}

async function refreshWebSocketUrl() {
  const endpoint = withWebPilotBasePath('/api/realtime/ws');
  const response = await fetch(endpoint, { cache: 'no-store', method: 'POST' });
  const data = await response.json();
  if (!response.ok || typeof data.url !== 'string') throw new Error(data.error || 'Realtime WebSocket is unavailable');
  return data.url as string;
}

async function connectRefreshWebSocket() {
  if (connecting || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  if (!subscriptions.size) return;
  connecting = true;
  try {
    const url = await refreshWebSocketUrl();
    if (!subscriptions.size) return;
    const nextSocket = new WebSocket(url);
    let helloReceived = false;
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
      if (payload?.type === 'hello') {
        helloReceived = true;
        const shouldResync = handshakeCompleted && resyncRequired;
        handshakeCompleted = true;
        resyncRequired = false;
        if (shouldResync) notifyResyncRequired();
        return;
      }
      if (payload?.type !== 'refresh') return;
      for (const subscription of [...subscriptions]) subscription.listener(payload);
    };
    nextSocket.onclose = () => {
      if (socket !== nextSocket) return;
      socket = undefined;
      if (subscriptions.size && (helloReceived || handshakeCompleted)) resyncRequired = true;
      scheduleReconnect();
    };
    nextSocket.onerror = () => {
      nextSocket.close();
    };
  } catch {
    if (handshakeCompleted) resyncRequired = true;
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

function closeIfIdle() {
  if (subscriptions.size) return;
  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  socket?.close();
  socket = undefined;
}

export function subscribeRealtimeRefresh(
  listener: RefreshListener,
  options: { onResync?: () => void | Promise<void> } = {},
) {
  const subscription: RefreshSubscription = { listener, onResync: options.onResync };
  subscriptions.add(subscription);
  void connectRefreshWebSocket();
  return () => {
    subscriptions.delete(subscription);
    closeIfIdle();
  };
}
