'use client';

import { useCallback, useState } from 'react';
import { readApiJson } from '@/lib/api-client';

export type BrowserChatSessionListPage = {
  hasMore?: boolean;
  next?: { beforeId?: string; beforeUpdatedAt?: string };
};

export function useBrowserChatSessionPagination<TSession>(
  apiUrl: (path: string) => string,
  applyPage: (sessions: TSession[]) => void,
  translate: (value: string) => string,
) {
  const [page, setPage] = useState<BrowserChatSessionListPage>({});
  const [loadingMore, setLoadingMore] = useState(false);

  const initialize = useCallback((nextPage: BrowserChatSessionListPage = {}) => {
    setPage(nextPage);
  }, []);

  const loadMore = useCallback(async () => {
    const next = page.next;
    if (!page.hasMore || !next || loadingMore) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ limit: '10' });
      if (next.beforeId) params.set('beforeId', next.beforeId);
      if (next.beforeUpdatedAt) params.set('beforeUpdatedAt', next.beforeUpdatedAt);
      const response = await fetch(apiUrl(`/api/browser-chat?${params.toString()}`), { cache: 'no-store' });
      const data = await readApiJson<{ page?: BrowserChatSessionListPage; sessions?: TSession[] }>(response, translate('加载更多对话失败'));
      applyPage(Array.isArray(data.sessions) ? data.sessions : []);
      setPage(data.page || {});
    } finally {
      setLoadingMore(false);
    }
  }, [apiUrl, applyPage, loadingMore, page, translate]);

  return { initialize, loadMore, loadingMore, page };
}
