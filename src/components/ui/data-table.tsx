'use client';

import { Fragment, useMemo, useState, type ReactNode } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';

export type DataTableColumn<T> = {
  accessor?: (item: T) => number | string | null | undefined;
  cell: (item: T) => ReactNode;
  className?: string;
  header: ReactNode;
  headerActions?: ReactNode;
  id: string;
  sortable?: boolean;
};

export function DataTable<T>({
  className = '',
  columns,
  compact = false,
  data,
  emptyText,
  getRowId,
  minWidth,
  renderExpandedRow,
  rowClassName,
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
  const [sorting, setSorting] = useState<SortingState>([]);
  const tableColumns = useMemo<ColumnDef<T>[]>(() => columns.map((column): ColumnDef<T> => {
    const definition = {
      cell: ({ row }: { row: { original: T } }) => column.cell(row.original),
      enableSorting: column.sortable !== false && Boolean(column.accessor),
      header: () => column.header,
      id: column.id,
      meta: { className: column.className },
    };
    return column.accessor ? { ...definition, accessorFn: column.accessor } : definition;
  }), [columns]);
  const table = useReactTable({
    columns: tableColumns,
    data,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => getRowId(row),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: { sorting },
  });

  return (
    <div className={`openstatus-data-table${compact ? ' is-compact' : ''}${className ? ` ${className}` : ''}`}>
      <div className="openstatus-data-table-scroll">
        <table style={minWidth ? { minWidth } : undefined}>
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const meta = header.column.columnDef.meta as { className?: string } | undefined;
                  const sorted = header.column.getIsSorted();
                  return (
                    <th className={meta?.className} key={header.id} scope="col">
                      {header.isPlaceholder ? null : (
                        <div className="openstatus-data-table-heading">
                          {header.column.getCanSort() ? (
                            <button
                              aria-label={`按 ${header.column.id} 排序`}
                              className="openstatus-data-table-sort"
                              onClick={header.column.getToggleSortingHandler()}
                              type="button"
                            >
                              <span>{flexRender(header.column.columnDef.header, header.getContext())}</span>
                              {sorted === 'asc' ? <ArrowUp size={13} /> : sorted === 'desc' ? <ArrowDown size={13} /> : <ArrowUpDown size={13} />}
                            </button>
                          ) : <span>{flexRender(header.column.columnDef.header, header.getContext())}</span>}
                          {columns.find((column) => column.id === header.column.id)?.headerActions}
                        </div>
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.length ? table.getRowModel().rows.map((row) => {
              const expanded = renderExpandedRow?.(row.original);
              return (
                <Fragment key={row.id}>
                  <tr className={rowClassName?.(row.original)}>
                    {row.getVisibleCells().map((cell) => {
                      const meta = cell.column.columnDef.meta as { className?: string } | undefined;
                      return <td className={meta?.className} key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>;
                    })}
                  </tr>
                  {expanded ? (
                    <tr className="openstatus-data-table-expanded-row">
                      <td colSpan={row.getVisibleCells().length}>{expanded}</td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            }) : (
              <tr className="openstatus-data-table-empty-row">
                <td colSpan={columns.length}>{emptyText}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
