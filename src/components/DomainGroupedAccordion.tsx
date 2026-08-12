'use client';

import { useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, Globe2, Search, X } from 'lucide-react';
import { useI18n } from '@/i18n/I18nProvider';
import {
  ALL_DOMAIN_FILTER,
  buildDomainGroups,
} from '@/components/domain-grouped-list-model';

export function DomainGroupedAccordion<T>({
  className = '',
  emptyText,
  getDomains,
  getId,
  getName,
  getSearchText,
  getUpdatedAt,
  items,
  renderItem,
  searchPlaceholder,
  toolbarActions,
  unscopedLabel,
}: {
  className?: string;
  emptyText: string;
  getDomains: (item: T) => string[];
  getId: (item: T) => string;
  getName: (item: T) => string;
  getSearchText: (item: T) => string[];
  getUpdatedAt: (item: T) => string;
  items: T[];
  renderItem: (item: T, domain: string) => ReactNode;
  searchPlaceholder: string;
  toolbarActions?: ReactNode;
  unscopedLabel: string;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [openGroupKey, setOpenGroupKey] = useState<string | null | undefined>(undefined);
  const result = useMemo(() => buildDomainGroups({
    items,
    query: deferredQuery,
    selectedDomainKey: ALL_DOMAIN_FILTER,
    sort: 'updated-desc',
    unscopedLabel,
    getDomains,
    getId,
    getName,
    getSearchText,
    getUpdatedAt,
  }), [deferredQuery, getDomains, getId, getName, getSearchText, getUpdatedAt, items, unscopedLabel]);
  const groupSignature = result.groups.map((group) => group.key).join('\u0001');

  useEffect(() => {
    setOpenGroupKey((current) => {
      if (current === null) return current;
      if (current && result.groups.some((group) => group.key === current)) return current;
      return result.groups[0]?.key;
    });
  }, [groupSignature, result.groups]);

  const effectiveOpenGroupKey = openGroupKey === undefined ? result.groups[0]?.key : openGroupKey;
  const rootClassName = `domain-grouped-list${className ? ` ${className}` : ''}`;
  return (
    <div className={rootClassName}>
      <div className="domain-list-toolbar">
        <label className="domain-list-search">
          <Search size={15} />
          <input
            aria-label={searchPlaceholder}
            className="domain-list-search-input"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchPlaceholder}
            type="search"
            value={query}
          />
          {query ? (
            <button aria-label={t('清空筛选')} onClick={() => setQuery('')} type="button"><X size={14} /></button>
          ) : null}
        </label>
        <div className="domain-list-toolbar-meta">
          <span className="domain-list-count">{t('显示 {visible} / {total} 条', { visible: result.filteredCount, total: items.length })}</span>
          {toolbarActions}
        </div>
      </div>

      {result.groups.length ? (
        <div className="domain-accordion-list">
          {result.groups.map((group) => {
            const open = effectiveOpenGroupKey === group.key;
            return (
              <section className={open ? 'domain-accordion-group open' : 'domain-accordion-group'} key={group.key}>
                <button
                  aria-expanded={open}
                  className="domain-accordion-toggle"
                  onClick={() => setOpenGroupKey(open ? null : group.key)}
                  type="button"
                >
                  <Globe2 size={15} />
                  <strong>{group.label}</strong>
                  <span>{group.items.length}</span>
                  <ChevronDown size={16} />
                </button>
                <div
                  aria-hidden={!open}
                  className="domain-accordion-content"
                  inert={!open}
                >
                  <div className="domain-accordion-content-shell">
                    <div className="domain-accordion-items">
                      {group.items.map((item) => (
                        <div className="domain-accordion-item" key={`${group.key}:${getId(item)}`}>
                          {renderItem(item, group.label)}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="empty-state">{query ? t('没有符合筛选条件的数据') : emptyText}</div>
      )}
    </div>
  );
}
