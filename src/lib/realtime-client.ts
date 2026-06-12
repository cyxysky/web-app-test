'use client';

export type RealtimeClientEvent = {
  entityType: string;
  id: string;
  event: 'snapshot' | 'refresh' | 'deleted';
  reason?: string;
  time: string;
  version?: number;
};

type RealtimeSubscriptionOptions = {
  retryMs?: number;
};

export function subscribeRealtime(
  topics: string[],
  onEvent: (event: RealtimeClientEvent) => void,
  options: RealtimeSubscriptionOptions = {},
) {
  const cleanTopics = Array.from(new Set(topics.map((item) => item.trim()).filter(Boolean))).sort();
  if (!cleanTopics.length || typeof window === 'undefined' || typeof WebSocket === 'undefined') return () => undefined;

  let closed = false;
  let socket: WebSocket | undefined;
  let retryTimer: number | undefined;
  const retryMs = Math.max(500, options.retryMs || 1200);

  const cleanupSocket = () => {
    if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    retryTimer = undefined;
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
    socket = undefined;
  };

  const scheduleReconnect = () => {
    if (closed || retryTimer !== undefined) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = undefined;
      void connect();
    }, retryMs);
  };

  const connect = async () => {
    try {
      const params = new URLSearchParams({ topics: cleanTopics.join(',') });
      const response = await fetch(`/api/realtime/ws?${params.toString()}`, { cache: 'no-store' });
      const data = await response.json();
      if (closed) return;
      if (!response.ok || typeof data.url !== 'string') {
        scheduleReconnect();
        return;
      }
      socket = new WebSocket(data.url);
      socket.onmessage = (message) => {
        try {
          const event = JSON.parse(String(message.data)) as RealtimeClientEvent;
          if (event.entityType === 'realtime' && event.reason === 'connected') return;
          onEvent(event);
        } catch {
          // Ignore malformed realtime messages; the next valid event will refresh state.
        }
      };
      socket.onclose = scheduleReconnect;
      socket.onerror = () => {
        socket?.close();
        scheduleReconnect();
      };
    } catch {
      scheduleReconnect();
    }
  };

  void connect();

  return () => {
    closed = true;
    cleanupSocket();
  };
}
