'use client';

import { InputGroup } from '@heroui/react/input-group';
import { useDeferredValue, useMemo, useState, type ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import { useI18n } from '@/i18n/I18nProvider';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';

type ManagementDataTableFilterType = 'datetime' | 'number' | 'select' | 'text';

type ManagementDataTableFilterOption = {
  label: string;
  value: string;
};

type ManagementDataTableFilter<T> = {
  getValue: (item: T) => number | string | Array<number | string> | null | undefined;
  options?: ManagementDataTableFilterOption[];
  type: ManagementDataTableFilterType;
};

export type ManagementDataTableColumn<T> = {
  className?: string;
  filter?: ManagementDataTableFilter<T>;
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
  const hasActiveFilters = Boolean(query.trim());

  return (
    <div className="management-data-table">
      <div className="domain-list-toolbar management-data-table-toolbar">
        <div className="domain-list-search">
          <InputGroup fullWidth>
            <InputGroup.Prefix><Search size={15} /></InputGroup.Prefix>
            <InputGroup.Input
            aria-label={searchPlaceholder}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchPlaceholder}
            type="search"
            value={query}
            />
            {query ? (
              <InputGroup.Suffix>
                <button aria-label={t('清空筛选')} onClick={() => setQuery('')} type="button"><X size={14} /></button>
              </InputGroup.Suffix>
            ) : null}
          </InputGroup>
        </div>
        <div className="domain-list-toolbar-meta">
          <span className="domain-list-count">{t('显示 {visible} / {total} 条', { visible: filteredItems.length, total: items.length })}</span>
          {toolbarActions}
        </div>
      </div>

      <DataTable
        className="management-data-table-grid"
        columns={columns.map((column): DataTableColumn<T> => ({
          accessor: column.filter ? (item) => {
            const value = column.filter?.getValue(item);
            return Array.isArray(value) ? value.join(' ') : value ?? '';
          } : undefined,
          cell: column.render,
          className: column.className,
          header: column.label,
          id: column.key,
          sortable: Boolean(column.filter),
        }))}
        data={filteredItems}
        emptyText={hasActiveFilters ? t('没有符合筛选条件的数据') : emptyText}
        getRowId={getId}
        minWidth={900}
        renderExpandedRow={renderExpandedRow}
        rowClassName={rowClassName}
      />
    </div>
  );
}
