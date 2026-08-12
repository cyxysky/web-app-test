'use client';

import { Fragment, useDeferredValue, useMemo, useState, type ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import { useI18n } from '@/i18n/I18nProvider';

export type ManagementDataTableColumn<T> = {
  className?: string;
  key: string;
  label: string;
  render: (item: T) => ReactNode;
};

export function ManagementDataTable<T>({
  columns,
  emptyText,
  getId,
  getSearchText,
  items,
  renderExpandedRow,
  rowClassName,
  searchPlaceholder,
  toolbarActions,
}: {
  columns: ManagementDataTableColumn<T>[];
  emptyText: string;
  getId: (item: T) => string;
  getSearchText: (item: T) => string[];
  items: T[];
  renderExpandedRow?: (item: T) => ReactNode;
  rowClassName?: (item: T) => string;
  searchPlaceholder: string;
  toolbarActions?: ReactNode;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const filteredItems = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLocaleLowerCase();
    if (!normalizedQuery) return items;
    return items.filter((item) => getSearchText(item)
      .join('\n')
      .toLocaleLowerCase()
      .includes(normalizedQuery));
  }, [deferredQuery, getSearchText, items]);

  return (
    <div className="management-data-table">
      <div className="domain-list-toolbar management-data-table-toolbar">
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
          <span className="domain-list-count">{t('显示 {visible} / {total} 条', { visible: filteredItems.length, total: items.length })}</span>
          {toolbarActions}
        </div>
      </div>

      <div className="management-data-table-scroll">
        <table>
          <thead>
            <tr>
              {columns.map((column) => <th className={column.className} key={column.key} scope="col">{column.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {filteredItems.length ? filteredItems.map((item) => {
              const expandedRow = renderExpandedRow?.(item);
              return (
                <Fragment key={getId(item)}>
                  <tr className={rowClassName?.(item)}>
                    {columns.map((column) => <td className={column.className} key={column.key}>{column.render(item)}</td>)}
                  </tr>
                  {expandedRow ? (
                    <tr className="management-data-table-expanded-row">
                      <td colSpan={columns.length}>{expandedRow}</td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            }) : (
              <tr className="management-data-table-empty-row">
                <td colSpan={columns.length}>{query ? t('没有符合筛选条件的数据') : emptyText}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
