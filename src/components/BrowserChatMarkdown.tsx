'use client';

import {
  createContext,
  memo,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { BrowserChatChart } from '@/components/BrowserChatChart';
import { BrowserChatDataUI } from '@/components/BrowserChatDataUI';
import {
  normalizeBrowserChatMarkdown,
  remarkBrowserChatCjkStrong,
  splitBrowserChatChartBlocks,
} from '@/components/browser-chat-markdown';
import { normalizeEmbeddedBrowserAddress } from '@/components/browser-chat-embedded-url';
import type { BrowserChatUIMessagePart } from '@/lib/browser-chat-ui-message';

const BROWSER_CHAT_DOWNLOAD_EXTENSIONS = new Set([
  '.7z',
  '.apk',
  '.bin',
  '.bz2',
  '.csv',
  '.deb',
  '.dmg',
  '.doc',
  '.docx',
  '.exe',
  '.gz',
  '.ipa',
  '.msi',
  '.pkg',
  '.ppt',
  '.pptx',
  '.rar',
  '.rpm',
  '.tar',
  '.tgz',
  '.xls',
  '.xlsx',
  '.xz',
  '.zip',
]);

function normalizeBrowserChatMarkdownHref(href: string) {
  const trimmed = href.trim();
  if (!trimmed) return '';
  if (/^[./?#/]/.test(trimmed)) {
    try {
      return new URL(trimmed, typeof window === 'undefined' ? 'http://127.0.0.1/' : window.location.href).toString();
    } catch {
      return '';
    }
  }
  return normalizeEmbeddedBrowserAddress(trimmed);
}

function isBrowserChatDownloadHref(href: string) {
  const normalizedHref = normalizeBrowserChatMarkdownHref(href);
  if (!normalizedHref) return false;
  try {
    const parsed = new URL(normalizedHref);
    const downloadValue = parsed.searchParams.get('download');
    if (downloadValue !== null && !/^(0|false|no)$/i.test(downloadValue)) return true;
    const attachmentValue = [
      parsed.searchParams.get('content-disposition'),
      parsed.searchParams.get('response-content-disposition'),
    ].filter(Boolean).join(' ').toLowerCase();
    if (attachmentValue.includes('attachment')) return true;
    const pathname = decodeURIComponent(parsed.pathname || '').toLowerCase();
    const extension = pathname.match(/\.([a-z0-9]{1,8})$/)?.[0] || '';
    return BROWSER_CHAT_DOWNLOAD_EXTENSIONS.has(extension);
  } catch {
    return false;
  }
}

export function handleBrowserChatMarkdownLinkClick(event: ReactMouseEvent<HTMLAnchorElement>, href?: string) {
  const rawHref = String(href || '').trim();
  if (!rawHref || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (rawHref.startsWith('#') || /^(javascript|mailto|tel):/i.test(rawHref)) return;
  const url = normalizeBrowserChatMarkdownHref(rawHref);
  if (!url) return;
  if (isBrowserChatDownloadHref(rawHref)) {
    const systemBridge = typeof window === 'undefined' ? undefined : window.webPilotSystem;
    if (!systemBridge?.downloadUrl) return;
    event.preventDefault();
    systemBridge.downloadUrl({ url }).catch(() => undefined);
    return;
  }
  const bridge = typeof window === 'undefined' ? undefined : window.webPilotEmbeddedBrowser;
  if (!bridge) return;
  event.preventDefault();
  bridge.createTab({ url }).catch(() => undefined);
}

function BrowserChatMarkdownTable({ children }: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const contentScrollRef = useRef<HTMLDivElement | null>(null);
  const stickyHeaderRef = useRef<HTMLDivElement | null>(null);
  const stickyScrollbarRef = useRef<HTMLDivElement | null>(null);
  const stickyScrollbarContentRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const contentScroll = contentScrollRef.current;
    const stickyHeader = stickyHeaderRef.current;
    const stickyScrollbar = stickyScrollbarRef.current;
    const stickyScrollbarContent = stickyScrollbarContentRef.current;
    const contentTable = contentScroll?.querySelector<HTMLTableElement>('.table__content');
    const messageList = root?.closest('.browser-chat-message-list') as HTMLElement | null;
    if (!root || !contentScroll || !contentTable || !stickyHeader || !stickyScrollbar || !stickyScrollbarContent || !messageList) {
      return undefined;
    }

    let frame = 0;
    let synchronizingScroll = false;

    const syncStickyHeader = () => {
      const sourceHeader = contentTable.querySelector<HTMLTableSectionElement>('.table__header');
      if (!sourceHeader) {
        stickyHeader.replaceChildren();
        return;
      }
      const clonedTable = contentTable.cloneNode(false) as HTMLTableElement;
      const clonedHeader = sourceHeader.cloneNode(true) as HTMLTableSectionElement;
      clonedTable.setAttribute('aria-hidden', 'true');
      clonedTable.append(clonedHeader);
      clonedTable.style.width = `${contentTable.offsetWidth}px`;
      clonedTable.style.minWidth = `${contentTable.offsetWidth}px`;
      const sourceColumns = sourceHeader.querySelectorAll<HTMLElement>('.table__column');
      const clonedColumns = clonedHeader.querySelectorAll<HTMLElement>('.table__column');
      sourceColumns.forEach((column, index) => {
        const clonedColumn = clonedColumns[index];
        if (!clonedColumn) return;
        const width = column.getBoundingClientRect().width;
        clonedColumn.style.maxWidth = `${width}px`;
        clonedColumn.style.minWidth = `${width}px`;
        clonedColumn.style.width = `${width}px`;
      });
      stickyHeader.replaceChildren(clonedTable);
    };

    const syncHorizontalPosition = (scrollLeft: number) => {
      const clonedTable = stickyHeader.querySelector<HTMLTableElement>('.table__content');
      if (clonedTable) clonedTable.style.transform = `translateX(${-scrollLeft}px)`;
    };

    const updateFloatingElements = () => {
      frame = 0;
      const messageListRect = messageList.getBoundingClientRect();
      const contentRect = contentScroll.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      const viewportTop = messageListRect.top + messageList.clientTop;
      const viewportBottom = viewportTop + messageList.clientHeight;
      const viewportLeft = messageListRect.left + messageList.clientLeft;
      const viewportRight = viewportLeft + messageList.clientWidth;
      const visibleLeft = Math.max(contentRect.left, viewportLeft);
      const visibleRight = Math.min(contentRect.right, viewportRight);
      const visibleWidth = Math.max(0, visibleRight - visibleLeft);
      const sourceHeader = contentTable.querySelector<HTMLElement>('.table__header');
      const headerHeight = sourceHeader?.getBoundingClientRect().height || 0;
      const headerVisible = Boolean(
        headerHeight
        && visibleWidth
        && rootRect.top < viewportTop
        && rootRect.bottom > viewportTop + headerHeight,
      );
      stickyHeader.classList.toggle('is-visible', headerVisible);
      stickyHeader.style.left = `${visibleLeft}px`;
      stickyHeader.style.top = `${viewportTop}px`;
      stickyHeader.style.width = `${visibleWidth}px`;
      syncHorizontalPosition(contentScroll.scrollLeft);

      const horizontallyScrollable = contentScroll.scrollWidth > contentScroll.clientWidth + 1;
      const scrollbarHeight = Math.max(12, stickyScrollbar.offsetHeight);
      const scrollbarVisible = Boolean(
        horizontallyScrollable
        && visibleWidth
        && rootRect.top < viewportBottom - scrollbarHeight
        && rootRect.bottom > viewportBottom,
      );
      stickyScrollbar.classList.toggle('is-visible', scrollbarVisible);
      stickyScrollbar.style.left = `${visibleLeft}px`;
      stickyScrollbar.style.top = `${viewportBottom - scrollbarHeight}px`;
      stickyScrollbar.style.width = `${visibleWidth}px`;
      stickyScrollbarContent.style.width = `${contentScroll.scrollWidth}px`;
      if (!synchronizingScroll && stickyScrollbar.scrollLeft !== contentScroll.scrollLeft) {
        stickyScrollbar.scrollLeft = contentScroll.scrollLeft;
      }
    };

    const scheduleUpdate = () => {
      if (frame) return;
      frame = requestAnimationFrame(updateFloatingElements);
    };

    const handleContentScroll = () => {
      if (!synchronizingScroll) {
        synchronizingScroll = true;
        stickyScrollbar.scrollLeft = contentScroll.scrollLeft;
        synchronizingScroll = false;
      }
      syncHorizontalPosition(contentScroll.scrollLeft);
    };

    const handleStickyScrollbarScroll = () => {
      if (synchronizingScroll) return;
      synchronizingScroll = true;
      contentScroll.scrollLeft = stickyScrollbar.scrollLeft;
      syncHorizontalPosition(stickyScrollbar.scrollLeft);
      synchronizingScroll = false;
    };

    const refreshLayout = () => {
      syncStickyHeader();
      scheduleUpdate();
    };

    const resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(refreshLayout)
      : undefined;
    resizeObserver?.observe(root);
    resizeObserver?.observe(contentScroll);
    resizeObserver?.observe(contentTable);
    resizeObserver?.observe(messageList);
    const mutationObserver = new MutationObserver(refreshLayout);
    mutationObserver.observe(contentTable, { characterData: true, childList: true, subtree: true });
    contentScroll.addEventListener('scroll', handleContentScroll, { passive: true });
    stickyScrollbar.addEventListener('scroll', handleStickyScrollbarScroll, { passive: true });
    messageList.addEventListener('scroll', scheduleUpdate, { passive: true });
    window.addEventListener('resize', refreshLayout);
    window.addEventListener('scroll', scheduleUpdate, true);
    refreshLayout();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
      contentScroll.removeEventListener('scroll', handleContentScroll);
      stickyScrollbar.removeEventListener('scroll', handleStickyScrollbarScroll);
      messageList.removeEventListener('scroll', scheduleUpdate);
      window.removeEventListener('resize', refreshLayout);
      window.removeEventListener('scroll', scheduleUpdate, true);
      stickyHeader.replaceChildren();
    };
  }, [children]);

  return (
    <div className="browser-chat-markdown-table-scroll table-root table-root--primary" ref={rootRef}>
      <div aria-hidden="true" className="browser-chat-markdown-table-sticky-header" ref={stickyHeaderRef} />
      <div className="table__scroll-container" ref={contentScrollRef}>
        <table className="table__content">{children}</table>
      </div>
      <div aria-hidden="true" className="browser-chat-markdown-table-sticky-scrollbar" ref={stickyScrollbarRef}>
        <div ref={stickyScrollbarContentRef} />
      </div>
    </div>
  );
}

export const BrowserChatSessionIdContext = createContext<string | undefined>(undefined);
export const BrowserChatAutomationRunIdContext = createContext<string | undefined>(undefined);

export const BrowserChatMarkdown = memo(function BrowserChatMarkdown({ markdown }: { markdown: string }) {
  const sessionId = useContext(BrowserChatSessionIdContext);
  const automationRunId = useContext(BrowserChatAutomationRunIdContext);
  const normalizedMarkdown = useMemo(() => normalizeBrowserChatMarkdown(markdown), [markdown]);
  const blocks = useMemo(() => splitBrowserChatChartBlocks(normalizedMarkdown), [normalizedMarkdown]);
  return (
    <div className="browser-chat-agent-markdown">
      {blocks.map((block, index) => block.kind === 'chart' ? (
        <BrowserChatChart chartId={block.chartId} key={`${block.chartId}:${index}`} sessionId={sessionId} automationRunId={automationRunId} />
      ) : (
        <ReactMarkdown
          key={`markdown:${index}`}
          rehypePlugins={[rehypeKatex]}
          remarkPlugins={[remarkGfm, remarkMath, remarkBrowserChatCjkStrong]}
          components={{
            a: ({ href, onClick, ...props }) => (
              <a
                {...props}
                href={href}
                onClick={(event) => {
                  onClick?.(event);
                  handleBrowserChatMarkdownLinkClick(event, href);
                }}
                target="_blank"
                rel="noopener noreferrer"
              />
            ),
            table: ({ children }) => <BrowserChatMarkdownTable>{children}</BrowserChatMarkdownTable>,
            thead: ({ children }) => <thead className="table__header">{children}</thead>,
            tbody: ({ children }) => <tbody className="table__body">{children}</tbody>,
            tr: ({ children }) => <tr className="table__row">{children}</tr>,
            th: ({ children }) => <th className="table__column">{children}</th>,
            td: ({ children }) => <td className="table__cell">{children}</td>,
          }}
        >
          {block.markdown}
        </ReactMarkdown>
      ))}
    </div>
  );
});

export const BrowserChatOrderedResponse = memo(function BrowserChatOrderedResponse({
  fallbackText,
  parts,
}: {
  fallbackText: string;
  parts?: BrowserChatUIMessagePart[];
}) {
  const sessionId = useContext(BrowserChatSessionIdContext);
  const automationRunId = useContext(BrowserChatAutomationRunIdContext);
  const responseParts = (parts || []).filter((part) => (
    part.type === 'text' || part.type === 'data-chart' || part.type === 'data-ui'
  ));
  if (!responseParts.length) return fallbackText.trim() ? <BrowserChatMarkdown markdown={fallbackText} /> : null;
  return <div className="browser-chat-ordered-response">{responseParts.map((part, index) => {
    if (part.type === 'text') return <BrowserChatMarkdown key={`text:${index}`} markdown={part.text} />;
    if (part.type === 'data-chart') {
      return <BrowserChatChart chartId={part.data.chartId} key={part.id || `${part.data.chartId}:${index}`} sessionId={sessionId} automationRunId={automationRunId} />;
    }
    if (part.type === 'data-ui') {
      return <BrowserChatDataUI
        key={part.id || `ui:${index}`}
        renderMarkdown={(markdown) => <BrowserChatMarkdown markdown={markdown} />}
        tree={part.data.tree}
      />;
    }
    return null;
  })}</div>;
});

