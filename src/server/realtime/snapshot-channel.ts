import { publishRealtimeEvent } from '@/server/realtime/ws-hub';

export type SnapshotEvent<T> = {
  entityType: string;
  id: string;
  time: string;
  version: number;
  snapshot?: T;
  deleted?: boolean;
  refresh?: boolean;
  reason?: string;
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
    publishRealtimeEvent({
      entityType,
      id,
      event: 'snapshot',
      version: event.version,
    });
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
    publishRealtimeEvent({
      entityType,
      id,
      event: 'deleted',
      version: event.version,
    });
    return event;
  }

  function publishRefresh(id: string, reason?: string) {
    const event: SnapshotEvent<T> = {
      entityType,
      id,
      time: new Date().toISOString(),
      version: nextVersion(id),
      refresh: true,
      reason,
    };
    notify(id, event);
    publishRealtimeEvent({
      entityType,
      id,
      event: 'refresh',
      reason,
      version: event.version,
    });
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
    publishRefresh,
    subscribe,
  };
}
