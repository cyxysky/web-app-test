'use client';

import { Search, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  type Ref,
  type UIEventHandler,
} from 'react';
import type { Language } from '@/i18n/language';
import {
  groupWorkspaceSidebarArchive,
  type WorkspaceSidebarArchiveItem,
} from '@/lib/workspace-sidebar-archive';

type WorkspaceSidebarArchiveHeaderProps = {
  actions?: ReactNode;
  children: ReactNode;
};

export function WorkspaceSidebarArchiveHeader({ actions, children }: WorkspaceSidebarArchiveHeaderProps) {
  return (
    <div className="browser-chat-recent-header workspace-sidebar-archive-header">
      <div className="workspace-sidebar-archive-header-filter">{children}</div>
      {actions ? <div className="browser-chat-recent-header-actions">{actions}</div> : null}
    </div>
  );
}

type WorkspaceSidebarArchiveFilterProps = {
  ariaLabel: string;
  clearLabel: string;
  clearTitle: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
};

export function WorkspaceSidebarArchiveFilter({
  ariaLabel,
  clearLabel,
  clearTitle,
  disabled = false,
  onChange,
  placeholder,
  value,
}: WorkspaceSidebarArchiveFilterProps) {
  return (
    <label className="domain-list-search browser-chat-history-filter workspace-sidebar-archive-filter">
      <Search aria-hidden="true" size={16} />
      <input
        aria-label={ariaLabel}
        className="domain-list-search-input"
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={placeholder}
        type="search"
        value={value}
      />
      {value ? (
        <button aria-label={clearLabel} onClick={() => onChange('')} title={clearTitle} type="button">
          <X aria-hidden="true" size={14} />
        </button>
      ) : null}
    </label>
  );
}

type WorkspaceSidebarArchiveListProps<T extends WorkspaceSidebarArchiveItem> = {
  ariaBusy?: boolean;
  footer?: ReactNode;
  getKey: (item: T) => string;
  items: readonly T[];
  language: Language;
  listRef?: Ref<HTMLOListElement>;
  onScroll?: UIEventHandler<HTMLOListElement>;
  renderItem: (item: T) => ReactNode;
};

export function WorkspaceSidebarArchiveList<T extends WorkspaceSidebarArchiveItem>({
  ariaBusy,
  footer,
  getKey,
  items,
  language,
  listRef,
  onScroll,
  renderItem,
}: WorkspaceSidebarArchiveListProps<T>) {
  const groups = useMemo(() => groupWorkspaceSidebarArchive(items, language), [items, language]);
  const hasFooter = Boolean(footer);
  const internalListRef = useRef<HTMLOListElement | null>(null);
  const syncScrollShadows = useCallback((list: HTMLOListElement) => {
    const stage = list.closest<HTMLElement>('.browser-chat-history-stage');
    if (!stage) return;
    const remaining = list.scrollHeight - list.scrollTop - list.clientHeight;
    const scrollable = list.scrollHeight - list.clientHeight > 1;
    stage.toggleAttribute('data-scroll-shadow-top', scrollable && list.scrollTop > 1);
    stage.toggleAttribute('data-scroll-shadow-bottom', scrollable && remaining > 1);
  }, []);
  const assignListRef = useCallback((node: HTMLOListElement | null) => {
    internalListRef.current = node;
    if (typeof listRef === 'function') {
      listRef(node);
    } else if (listRef) {
      (listRef as { current: HTMLOListElement | null }).current = node;
    }
  }, [listRef]);
  const handleScroll = useCallback<UIEventHandler<HTMLOListElement>>((event) => {
    syncScrollShadows(event.currentTarget);
    onScroll?.(event);
  }, [onScroll, syncScrollShadows]);

  useEffect(() => {
    const list = internalListRef.current;
    if (!list) return;
    const frame = window.requestAnimationFrame(() => syncScrollShadows(list));
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => syncScrollShadows(list));
    observer?.observe(list);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [groups.length, hasFooter, items.length, syncScrollShadows]);

  return (
    <ol
      aria-busy={ariaBusy}
      className="browser-chat-recent-list workspace-sidebar-archive-list"
      onScroll={handleScroll}
      ref={assignListRef}
    >
      {groups.map((group) => (
        <li className="browser-chat-history-date-group workspace-sidebar-archive-date-group" key={group.key}>
          <time
            aria-label={group.ariaLabel}
            className="browser-chat-history-date-label workspace-sidebar-archive-date-label"
            dateTime={group.key === 'unknown' ? undefined : group.key}
          >
            <strong>{group.day}</strong>
            <span>{group.month}</span>
          </time>
          <ol
            aria-label={group.ariaLabel}
            className="browser-chat-history-date-items workspace-sidebar-archive-date-items"
          >
            {group.items.map((item) => <li key={getKey(item)}>{renderItem(item)}</li>)}
          </ol>
        </li>
      ))}
      {footer}
    </ol>
  );
}

export type WorkspaceSidebarArchiveTone = 'accent' | 'enabled' | 'muted' | 'running';

type WorkspaceSidebarArchiveRowProps = {
  active?: boolean;
  ariaLabel: string;
  collapsed: boolean;
  collapsedAction?: ReactNode;
  collapsedIcon: ReactNode;
  disabled?: boolean;
  expandedAction?: ReactNode;
  expandedIcon?: ReactNode;
  id?: string;
  iconTone?: WorkspaceSidebarArchiveTone;
  onOpen: () => void;
  selecting?: boolean;
  selectionControl?: ReactNode;
  title: string;
  titleAttribute?: string;
};

export function WorkspaceSidebarArchiveRow({
  active = false,
  ariaLabel,
  collapsed,
  collapsedAction,
  collapsedIcon,
  disabled = false,
  expandedAction,
  expandedIcon,
  id,
  iconTone = 'muted',
  onOpen,
  selecting = false,
  selectionControl,
  title,
  titleAttribute = title,
}: WorkspaceSidebarArchiveRowProps) {
  const rowClassName = [
    'workspace-sidebar-archive-row',
    active ? 'active' : '',
    selecting ? 'selecting' : '',
  ].filter(Boolean).join(' ');
  const visibleIcon = collapsed ? collapsedIcon : expandedIcon;
  const visibleAction = collapsed ? collapsedAction : expandedAction;

  return (
    <div className={rowClassName} id={id}>
      {selectionControl ? (
        <span className="workspace-sidebar-archive-row-selection">{selectionControl}</span>
      ) : null}
      <button
        aria-current={active ? 'true' : undefined}
        aria-label={ariaLabel}
        className="workspace-sidebar-archive-row-open"
        disabled={disabled}
        onClick={onOpen}
        title={titleAttribute}
        type="button"
      >
        {visibleIcon ? (
          <span
            aria-hidden="true"
            className={`workspace-sidebar-archive-row-icon is-${iconTone}`}
          >
            {visibleIcon}
          </span>
        ) : null}
        <span className="workspace-sidebar-archive-row-title">{title}</span>
      </button>
      {visibleAction ? (
        <span className="workspace-sidebar-archive-row-action">{visibleAction}</span>
      ) : null}
    </div>
  );
}
