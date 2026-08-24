'use client';

import { ChevronDown, Search, X } from 'lucide-react';
import {
  useCallback,
  useMemo,
  useState,
  type ReactNode,
  type Ref,
  type UIEventHandler,
} from 'react';
import type { Language } from '@/i18n/language';
import { groupWorkspaceHistory } from '@/lib/workspace-history';

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

type WorkspaceHistoryListProps<T> = {
  ariaBusy?: boolean;
  className?: string;
  compactGroupHeaders?: boolean;
  footer?: ReactNode;
  getKey: (item: T) => string;
  getTimestamp?: (item: T) => string | undefined;
  items: readonly T[];
  language: Language;
  listRef?: Ref<HTMLOListElement>;
  onScroll?: UIEventHandler<HTMLOListElement>;
  renderItem: (item: T) => ReactNode;
};

function compactWorkspaceHistoryLabel(key: string, language: Language) {
  if (key === 'unknown') return language === 'en' ? 'Unknown date' : '未知日期';
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const dayOffset = Math.round((startOfToday.getTime() - date.getTime()) / 86_400_000);
  const dateLabel = language === 'en'
    ? new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short' }).format(date)
    : `${month}月${day}日`;
  if (dayOffset === 0) return language === 'en' ? `Today, ${dateLabel}` : `今天，${dateLabel}`;
  if (dayOffset === 1) return language === 'en' ? `Yesterday, ${dateLabel}` : `昨天，${dateLabel}`;
  return dateLabel;
}

export function WorkspaceHistoryList<T>({
  ariaBusy,
  className = '',
  compactGroupHeaders = false,
  footer,
  getKey,
  getTimestamp,
  items,
  language,
  listRef,
  onScroll,
  renderItem,
}: WorkspaceHistoryListProps<T>) {
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<Set<string>>(() => new Set());
  const groups = useMemo(
    () => groupWorkspaceHistory(items, language, getTimestamp),
    [getTimestamp, items, language],
  );
  const assignListRef = useCallback((node: HTMLOListElement | null) => {
    if (typeof listRef === 'function') {
      listRef(node);
    } else if (listRef) {
      (listRef as { current: HTMLOListElement | null }).current = node;
    }
  }, [listRef]);

  return (
    <ol
      aria-busy={ariaBusy}
      className={`workspace-history-list${className ? ` ${className}` : ''}`}
      onScroll={onScroll}
      ref={assignListRef}
    >
      {groups.map((group) => {
        const collapsed = compactGroupHeaders && collapsedGroupKeys.has(group.key);
        return (
          <li className="browser-chat-history-date-group workspace-sidebar-archive-date-group" key={group.key}>
            {compactGroupHeaders ? (
              <button
                aria-expanded={!collapsed}
                className="workspace-sidebar-archive-date-toggle"
                onClick={() => setCollapsedGroupKeys((current) => {
                  const next = new Set(current);
                  if (next.has(group.key)) next.delete(group.key);
                  else next.add(group.key);
                  return next;
                })}
                type="button"
              >
                <span aria-hidden="true" className="workspace-sidebar-archive-date-chevron">
                  <ChevronDown className={collapsed ? 'is-collapsed' : undefined} size={12} />
                </span>
                <time
                  aria-label={group.ariaLabel}
                  dateTime={group.key === 'unknown' ? undefined : group.key}
                >
                  {compactWorkspaceHistoryLabel(group.key, language)}
                </time>
                <span className="workspace-sidebar-archive-date-count">{group.items.length}</span>
              </button>
            ) : (
              <time
                aria-label={group.ariaLabel}
                className="browser-chat-history-date-label workspace-sidebar-archive-date-label"
                dateTime={group.key === 'unknown' ? undefined : group.key}
              >
                <strong>{group.day}</strong>
                <span>{group.month}</span>
              </time>
            )}
            <div
              aria-hidden={collapsed}
              className={`workspace-sidebar-archive-date-body${collapsed ? ' is-collapsed' : ''}`}
              inert={collapsed ? true : undefined}
            >
              <ol
                aria-label={group.ariaLabel}
                className="browser-chat-history-date-items workspace-sidebar-archive-date-items"
              >
                {group.items.map((item) => <li key={getKey(item)}>{renderItem(item)}</li>)}
              </ol>
            </div>
          </li>
        );
      })}
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
  meta?: ReactNode;
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
  meta,
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
        {meta ? <span className="workspace-sidebar-archive-row-meta">{meta}</span> : null}
      </button>
      {visibleAction ? (
        <span className="workspace-sidebar-archive-row-action">{visibleAction}</span>
      ) : null}
    </div>
  );
}
