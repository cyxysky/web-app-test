'use client';
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import { cellText, cellValue, chartDataTables, parseCell, replaceTableRows, tableColumns } from './editor-core.js';
import { ChartIcon } from './icons.js';
import { defaultChartTranslate, type ChartTranslate } from './i18n.js';

const ChartJsonEditor = lazy(() => import('./json-editor.js').then((module) => ({ default: module.ChartJsonEditor })));

export function ChartDataEditor({ option, title, saving, onSave, onCancel, onReload, translate: t = defaultChartTranslate }: {
  option: Record<string, unknown>; title?: string; saving: boolean;
  translate?: ChartTranslate;
  onSave(option: Record<string, unknown>): Promise<void>; onCancel(): void; onReload?(): Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const backdropPress = useRef(false);
  const headingId = useId();
  const [base, setBase] = useState(() => structuredClone(option));
  const [advanced, setAdvanced] = useState(false);
  const [json, setJson] = useState(() => JSON.stringify(option, null, 2));
  const [selected, setSelected] = useState(0);
  const [page, setPage] = useState(0);
  const [cells, setCells] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [reloading, setReloading] = useState(false);
  const busy = saving || reloading;
  const tables = useMemo(() => chartDataTables(base, t), [base, t]);
  const table = tables[selected];
  const columns = table ? tableColumns(table, t) : [];

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.documentElement.style.overflow;
    dialog.showModal();
    document.documentElement.style.overflow = 'hidden';
    return () => { dialog.close(); document.documentElement.style.overflow = overflow; if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);

  function reportError(reason: unknown) {
    setError(reason instanceof Error ? reason.message : String(reason));
    const details = reason as { status?: number; name?: string; code?: string } | null;
    setConflict(details?.status === 409 || details?.name === 'ChartRevisionConflict' || details?.code === 'chart_revision_conflict' || details?.code === 'chart-revision-conflict');
  }
  function committed() {
    if (!table) return base;
    const rows = structuredClone(table.rows);
    for (const [id, text] of Object.entries(cells)) {
      const [rowIndex, columnIndex] = id.split(':').map(Number);
      const key = columns[columnIndex].key;
      const value = parseCell(text, cellValue(rows[rowIndex], key));
      if (key === null) rows[rowIndex] = value;
      else {
        if (!rows[rowIndex] || typeof rows[rowIndex] !== 'object') throw new Error('混合结构数据请使用 JSON 配置编辑。');
        (rows[rowIndex] as Record<string | number, unknown>)[key] = value;
      }
    }
    return replaceTableRows(base, table, rows);
  }
  function attempt(action: () => void) { try { action(); setError(''); } catch (reason) { reportError(reason); } }
  function switchMode(nextAdvanced: boolean) {
    if (advanced === nextAdvanced) return;
    attempt(() => {
      const next = advanced ? JSON.parse(json) as Record<string, unknown> : committed();
      if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('配置必须是 JSON 对象。');
      setBase(next); setJson(JSON.stringify(next, null, 2)); setCells({}); setSelected(0); setPage(0); setAdvanced(nextAdvanced);
    });
  }
  function selectTable(index: number) { attempt(() => { setBase(committed()); setCells({}); setSelected(index); setPage(0); }); }
  function addRow() { attempt(() => {
    const next = committed(); const nextTable = chartDataTables(next)[selected];
    const first = nextTable.rows[0];
    const row = Array.isArray(first) ? first.map((value) => typeof value === 'string' ? '' : 0) : first && typeof first === 'object' ? structuredClone(first) : typeof first === 'string' ? '' : 0;
    setBase(replaceTableRows(next, nextTable, [...nextTable.rows, row])); setCells({}); setPage(Math.floor(nextTable.rows.length / 50)); setDirty(true);
  }); }
  function removeRow(index: number) { attempt(() => {
    const next = committed(); const nextTable = chartDataTables(next)[selected]; const rows = [...nextTable.rows]; rows.splice(index, 1);
    setBase(replaceTableRows(next, nextTable, rows)); setCells({}); setPage(Math.min(page, Math.max(0, Math.ceil(rows.length / 50) - 1))); setDirty(true);
  }); }
  function outside(event: { clientX: number; clientY: number }) {
    const bounds = dialogRef.current?.getBoundingClientRect();
    return Boolean(bounds && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom));
  }

  return <dialog ref={dialogRef} className="capability-chart-dialog" aria-labelledby={headingId}
    onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}
    onPointerDown={(event) => { backdropPress.current = event.target === event.currentTarget && outside(event); }}
    onClick={(event) => { if (backdropPress.current && event.target === event.currentTarget && outside(event) && !busy) onCancel(); backdropPress.current = false; }}>
    <header className="capability-chart-dialog-header">
      <span className="capability-chart-dialog-emblem"><ChartIcon name="grid" /></span>
      <div><h2 id={headingId}>{t("编辑图表数据")}</h2><p>{title || t('调整数据与图表配置')}</p></div>
      <button type="button" className="capability-chart-icon-button" aria-label={t("关闭编辑")} title={t("关闭")} onClick={onCancel} disabled={busy}><ChartIcon name="close" /></button>
    </header>
    <div className="capability-chart-editor-modebar">
      <div className="capability-chart-segments" role="group" aria-label={t("编辑方式")}>
        <button type="button" aria-label={t("数据表")} aria-pressed={!advanced} onClick={() => switchMode(false)} disabled={busy}><ChartIcon name="grid" />{t("数据表")}{!advanced && <ChartIcon name="check" />}</button>
        <button type="button" aria-label={t("JSON 配置")} aria-pressed={advanced} onClick={() => switchMode(true)} disabled={busy}><ChartIcon name="code" />{t("JSON 配置")}{advanced && <ChartIcon name="check" />}</button>
      </div>
      <span className={`capability-chart-edit-status${dirty ? ' is-dirty' : ''}`}>{t(dirty ? '未保存的修改' : '保存后更新图表')}</span>
    </div>
    <div className={`capability-chart-editor-body${advanced ? ' is-json' : ''}`}>
      {advanced ? <div className="capability-chart-code-panel">
        <div className="capability-chart-code-header"><span>{t("完整图表配置")} <small>JSON</small></span><button type="button" disabled={busy} onClick={() => attempt(() => setJson(JSON.stringify(JSON.parse(json), null, 2)))}>{t("格式化")}</button></div>
        <Suspense fallback={<div className="capability-chart-code-loading" role="status">{t("正在加载编辑器…")}</div>}><ChartJsonEditor translate={t} value={json} onChange={(value) => { setJson(value); setDirty(true); if (!conflict) setError(''); }} disabled={busy} /></Suspense>
      </div> : <>
        <nav className="capability-chart-data-nav" aria-label={t("选择数据表")}>
          <p>{t("图表数据")} <span>{tables.length}</span></p>
          {tables.map((entry, index) => <button type="button" key={entry.id} aria-current={selected === index ? 'true' : undefined} disabled={busy} onClick={() => selectTable(index)}>
            <ChartIcon name={entry.path[0] === 'series' ? 'chart' : 'grid'} /><span><strong>{entry.label}</strong><small>{t('{count} 行数据', { count: entry.rows.length })}</small></span>
          </button>)}
        </nav>
        <div className="capability-chart-data-main">
          {table ? <>
            <div className="capability-chart-table-heading"><div><h3>{table.label}</h3><p>{t("点击单元格即可修改")}</p></div><button type="button" className="capability-chart-secondary-button" disabled={busy} onClick={addRow}><ChartIcon name="plus" />{t("添加一行")}</button></div>
            <div className="capability-chart-table-scroll"><table><thead><tr><th scope="col" className="capability-chart-row-number">#</th>{table.rowLabels && <th scope="col" className="capability-chart-row-label">{t("分类")}</th>}{columns.map((column) => <th scope="col" key={String(column.key)}>{column.label}</th>)}<th scope="col" className="capability-chart-row-actions"><span className="capability-chart-sr-only">{t("操作")}</span></th></tr></thead><tbody>
              {table.rows.slice(page * 50, (page + 1) * 50).map((row, offset) => {
                const rowIndex = page * 50 + offset;
                return <tr key={rowIndex}><th scope="row" className="capability-chart-row-number">{rowIndex + 1}</th>{table.rowLabels && <td className="capability-chart-row-label">{table.rowLabels[rowIndex]}</td>}{columns.map((column, columnIndex) => {
                  const id = `${rowIndex}:${columnIndex}`;
                  return <td key={String(column.key)}><input aria-label={t('第 {row} 行 {column}', { row: rowIndex + 1, column: column.label })} value={cells[id] ?? cellText(cellValue(row, column.key))} disabled={busy} onChange={(event) => { setCells((previous) => ({ ...previous, [id]: event.target.value })); setDirty(true); }} /></td>;
                })}<td className="capability-chart-row-actions"><button type="button" className="capability-chart-icon-button capability-chart-delete-row" aria-label={t('删除第 {row} 行', { row: rowIndex + 1 })} title={t("删除这一行")} disabled={busy} onClick={() => removeRow(rowIndex)}><ChartIcon name="trash" /></button></td></tr>;
              })}
            </tbody></table></div>
            <div className="capability-chart-table-bottom"><span>{t('共 {rows} 行 · {columns} 列', { rows: table.rows.length, columns: columns.length })}</span>{table.rows.length > 50 && <div>
              <button type="button" className="capability-chart-icon-button" aria-label={t("上一页")} disabled={busy || page === 0} onClick={() => setPage(page - 1)}><ChartIcon name="left" /></button><span>{page + 1} / {Math.ceil(table.rows.length / 50)}</span>
              <button type="button" className="capability-chart-icon-button" aria-label={t("下一页")} disabled={busy || (page + 1) * 50 >= table.rows.length} onClick={() => setPage(page + 1)}><ChartIcon name="right" /></button>
            </div>}</div>
          </> : <div className="capability-chart-editor-empty"><ChartIcon name="code" /><p>{t("此图表使用自定义数据结构")}</p><button type="button" className="capability-chart-secondary-button" onClick={() => switchMode(true)}>{t("打开 JSON 配置")}</button></div>}
        </div>
      </>}
    </div>
    {error && <div className="capability-chart-editor-error"><p role="alert">{t(error)}</p>{conflict && onReload && <button type="button" disabled={busy} title={t("放弃当前修改，加载最新保存版本")} onClick={() => { void (async () => { setReloading(true); try { await onReload(); } catch (reason) { reportError(reason); } finally { setReloading(false); } })(); }}><ChartIcon name="refresh" />{t("放弃修改并加载最新版本")}</button>}</div>}
    <footer className="capability-chart-editor-footer"><span>{t(advanced ? '配置为完整 JSON 对象' : table?.rowLabels ? '分类名称可在左侧轴分类中修改' : '保存后应用到当前图表')}</span><div>
      <button type="button" className="capability-chart-secondary-button" disabled={busy} onClick={onCancel}>{t("取消")}</button>
      <button type="button" className="capability-chart-primary-button" disabled={busy} onClick={() => { if (!dirty) { onCancel(); return; } void (async () => { try { const next = advanced ? JSON.parse(json) : committed(); setError(''); await onSave(next); } catch (reason) { reportError(reason); } })(); }}><ChartIcon name="check" />{t(saving ? '保存中…' : '确定')}</button>
    </div></footer>
  </dialog>;
}
