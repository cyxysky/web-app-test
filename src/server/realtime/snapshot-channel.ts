import { NextResponse } from 'next/server';

export type SnapshotEvent<T> = {
  entityType: string;
  id: string;
  time: string;
  version: number;
  snapshot?: T;
  deleted?: boolean;
};

export type SnapshotListener<T> = (event: SnapshotEvent<T>) => void;

export function createSnapshotChannel<T>(entityType: string) {
  const listeners = new Map<string, Set<SnapshotListener<T>>>();
  const versions = new Map<string, number>();

  function nextVersion(id: string) {
    const version = Math.max((versions.get(id) || 0) + 1, Date.now());
    versions.set(id, version);
    return version;
  }

  function currentVersion(id: string) {
    const version = versions.get(id) || 0;
    return version >= Date.now() ? version : nextVersion(id);
  }

  function current(id: string, snapshot?: T): SnapshotEvent<T> {
    return {
      entityType,
      id,
      time: new Date().toISOString(),
      version: currentVersion(id),
      snapshot,
    };
  }

  function publish(id: string, snapshot: T) {
    const event: SnapshotEvent<T> = {
      entityType,
      id,
      time: new Date().toISOString(),
      version: nextVersion(id),
      snapshot,
    };
    notify(id, event);
    return event;
  }

  function publishDeleted(id: string) {
    const event: SnapshotEvent<T> = {
      entityType,
      id,
      time: new Date().toISOString(),
      version: nextVersion(id),
      deleted: true,
    };
    notify(id, event);
    return event;
  }

  function subscribe(id: string, listener: SnapshotListener<T>) {
    const currentListeners = listeners.get(id) || new Set<SnapshotListener<T>>();
    currentListeners.add(listener);
    listeners.set(id, currentListeners);
    return () => {
      currentListeners.delete(listener);
      if (!currentListeners.size) listeners.delete(id);
    };
  }

  function notify(id: string, event: SnapshotEvent<T>) {
    const currentListeners = listeners.get(id);
    if (!currentListeners?.size) return;
    for (const listener of [...currentListeners]) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must not interrupt the producer.
      }
    }
  }

  return {
    current,
    publish,
    publishDeleted,
    subscribe,
  };
}

type SnapshotEventStreamOptions<T> = {
  request: Request;
  eventName: string;
  deletedEventName?: string;
  getSnapshot: () => T | undefined | Promise<T | undefined>;
  initialEvent: (snapshot: T) => SnapshotEvent<T>;
  subscribe: (listener: SnapshotListener<T>) => (() => void) | undefined;
  notFoundMessage: string;
  isComplete?: (snapshot: T) => boolean;
  headers?: Record<string, string>;
  heartbeatMs?: number;
};

export function createSnapshotEventStream<T>(options: SnapshotEventStreamOptions<T>) {
  const {
    request,
    eventName,
    deletedEventName = 'deleted',
    getSnapshot,
    initialEvent,
    subscribe,
    notFoundMessage,
    isComplete,
    headers,
    heartbeatMs = 15_000,
  } = options;
  const encoder = new TextEncoder();
  const streamState: { closed: boolean; stopTimer?: () => void; unsubscribe?: () => void } = { closed: false };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let previous = '';

      const close = () => {
        if (streamState.closed) return;
        streamState.closed = true;
        streamState.stopTimer?.();
        streamState.unsubscribe?.();
        try {
          controller.close();
        } catch {
          // The client may already have closed the stream.
        }
      };

      const enqueue = (chunk: string) => {
        if (streamState.closed) return false;
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          close();
          return false;
        }
      };

      const send = (eventNameToSend: string, payload: unknown) => {
        const serialized = JSON.stringify(payload);
        const chunk = `event: ${eventNameToSend}\ndata: ${serialized}\n\n`;
        if (chunk === previous) return enqueue(': heartbeat\n\n');
        previous = chunk;
        return enqueue(chunk);
      };

      const sendSnapshotEvent = (event: SnapshotEvent<T>) => {
        if (event.deleted) {
          send(deletedEventName, event);
          close();
          return;
        }
        if (!event.snapshot) return;
        if (!send(eventName, event)) return;
        if (isComplete?.(event.snapshot)) close();
      };

      const snapshot = await getSnapshot();
      if (!snapshot) {
        enqueue(`event: error\ndata: ${JSON.stringify({ error: notFoundMessage })}\n\n`);
        close();
        return;
      }

      streamState.unsubscribe = subscribe(sendSnapshotEvent);
      if (!streamState.unsubscribe) {
        enqueue(`event: error\ndata: ${JSON.stringify({ error: notFoundMessage })}\n\n`);
        close();
        return;
      }

      sendSnapshotEvent(initialEvent(snapshot));
      if (!streamState.closed) {
        const timer = setInterval(() => enqueue(': heartbeat\n\n'), heartbeatMs);
        streamState.stopTimer = () => clearInterval(timer);
      }
      request.signal.addEventListener('abort', close);
    },
    cancel() {
      streamState.closed = true;
      streamState.stopTimer?.();
      streamState.unsubscribe?.();
    },
  });

  return new NextResponse(stream, {
    headers: {
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      ...headers,
    },
  });
}
