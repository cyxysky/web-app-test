'use client';

import { Search, X } from 'lucide-react';
import {
  useCallback,
  useMemo,
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
  footer?: ReactNode;
  getKey: (item: T) => string;
  getTimestamp?: (item: T) => string | undefined;
  items: readonly T[];
  language: Language;
  listRef?: Ref<HTMLOListElement>;
  onScroll?: UIEventHandler<HTMLOListElement>;
  renderItem: (item: T) => ReactNode;
};

export function WorkspaceHistoryList<T>({
  ariaBusy,
  className = '',
  footer,
  getKey,
  getTimestamp,
  items,
  language,
  listRef,
  onScroll,
  renderItem,
}: WorkspaceHistoryListProps<T>) {
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
