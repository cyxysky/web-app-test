'use client';

import { useEffect, useRef } from 'react';
import {
  subscribeRealtimeRefresh,
  type RealtimeRefreshEvent,
} from '@/lib/realtime-refresh';

type BrowserChatRealtimeOptions = {
  onRefresh: (event: RealtimeRefreshEvent) => void;
  onResync: () => void | Promise<void>;
};

export function useBrowserChatRealtime({ onRefresh, onResync }: BrowserChatRealtimeOptions) {
  const versionsRef = useRef(new Map<string, number>());
  const onRefreshRef = useRef(onRefresh);
  const onResyncRef = useRef(onResync);

  onRefreshRef.current = onRefresh;
  onResyncRef.current = onResync;

  useEffect(() => subscribeRealtimeRefresh((event) => {
    if (event.entityType !== 'browserChatSession') return;
    const lastVersion = versionsRef.current.get(event.id) || 0;
    if (event.version < lastVersion) return;
    versionsRef.current.set(event.id, event.version);
    onRefreshRef.current(event);
  }, {
    onResync: () => onResyncRef.current(),
  }), []);
}
