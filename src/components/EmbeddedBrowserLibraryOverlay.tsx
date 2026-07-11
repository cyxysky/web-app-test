'use client';

import { ChevronDown, Globe2, History, Search, Star, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import styles from './EmbeddedBrowserLibraryOverlay.module.css';

type LibraryPanel = 'bookmarks' | 'history';

type BookmarkItem = {
  createdAt: number;
  id: string;
  title: string;
  url: string;
};

type HistoryItem = {
  id: string;
  lastVisitedAt: number;
  title: string;
  url: string;
  visitCount: number;
};

type LibraryState = {
  bookmarks?: BookmarkItem[];
  error?: string;
  history?: HistoryItem[];
  libraryPanel?: LibraryPanel;
  ok: boolean;
};

type LibraryBridge = {
  clearHistory: () => Promise<LibraryState>;
  close: () => Promise<LibraryState>;
  getState: () => Promise<LibraryState>;
  navigate: (input: { url: string }) => Promise<{ error?: string; ok: boolean }>;
  onStateChange: (listener: (state: LibraryState) => void) => () => void;
  removeBookmark: (input: { url: string }) => Promise<LibraryState>;
};

function libraryBridge(): LibraryBridge | undefined {
  return (window as unknown as { webPilotEmbeddedBrowserLibrary?: LibraryBridge }).webPilotEmbeddedBrowserLibrary;
}

function hostnameForUrl(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return value;
  }
}

function historyTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    month: 'numeric',
    day: 'numeric',
  }).format(new Date(value));
}

export function EmbeddedBrowserLibraryOverlay() {
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>([]);
  const [error, setError] = useState('');
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [panel, setPanel] = useState<LibraryPanel>('bookmarks');
  const [query, setQuery] = useState('');
  const [searchVisible, setSearchVisible] = useState(false);

  function applyState(state: LibraryState) {
    if (!state?.ok) {
      setError(state?.error || '收藏与历史记录暂时不可用');
      return;
    }
    setError('');
    if (state.libraryPanel) setPanel(state.libraryPanel);
    setBookmarks(Array.isArray(state.bookmarks) ? state.bookmarks : []);
    setHistoryItems(Array.isArray(state.history) ? state.history : []);
  }

  useEffect(() => {
    const bridge = libraryBridge();
    if (!bridge) {
      setError('仅桌面端支持收藏与历史记录浮层');
      return undefined;
    }
    void bridge.getState().then(applyState).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : '收藏与历史记录暂时不可用');
    });
    return bridge.onStateChange(applyState);
  }, []);

  useEffect(() => {
    setQuery('');
    setSearchVisible(false);
  }, [panel]);

  useEffect(() => {
    if (searchVisible) searchInputRef.current?.focus();
  }, [searchVisible]);

  const items = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const source = panel === 'bookmarks' ? bookmarks : historyItems;
    if (!normalizedQuery) return source;
    return source.filter((item) => `${item.title}\n${item.url}`.toLocaleLowerCase().includes(normalizedQuery));
  }, [bookmarks, historyItems, panel, query]);

  async function closePanel() {
    const bridge = libraryBridge();
    if (!bridge) return;
    await bridge.close().catch(() => undefined);
  }

  async function clearHistory() {
    const bridge = libraryBridge();
    if (!bridge) return;
    const result = await bridge.clearHistory().catch((reason: unknown) => ({
      error: reason instanceof Error ? reason.message : '清空历史记录失败',
      ok: false,
    }));
    applyState(result);
  }

  async function removeBookmark(url: string) {
    const bridge = libraryBridge();
    if (!bridge) return;
    const result = await bridge.removeBookmark({ url }).catch((reason: unknown) => ({
      error: reason instanceof Error ? reason.message : '移除收藏失败',
      ok: false,
    }));
    applyState(result);
  }

  async function openUrl(url: string) {
    const bridge = libraryBridge();
    if (!bridge) return;
    const result = await bridge.navigate({ url }).catch((reason: unknown) => ({
      error: reason instanceof Error ? reason.message : '打开页面失败',
      ok: false,
    }));
    if (!result.ok) {
      setError(result.error || '打开页面失败');
      return;
    }
    await closePanel();
  }

  const total = panel === 'bookmarks' ? bookmarks.length : historyItems.length;

  return (
    <main
      className={styles.overlay}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) void closePanel();
      }}
    >
      <section className={styles.card} onMouseDown={(event) => event.stopPropagation()}>
      <header className={styles.header}>
        <strong>{panel === 'bookmarks' ? '收藏夹' : '历史记录'}</strong>
        <div className={styles.headerActions}>
          <button
            aria-label="搜索"
            className={searchVisible ? styles.activeAction : undefined}
            onClick={() => setSearchVisible((current) => !current)}
            title="搜索"
            type="button"
          >
            <Search size={18} />
          </button>
          {panel === 'history' && historyItems.length ? (
            <button aria-label="清空历史记录" onClick={() => void clearHistory()} title="清空历史记录" type="button">
              <Trash2 size={17} />
            </button>
          ) : null}
          <button aria-label="关闭" onClick={() => void closePanel()} title="关闭" type="button">
            <X size={19} />
          </button>
        </div>
      </header>

      {searchVisible ? (
        <div className={styles.searchBar}>
          <Search aria-hidden="true" size={16} />
          <input
            aria-label={panel === 'bookmarks' ? '搜索收藏夹' : '搜索历史记录'}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={panel === 'bookmarks' ? '搜索收藏夹' : '搜索历史记录'}
            ref={searchInputRef}
            value={query}
          />
          {query ? (
            <button aria-label="清除搜索" onClick={() => setQuery('')} title="清除" type="button">
              <X size={14} />
            </button>
          ) : null}
        </div>
      ) : null}

      <section className={styles.content}>
        <div className={styles.sectionHeading}>
          <ChevronDown size={15} />
          {panel === 'bookmarks' ? <Star size={16} /> : <History size={16} />}
          <strong>{panel === 'bookmarks' ? '收藏夹栏' : '最近访问'}</strong>
          <span>{total}</span>
        </div>

        {error ? <div className={styles.error}>{error}</div> : null}

        {items.length ? (
          <div className={styles.list}>
            {items.map((item) => (
              <article className={styles.item} key={item.id}>
                <button className={styles.openItem} onClick={() => void openUrl(item.url)} title={item.url} type="button">
                  <span className={styles.itemIcon} aria-hidden="true">
                    <Globe2 size={16} />
                  </span>
                  <span className={styles.itemCopy}>
                    <strong>{item.title || hostnameForUrl(item.url)}</strong>
                    <span>
                      {panel === 'history'
                        ? `${hostnameForUrl(item.url)}${historyTime((item as HistoryItem).lastVisitedAt) ? ` · ${historyTime((item as HistoryItem).lastVisitedAt)}` : ''}`
                        : hostnameForUrl(item.url)}
                    </span>
                  </span>
                </button>
                {panel === 'bookmarks' ? (
                  <button
                    aria-label="移除收藏"
                    className={styles.removeItem}
                    onClick={() => void removeBookmark(item.url)}
                    title="移除收藏"
                    type="button"
                  >
                    <X size={15} />
                  </button>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <div className={styles.empty}>
            <span aria-hidden="true">{panel === 'bookmarks' ? <Star size={24} /> : <History size={24} />}</span>
            <strong>{query ? '没有匹配结果' : panel === 'bookmarks' ? '暂无收藏' : '暂无浏览历史'}</strong>
            <p>
              {query
                ? '换一个关键词试试'
                : panel === 'bookmarks'
                  ? '点击地址栏右侧的星标保存当前页面'
                  : '访问过的页面会显示在这里'}
            </p>
          </div>
        )}
      </section>
      </section>
    </main>
  );
}
