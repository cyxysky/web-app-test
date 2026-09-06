import { defaultChartTranslate, type ChartTranslate } from './i18n.js';

export type DataTable = { id: string; label: string; path: Array<string | number>; rows: unknown[]; rowLabels?: string[]; columnLabels?: string[] };
export type DataColumn = { key: string | number | null; label: string };

export function chartDataTables(option: Record<string, unknown>, t: ChartTranslate = defaultChartTranslate): DataTable[] {
  const tables: DataTable[] = [];
  function add(value: unknown, path: Array<string | number>, label: string, extra: Pick<DataTable, 'rowLabels' | 'columnLabels'> = {}) {
    if (Array.isArray(value)) tables.push({ id: JSON.stringify(path), path, label, rows: value, ...extra });
  }
  for (const section of ['series', 'dataset', 'xAxis', 'yAxis']) {
    const value = option[section];
    const entries = Array.isArray(value) ? value : value ? [value] : [];
    entries.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') return;
      const record = entry as Record<string, unknown>;
      const base = Array.isArray(value) ? [section, index] : [section];
      for (const field of section === 'series' ? ['data', 'nodes', 'links', 'edges'] : section === 'dataset' ? ['source'] : ['data']) {
        const name = typeof record.name === 'string' && record.name ? record.name : t('系列 {index}', { index: index + 1 });
        const label = section === 'series' ? field === 'data' ? name : t(field === 'nodes' ? '{name} · 节点' : '{name} · 关系', { name })
          : section === 'dataset' ? t('数据集 {index}', { index: index + 1 }) : `${t(section === 'xAxis' ? '横轴分类' : '纵轴分类')}${index ? ` ${index + 1}` : ''}`;
        const axis = (Array.isArray(option.xAxis) ? option.xAxis[0] : option.xAxis) as { data?: unknown[] } | undefined;
        const rowLabels = section === 'series' && field === 'data' && Array.isArray(axis?.data) && Array.isArray(record.data) && axis.data.length === record.data.length
          ? axis.data.map((value) => String(value && typeof value === 'object' && 'value' in value ? value.value : value)) : undefined;
        const axes = option.axes as Record<string, { name?: string }> | undefined;
        const columnLabels = section === 'series' && String(record.type).endsWith('3D') ? ['x', 'y', 'z'].map((key) => axes?.[key]?.name || key.toUpperCase()) : undefined;
        add(record[field], [...base, field], label, { rowLabels, columnLabels });
      }
    });
  }
  if (option.axes && typeof option.axes === 'object') for (const axis of ['x', 'y', 'z']) {
    const value = (option.axes as Record<string, { categories?: unknown }>)[axis];
    add(value?.categories, ['axes', axis, 'categories'], t('{axis} 轴分类', { axis: axis.toUpperCase() }));
  }
  return tables;
}

export function tableColumns(table: DataTable, t: ChartTranslate = defaultChartTranslate): DataColumn[] {
  const first = table.rows.find((row) => row !== null && row !== undefined);
  if (Array.isArray(first)) {
    const width = Math.min(32, table.rows.reduce<number>((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0));
    return Array.from({ length: width }, (_, key) => ({ key, label: table.columnLabels?.[key] || t('维度 {index}', { index: key + 1 }) }));
  }
  if (first && typeof first === 'object') {
    return [...new Set(table.rows.flatMap((row) => row && typeof row === 'object' && !Array.isArray(row) ? Object.keys(row) : []))].slice(0, 32).map((key) => ({ key, label: key === 'name' ? t('名称') : key === 'value' ? t('数值') : key }));
  }
  return [{ key: null, label: t(table.path[0] === 'series' ? '数值' : '名称') }];
}

export function cellValue(row: unknown, key: DataColumn['key']) {
  return key === null ? row : row && typeof row === 'object' ? (row as Record<string | number, unknown>)[key] : undefined;
}
export function cellText(value: unknown): string { return typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value); }
export function parseCell(text: string, previous: unknown) {
  if (typeof previous === 'string') return text;
  if (text === '' && previous === undefined) return undefined;
  try { return JSON.parse(text); } catch { throw new Error('数字、数组和对象必须使用有效 JSON；文本单元格可直接输入文字。'); }
}

/** Update one data array without discarding unrelated series, styles or metadata. */
export function replaceTableRows(option: Record<string, unknown>, table: DataTable, rows: unknown[]): Record<string, unknown> {
  const next = structuredClone(option);
  let target: Record<string | number, unknown> = next;
  for (const part of table.path.slice(0, -1)) target = target[part] as Record<string | number, unknown>;
  target[table.path[table.path.length - 1]] = rows;
  return next;
}

export function tableCsv(table: DataTable, t: ChartTranslate = defaultChartTranslate): string {
  const columns = tableColumns(table, t);
  const quote = (value: unknown) => `"${(typeof value === 'string' && /^[=+@\-\t\r]/.test(value) ? "'" : '') + cellText(value).replaceAll('"', '""')}"`;
  return '\uFEFF' + [columns.map((column) => quote(column.label)).join(','), ...table.rows.map((row) => columns.map((column) => quote(cellValue(row, column.key))).join(','))].join('\r\n');
}
