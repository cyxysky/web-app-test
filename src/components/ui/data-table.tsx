'use client';

import { EmptyState, Table, type SortDescriptor } from '@heroui/react';
import { useDeferredValue, useMemo, useState, type ReactNode } from 'react';

export type DataTableColumn<T> = {
  accessor?: (item: T) => number | string | null | undefined;
  cell: (item: T) => ReactNode;
  className?: string;
  header: ReactNode;
  id: string;
  sortable?: boolean;
};

type RenderRow<T> = {
  content?: ReactNode;
  id: string;
  item: T;
  kind: 'data' | 'expanded';
};

const tableValueCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

function compareValues(
  left: number | string | null | undefined,
  right: number | string | null | undefined,
) {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return tableValueCollator.compare(String(left), String(right));
}

export function DataTable<T>({
  className,
  columns,
  data,
  emptyText,
  getRowId,
  renderExpandedRow,
}: {
  className?: string;
  columns: DataTableColumn<T>[];
  compact?: boolean;
  data: T[];
  emptyText: string;
  getRowId: (item: T) => string;
  minWidth?: number;
  renderExpandedRow?: (item: T) => ReactNode;
  rowClassName?: (item: T) => string | undefined;
}) {
  const [sortDescriptor, setSortDescriptor] = useState<SortDescriptor>();
  const deferredSortDescriptor = useDeferredValue(sortDescriptor);
  const sortedData = useMemo(() => {
    if (!deferredSortDescriptor) return data;
    const column = columns.find((candidate) => candidate.id === String(deferredSortDescriptor.column));
    if (!column?.accessor || column.sortable === false) return data;
    const accessor = column.accessor;
    const multiplier = deferredSortDescriptor.direction === 'descending' ? -1 : 1;
    return data
      .map((item, index) => ({ index, item, value: accessor(item) }))
      .sort((left, right) => (
        multiplier * compareValues(left.value, right.value) || left.index - right.index
      ))
      .map(({ item }) => item);
  }, [columns, data, deferredSortDescriptor]);
  const rows = useMemo<RenderRow<T>[]>(() => sortedData.flatMap((item) => {
    const id = getRowId(item);
    const content = renderExpandedRow?.(item);
    return content
      ? [
        { id, item, kind: 'data' as const },
        { content, id: `${id}:expanded`, item, kind: 'expanded' as const },
      ]
      : [{ id, item, kind: 'data' as const }];
  }), [getRowId, renderExpandedRow, sortedData]);

  return (
    <Table className={className}>
      <Table.ScrollContainer>
        <Table.Content
          aria-label="Data table"
          onSortChange={setSortDescriptor}
          sortDescriptor={sortDescriptor}
        >
          <Table.Header>
            {columns.map((column, index) => (
              <Table.Column
                allowsSorting={column.sortable !== false && Boolean(column.accessor)}
                id={column.id}
                isRowHeader={index === 0}
                key={column.id}
              >
                {({ sortDirection }) => column.sortable !== false && column.accessor ? (
                  <Table.SortableColumnHeader sortDirection={sortDirection}>
                    {column.header}
                  </Table.SortableColumnHeader>
                ) : <span>{column.header}</span>}
              </Table.Column>
            ))}
          </Table.Header>
          <Table.Body items={rows} renderEmptyState={() => (
            <EmptyState className="management-table-empty-state">
              <span>{emptyText}</span>
            </EmptyState>
          )}>
            {(row) => row.kind === 'expanded' ? (
              <Table.Row id={row.id}>
                <Table.Cell colSpan={columns.length}>{row.content}</Table.Cell>
              </Table.Row>
            ) : (
              <Table.Row id={row.id}>
                {columns.map((column) => (
                  <Table.Cell key={column.id}>{column.cell(row.item)}</Table.Cell>
                ))}
              </Table.Row>
            )}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  );
}
