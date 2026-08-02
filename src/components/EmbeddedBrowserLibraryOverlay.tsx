'use client';

import { ChevronDown, Globe2, History, Search, Star, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import styles from './EmbeddedBrowserLibraryOverlay.module.css';

type BookmarkItem = {
  createdAt: number;
  faviconUrl?: string;
  id: string;
  title: string;
  url: string;
};

type HistoryItem = {
  faviconUrl?: string;
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
  libraryPanel?: 'library';
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

function historyTime(value: number, locale: string): string {
  if (!Number.isFinite(value) || value <= 0) return '';
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    month: 'numeric',
    day: 'numeric',
  }).format(new Date(value));
}

function defaultFaviconUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? new URL('/favicon.ico', url.origin).toString() : '';
  } catch {
    return '';
  }
}

function LibraryFavicon({ faviconUrl, pageUrl }: { faviconUrl?: string; pageUrl: string }) {
  const [failed, setFailed] = useState(false);
  const source = faviconUrl || defaultFaviconUrl(pageUrl);

  useEffect(() => {
    setFailed(false);
  }, [source]);

  if (!source || failed) return <Globe2 size={16} />;
  return (
    <img
      alt=""
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
      referrerPolicy="no-referrer"
      src={source}
    />
  );
}

export function EmbeddedBrowserLibraryOverlay() {
  const { language, t } = useI18n();
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>([]);
  const [bookmarksExpanded, setBookmarksExpanded] = useState(true);
  const [error, setError] = useState('');
  const [historyExpanded, setHistoryExpanded] = useState(true);
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [query, setQuery] = useState('');
  const [searchVisible, setSearchVisible] = useState(false);

  function applyState(state: LibraryState) {
    if (!state?.ok) {
      setError(state?.error || '收藏与历史记录暂时不可用');
      return;
    }
    setError('');
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
    if (searchVisible) searchInputRef.current?.focus();
  }, [searchVisible]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredBookmarks = useMemo(() => {
    if (!normalizedQuery) return bookmarks;
    return bookmarks.filter((item) => `${item.title}\n${item.url}`.toLocaleLowerCase().includes(normalizedQuery));
  }, [bookmarks, normalizedQuery]);
  const filteredHistory = useMemo(() => {
    if (!normalizedQuery) return historyItems;
    return historyItems.filter((item) => `${item.title}\n${item.url}`.toLocaleLowerCase().includes(normalizedQuery));
  }, [historyItems, normalizedQuery]);

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

  return (
    <main
      className={styles.overlay}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) void closePanel();
      }}
    >
      <section className={styles.card} onMouseDown={(event) => event.stopPropagation()}>
        <header className={styles.header}>
          <strong>{t('收藏与历史记录')}</strong>
          <div className={styles.headerActions}>
            <button
              aria-label={t('搜索')}
              className={searchVisible ? styles.activeAction : undefined}
              onClick={() => setSearchVisible((current) => !current)}
              title={t('搜索')}
              type="button"
            >
              <Search size={18} />
            </button>
            {historyItems.length ? (
              <button aria-label={t('清空历史记录')} onClick={() => void clearHistory()} title={t('清空历史记录')} type="button">
                <Trash2 size={17} />
              </button>
            ) : null}
            <button aria-label={t('关闭')} onClick={() => void closePanel()} title={t('关闭')} type="button">
              <X size={19} />
            </button>
          </div>
        </header>

        {searchVisible ? (
          <div className={styles.searchBar}>
            <Search aria-hidden="true" size={16} />
            <input
              aria-label={t('搜索收藏与历史记录')}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder={t('搜索收藏与历史记录')}
              ref={searchInputRef}
              value={query}
            />
            {query ? (
              <button aria-label={t('清除搜索')} onClick={() => setQuery('')} title={t('清除')} type="button">
                <X size={14} />
              </button>
            ) : null}
          </div>
        ) : null}

        <section className={`${styles.content} ${styles.combinedContent}`}>
          {error ? <div className={styles.error}>{t(error)}</div> : null}

          <section className={styles.librarySection}>
            <button
              aria-expanded={bookmarksExpanded}
              className={styles.sectionHeading}
              onClick={() => setBookmarksExpanded((current) => !current)}
              type="button"
            >
              <ChevronDown className={bookmarksExpanded ? styles.expandedChevron : undefined} size={15} />
              <Star size={16} />
              <strong>{t('收藏夹')}</strong>
              <span>{bookmarks.length}</span>
            </button>

            {bookmarksExpanded && filteredBookmarks.length ? (
              <div className={styles.list}>
                {filteredBookmarks.map((item) => (
                  <article className={styles.item} key={item.id}>
                    <button className={styles.openItem} onClick={() => void openUrl(item.url)} title={item.url} type="button">
                      <span className={styles.itemIcon} aria-hidden="true">
                        <LibraryFavicon faviconUrl={item.faviconUrl} pageUrl={item.url} />
                      </span>
                      <span className={styles.itemCopy}>
                        <strong>{item.title || hostnameForUrl(item.url)}</strong>
                        <span>{hostnameForUrl(item.url)}</span>
                      </span>
                    </button>
                    <button aria-label={t('移除收藏')} className={styles.removeItem} onClick={() => void removeBookmark(item.url)} title={t('移除收藏')} type="button">
                      <X size={15} />
                    </button>
                  </article>
                ))}
              </div>
            ) : bookmarksExpanded ? (
              <div className={styles.sectionEmpty}>
                <Star size={18} />
                <span>{query ? t('没有匹配的收藏') : t('暂无收藏')}</span>
              </div>
            ) : null}
          </section>

          <section className={styles.librarySection}>
            <button
              aria-expanded={historyExpanded}
              className={styles.sectionHeading}
              onClick={() => setHistoryExpanded((current) => !current)}
              type="button"
            >
              <ChevronDown className={historyExpanded ? styles.expandedChevron : undefined} size={15} />
              <History size={16} />
              <strong>{t('最近访问')}</strong>
              <span>{historyItems.length}</span>
            </button>

            {historyExpanded && filteredHistory.length ? (
              <div className={styles.list}>
                {filteredHistory.map((item) => {
                  const visitedAt = historyTime(item.lastVisitedAt, language === 'en' ? 'en-US' : 'zh-CN');
                  return (
                    <article className={styles.item} key={item.id}>
                      <button className={styles.openItem} onClick={() => void openUrl(item.url)} title={item.url} type="button">
                        <span className={styles.itemIcon} aria-hidden="true">
                          <LibraryFavicon faviconUrl={item.faviconUrl} pageUrl={item.url} />
                        </span>
                        <span className={styles.itemCopy}>
                          <strong>{item.title || hostnameForUrl(item.url)}</strong>
                          <span>{`${hostnameForUrl(item.url)}${visitedAt ? ` · ${visitedAt}` : ''}`}</span>
                        </span>
                      </button>
                    </article>
                  );
                })}
              </div>
            ) : historyExpanded ? (
              <div className={styles.sectionEmpty}>
                <History size={18} />
                <span>{query ? t('没有匹配的历史记录') : t('暂无浏览历史')}</span>
              </div>
            ) : null}
          </section>
        </section>
      </section>
    </main>
  );
}
