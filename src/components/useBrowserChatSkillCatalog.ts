'use client';

import { useCallback, useState } from 'react';
import type { SkillRecord } from '@/server/ai/schemas/runtime.schema';
import { readApiJson } from '@/lib/api-client';

export type BrowserChatSkillListPage = {
  hasMore?: boolean;
  next?: { beforeId?: string; beforeUpdatedAt?: string };
};

function mergeSkills(current: SkillRecord[], incoming: SkillRecord[]) {
  const byId = new Map(current.map((skill) => [skill.id, skill]));
  for (const skill of incoming) byId.set(skill.id, skill);
  return [...byId.values()];
}

export function useBrowserChatSkillCatalog(
  apiUrl: (path: string) => string,
  translate: (value: string) => string,
) {
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [page, setPage] = useState<BrowserChatSkillListPage>({});
  const [loadingMore, setLoadingMore] = useState(false);

  const initialize = useCallback((items: SkillRecord[], nextPage: BrowserChatSkillListPage = {}) => {
    setSkills(items);
    setPage(nextPage);
  }, []);

  const reload = useCallback(async () => {
    const response = await fetch(apiUrl('/api/skills?limit=50'), { cache: 'no-store' });
    const data = await readApiJson<{ page?: BrowserChatSkillListPage; skills?: SkillRecord[] }>(response, translate('加载 Skills 失败'));
    initialize(Array.isArray(data.skills) ? data.skills : [], data.page || {});
  }, [apiUrl, initialize, translate]);

  const loadMore = useCallback(async () => {
    const next = page.next;
    if (!page.hasMore || !next || loadingMore) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (next.beforeId) params.set('beforeId', next.beforeId);
      if (next.beforeUpdatedAt) params.set('beforeUpdatedAt', next.beforeUpdatedAt);
      const response = await fetch(apiUrl(`/api/skills?${params.toString()}`), { cache: 'no-store' });
      const data = await readApiJson<{ page?: BrowserChatSkillListPage; skills?: SkillRecord[] }>(response, translate('加载更多 Skills 失败'));
      const incoming = Array.isArray(data.skills) ? data.skills : [];
      setSkills((current) => mergeSkills(current, incoming));
      setPage(data.page || {});
    } finally {
      setLoadingMore(false);
    }
  }, [apiUrl, loadingMore, page, translate]);

  const search = useCallback(async (query: string) => {
    const normalized = query.trim();
    if (!normalized) return;
    const params = new URLSearchParams({ limit: '50', q: normalized });
    const response = await fetch(apiUrl(`/api/skills?${params.toString()}`), { cache: 'no-store' });
    const data = await readApiJson<{ skills?: SkillRecord[] }>(response, translate('搜索 Skills 失败'));
    const incoming = Array.isArray(data.skills) ? data.skills : [];
    setSkills((current) => mergeSkills(current, incoming));
  }, [apiUrl, translate]);

  return {
    initialize,
    loadMore,
    loadingMore,
    page,
    reload,
    search,
    skills,
  };
}
