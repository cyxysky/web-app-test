'use client';

import { Fragment, useDeferredValue, useMemo, useRef, useState, type ReactNode } from 'react';
import { Filter, Search, X } from 'lucide-react';
import { CustomSelect } from '@/components/CustomSelect';
import { FloatingLayer } from '@/components/FloatingLayer';
import { useI18n } from '@/i18n/I18nProvider';

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

type AppliedColumnFilter = {
  operator: string;
  value: string;
};

export type ManagementDataTableColumn<T> = {
  className?: string;
  filter?: ManagementDataTableFilter<T>;
  key: string;
  label: string;
  render: (item: T) => ReactNode;
};

const filterOperators: Record<ManagementDataTableFilterType, Array<{ label: string; value: string }>> = {
  text: [
    { label: '包含', value: 'contains' },
    { label: '不包含', value: 'not_contains' },
    { label: '等于', value: 'equals' },
    { label: '不等于', value: 'not_equals' },
    { label: '开头是', value: 'starts_with' },
    { label: '结尾是', value: 'ends_with' },
    { label: '为空', value: 'is_empty' },
    { label: '不为空', value: 'is_not_empty' },
  ],
  select: [
    { label: '等于', value: 'equals' },
    { label: '不等于', value: 'not_equals' },
  ],
  number: [
    { label: '等于', value: 'equals' },
    { label: '不等于', value: 'not_equals' },
    { label: '大于', value: 'greater_than' },
    { label: '大于等于', value: 'greater_than_or_equal' },
    { label: '小于', value: 'less_than' },
    { label: '小于等于', value: 'less_than_or_equal' },
  ],
  datetime: [
    { label: '等于', value: 'equals' },
    { label: '早于', value: 'before' },
    { label: '晚于', value: 'after' },
  ],
};

function filterValues(value: ReturnType<ManagementDataTableFilter<unknown>['getValue']>) {
  if (Array.isArray(value)) return value;
  return value === null || value === undefined ? [] : [value];
}

function matchesColumnFilter<T>(item: T, filter: ManagementDataTableFilter<T>, applied: AppliedColumnFilter) {
  const values = filterValues(filter.getValue(item));
  if (applied.operator === 'is_empty') return !values.some((value) => String(value).trim());
  if (applied.operator === 'is_not_empty') return values.some((value) => String(value).trim());

  if (filter.type === 'number') {
    const expected = Number(applied.value);
    if (!Number.isFinite(expected)) return true;
    const numbers = values.map(Number).filter(Number.isFinite);
    if (applied.operator === 'not_equals') return numbers.every((value) => value !== expected);
    if (applied.operator === 'greater_than') return numbers.some((value) => value > expected);
    if (applied.operator === 'greater_than_or_equal') return numbers.some((value) => value >= expected);
    if (applied.operator === 'less_than') return numbers.some((value) => value < expected);
    if (applied.operator === 'less_than_or_equal') return numbers.some((value) => value <= expected);
    return numbers.some((value) => value === expected);
  }

  if (filter.type === 'datetime') {
    const expected = Date.parse(applied.value);
    if (!Number.isFinite(expected)) return true;
    const timestamps = values.map((value) => Date.parse(String(value))).filter(Number.isFinite);
    if (applied.operator === 'before') return timestamps.some((value) => value < expected);
    if (applied.operator === 'after') return timestamps.some((value) => value > expected);
    const expectedMinute = Math.floor(expected / 60_000);
    return timestamps.some((value) => Math.floor(value / 60_000) === expectedMinute);
  }

  const expected = applied.value.trim().toLocaleLowerCase();
  const normalizedValues = values.map((value) => String(value).trim().toLocaleLowerCase());
  if (applied.operator === 'not_equals') return normalizedValues.every((value) => value !== expected);
  if (applied.operator === 'not_contains') return normalizedValues.every((value) => !value.includes(expected));
  if (applied.operator === 'starts_with') return normalizedValues.some((value) => value.startsWith(expected));
  if (applied.operator === 'ends_with') return normalizedValues.some((value) => value.endsWith(expected));
  if (applied.operator === 'equals') return normalizedValues.some((value) => value === expected);
  return normalizedValues.some((value) => value.includes(expected));
}

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
  const [columnFilters, setColumnFilters] = useState<Record<string, AppliedColumnFilter>>({});
  const [activeFilterKey, setActiveFilterKey] = useState('');
  const [filterDraft, setFilterDraft] = useState<AppliedColumnFilter>({ operator: 'contains', value: '' });
  const filterAnchorRef = useRef<HTMLButtonElement | null>(null);
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  const deferredQuery = useDeferredValue(query);
  const deferredColumnFilters = useDeferredValue(columnFilters);
  const activeColumn = columns.find((column) => column.key === activeFilterKey);
  const activeFilter = activeColumn?.filter;
  const activeOperators = activeFilter ? filterOperators[activeFilter.type] : [];
  const operatorNeedsValue = !['is_empty', 'is_not_empty'].includes(filterDraft.operator);
  const filteredItems = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLocaleLowerCase();
    return items.filter((item) => {
      if (normalizedQuery && !getSearchText(item)
        .join('\n')
        .toLocaleLowerCase()
        .includes(normalizedQuery)) return false;
      return columns.every((column) => {
        const applied = deferredColumnFilters[column.key];
        if (!applied || !column.filter) return true;
        return matchesColumnFilter(item, column.filter, applied);
      });
    });
  }, [columns, deferredColumnFilters, deferredQuery, getSearchText, items]);
  const hasActiveFilters = Boolean(query.trim() || Object.keys(columnFilters).length);

  function openFilter(column: ManagementDataTableColumn<T>, anchor: HTMLButtonElement) {
    if (!column.filter) return;
    const applied = columnFilters[column.key];
    filterAnchorRef.current = anchor;
    setActiveFilterKey(column.key);
    setFilterDraft(applied || {
      operator: filterOperators[column.filter.type][0].value,
      value: column.filter.options?.[0]?.value || '',
    });
    if (column.filter.type !== 'select') requestAnimationFrame(() => filterInputRef.current?.focus());
  }

  function closeFilter() {
    setActiveFilterKey('');
  }

  function applyFilter() {
    if (!activeColumn || !activeFilter) return;
    if (operatorNeedsValue && !filterDraft.value.trim()) return;
    setColumnFilters((current) => ({ ...current, [activeColumn.key]: filterDraft }));
    closeFilter();
  }

  function clearFilter(key = activeFilterKey) {
    if (!key) return;
    setColumnFilters((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    closeFilter();
  }

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
              {columns.map((column) => (
                <th className={column.className} key={column.key} scope="col">
                  <div className="management-data-table-heading">
                    <span>{column.label}</span>
                    {column.filter ? (
                      <>
                        <button
                          aria-label={t('筛选 {column}', { column: column.label })}
                          aria-pressed={Boolean(columnFilters[column.key])}
                          className={columnFilters[column.key] ? 'management-data-table-filter-button active' : 'management-data-table-filter-button'}
                          onClick={(event) => activeFilterKey === column.key ? closeFilter() : openFilter(column, event.currentTarget)}
                          title={t('筛选 {column}', { column: column.label })}
                          type="button"
                        >
                          <Filter size={13} />
                        </button>
                        {columnFilters[column.key] ? (
                          <button
                            aria-label={t('清除 {column} 过滤', { column: column.label })}
                            className="management-data-table-filter-clear"
                            onClick={() => clearFilter(column.key)}
                            title={t('清除 {column} 过滤', { column: column.label })}
                            type="button"
                          >
                            <X size={12} />
                          </button>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                </th>
              ))}
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
                <td colSpan={columns.length}>{hasActiveFilters ? t('没有符合筛选条件的数据') : emptyText}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <FloatingLayer
        active={Boolean(activeFilterKey)}
        align="start"
        allowNestedFloatingLayers
        anchorRef={filterAnchorRef}
        ariaLabel={activeColumn ? t('筛选 {column}', { column: activeColumn.label }) : t('筛选')}
        className="management-data-table-filter-popover"
        maxHeight={380}
        onDismiss={closeFilter}
        preferredWidth={288}
        present={Boolean(activeColumn && activeFilter)}
        role="dialog"
      >
        {activeColumn && activeFilter ? (
          <form onSubmit={(event) => { event.preventDefault(); applyFilter(); }}>
            <header>
              <strong>{activeColumn.label}</strong>
              {columnFilters[activeColumn.key] ? <span>{t('已过滤')}</span> : null}
            </header>
            <label>
              <span>{t('条件')}</span>
              <CustomSelect
                className="management-data-table-filter-select"
                onChange={(value) => setFilterDraft((current) => ({ ...current, operator: value }))}
                options={activeOperators.map((operator) => ({ label: t(operator.label), value: operator.value }))}
                value={filterDraft.operator}
              />
            </label>
            {operatorNeedsValue ? (
              <label>
                <span>{t('值')}</span>
                {activeFilter.type === 'select' ? (
                  <CustomSelect
                    className="management-data-table-filter-select"
                    onChange={(value) => setFilterDraft((current) => ({ ...current, value }))}
                    options={activeFilter.options || []}
                    value={filterDraft.value}
                  />
                ) : (
                  <input
                    onChange={(event) => setFilterDraft((current) => ({ ...current, value: event.target.value }))}
                    ref={filterInputRef}
                    step={activeFilter.type === 'number' ? 'any' : undefined}
                    type={activeFilter.type === 'datetime' ? 'datetime-local' : activeFilter.type}
                    value={filterDraft.value}
                  />
                )}
              </label>
            ) : null}
            <footer>
              <button className="ui-button ui-button--neutral" disabled={!columnFilters[activeColumn.key]} onClick={() => clearFilter()} type="button">{t('清除')}</button>
              <button className="ui-button ui-button--primary" disabled={operatorNeedsValue && !filterDraft.value.trim()} type="submit">{t('应用')}</button>
            </footer>
          </form>
        ) : null}
      </FloatingLayer>
    </div>
  );
}
