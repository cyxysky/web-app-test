'use client';

import { startTransition, useEffect, useRef } from 'react';
import {
  subscribeRealtimeRefresh,
  type RealtimeRefreshEvent,
} from '@/lib/realtime-refresh';

type BrowserChatRealtimeOptions = {
  onRefresh: (events: readonly RealtimeRefreshEvent[]) => void;
  onResync: () => void | Promise<void>;
};

const realtimeEventsPerFrame = 24;

export function useBrowserChatRealtime({ onRefresh, onResync }: BrowserChatRealtimeOptions) {
  const versionsRef = useRef(new Map<string, number>());
  const onRefreshRef = useRef(onRefresh);
  const onResyncRef = useRef(onResync);

  onRefreshRef.current = onRefresh;
  onResyncRef.current = onResync;

  useEffect(() => {
    const pending: RealtimeRefreshEvent[] = [];
    let frame: number | undefined;
    const flush = () => {
      frame = undefined;
      if (!pending.length) return;
      const events = pending.splice(0, realtimeEventsPerFrame);
      startTransition(() => onRefreshRef.current(events));
      if (pending.length) frame = window.requestAnimationFrame(flush);
    };
    const unsubscribe = subscribeRealtimeRefresh((event) => {
      if (event.entityType !== 'browserChatSession') return;
      const lastVersion = versionsRef.current.get(event.id) || 0;
      if (event.version <= lastVersion) return;
      versionsRef.current.set(event.id, event.version);
      pending.push(event);
      if (frame === undefined) frame = window.requestAnimationFrame(flush);
    }, {
      onResync: () => onResyncRef.current(),
    });
    return () => {
      unsubscribe();
      pending.length = 0;
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, []);
}
