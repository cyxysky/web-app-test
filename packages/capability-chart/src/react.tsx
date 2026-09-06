'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { echartsMapDefinition, echartsToThree, normalizeChartOption, normalizeChartUpdate, type ChartRecord } from './core.js';
import { ChartDataEditor } from './data-editor.js';
import { chartDataTables, tableCsv } from './editor-core.js';
import type { ChartSurface } from './three-renderer.js';
import { chartStyles } from './styles.js';
import { ChartIcon } from './icons.js';
import { defaultChartTranslate, type ChartTranslate } from './i18n.js';

export type ChartRendererClassNames = { root?: string; canvas?: string; surface?: string; error?: string };

function download(data: Blob | string, name: string) {
  const url = typeof data === 'string' ? data : URL.createObjectURL(data);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name;
  document.body.append(anchor); anchor.click(); anchor.remove();
  if (typeof data !== 'string') setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function svgPng(svg: string, width: number, height: number) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = new Image(); image.src = url; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = width * 2; canvas.height = height * 2;
    const context = canvas.getContext('2d'); if (!context) throw new Error('浏览器无法导出 PNG。');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height); return canvas.toDataURL('image/png');
  } finally { URL.revokeObjectURL(url); }
}

export function ChartRenderer({ chart, classNames = {}, onSave, onReload, translate: t = defaultChartTranslate }: {
  chart: ChartRecord; classNames?: ChartRendererClassNames;
  translate?: ChartTranslate;
  onSave?(next: ChartRecord, expectedRevision: number): Promise<ChartRecord>;
  onReload?(): Promise<ChartRecord>;
}) {
  const editableChart = useMemo(() => {
    if (chart.engine === 'three') return chart;
    try { return { ...chart, option: normalizeChartOption(chart.option, { invalidFormatters: 'omit' }) }; }
    catch { return chart; } // The rendering effect displays structural validation errors.
  }, [chart]);
  const rootRef = useRef<HTMLElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<ChartSurface | null>(null);
  const applyOptionRef = useRef<((record: ChartRecord) => void) | null>(null);
  const latestChartRef = useRef(chart);
  const editSnapshotRef = useRef<ChartRecord | null>(null);
  const downloadRef = useRef<HTMLDetailsElement | null>(null);
  const [current, setCurrent] = useState(editableChart);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [ready, setReady] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [threeView, setThreeView] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const converted = useMemo(() => current.engine === 'three' ? undefined : echartsToThree(current.option, t), [current, t]);
  const isThree = current.engine === 'three' || (threeView && Boolean(converted));
  const displayOption = threeView && converted ? converted : current.option;
  const dataTables = useMemo(() => chartDataTables(current.option, t), [current, t]);
  const renderer = current.renderer || 'canvas';
  const threeOption = isThree ? displayOption : undefined;

  useEffect(() => {
    latestChartRef.current = current;
    try { applyOptionRef.current?.(current); setError(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '图表更新失败。'); }
  }, [current]);

  useEffect(() => { setCurrent(editableChart); setThreeView(false); }, [editableChart]);
  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (downloadRef.current?.open && event.target instanceof Node && !downloadRef.current.contains(event.target)) downloadRef.current.open = false;
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && downloadRef.current?.open) {
        downloadRef.current.open = false;
        downloadRef.current.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', closeOutside); document.addEventListener('keydown', closeOnEscape);
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeOnEscape); };
  }, []);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    let disposed = false;
    let instance: ChartSurface | undefined;
    let observer: ResizeObserver | undefined;
    setError(''); setReady(false);
    void (async () => {
      if (isThree) {
        const { createThreeChart } = await import('./three-renderer.js');
        if (disposed) return;
        instance = createThreeChart(surface, threeOption!, (message) => { if (!disposed) setError(message); }, t);
      } else {
        const echarts = await import('echarts');
        if (disposed) return;
        const view = echarts.init(surface, undefined, { renderer });
        const apply = (record: ChartRecord) => {
          for (const map of record.maps || []) echarts.registerMap(map.name, echartsMapDefinition(map) as unknown as Parameters<typeof echarts.registerMap>[1], map.specialAreas as Parameters<typeof echarts.registerMap>[2]);
          view.setOption(normalizeChartOption(record.option, { invalidFormatters: 'omit' }), { lazyUpdate: false, notMerge: true });
        };
        try { apply(latestChartRef.current); }
        catch (reason) { view.dispose(); throw reason; }
        applyOptionRef.current = apply;
        instance = {
          dispose: () => view.dispose(), resize: () => view.resize(),
          png: () => renderer === 'svg' ? svgPng(view.renderToSVGString(), view.getWidth(), view.getHeight()) : Promise.resolve(view.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#ffffff' })),
          svg: renderer === 'svg' ? () => view.renderToSVGString() : undefined,
        };
      }
      if (disposed) { instance?.dispose(); return; }
      instanceRef.current = instance!;
      observer = new ResizeObserver(() => instance?.resize()); observer.observe(surface);
      setReady(true);
    })().catch((reason) => { if (!disposed) setError(reason instanceof Error ? reason.message : '图表渲染失败。'); });
    return () => { disposed = true; observer?.disconnect(); instance?.dispose(); instanceRef.current = null; applyOptionRef.current = null; };
  }, [renderer, threeOption, isThree, refresh, t]);

  async function save(option: Record<string, unknown>) {
    // Keep the revision from when editing began, even if the host refreshes props.
    const base = editSnapshotRef.current || current;
    const next = normalizeChartUpdate(base, { option });
    setSaving(true);
    try {
      const saved = onSave ? await onSave(next, base.revision || 0) : next;
      setCurrent(saved); setEditing(false); setNotice(onSave ? '已保存，刷新后仍可查看。' : '已在当前页面应用；可下载 JSON 保存配置。');
    } finally { setSaving(false); }
  }
  function action(task: () => Promise<void> | void) { void Promise.resolve().then(task).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); }
  const filename = (current.title || current.chartId).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100);
  return <figure ref={rootRef} className={`${classNames.root || 'capability-chart'} capability-chart-interactive${error ? ` ${classNames.error || 'has-error'}` : ''}`} aria-label={current.description || current.title || current.chartId} data-chart-id={current.chartId} data-chart-engine={isThree ? 'three' : 'echarts'}>
    <style>{chartStyles}</style>
    <figcaption className="capability-chart-header">
      <strong className="capability-chart-title">{current.title || t('图表')}</strong>
      <div className="capability-chart-actions" role="group" aria-label={t("图表操作")}>
      {converted && <><button type="button" className="capability-chart-view-button" aria-pressed={threeView} onClick={() => setThreeView(!threeView)}>{t(threeView ? '2D 视图' : '3D 视图')}</button><span className="capability-chart-action-divider" /></>}
      <button type="button" className="capability-chart-icon-button" aria-label={t("编辑数据")} title={t("编辑数据")} disabled={saving} aria-haspopup="dialog" onClick={() => { if (downloadRef.current) downloadRef.current.open = false; editSnapshotRef.current = current; setEditing(true); setNotice(''); }}><ChartIcon name="edit" /></button>
      <details ref={downloadRef} className="capability-chart-download"><summary className="capability-chart-icon-button" aria-label={t("下载")} title={t("下载图表")}><ChartIcon name="download" /></summary><div className="capability-chart-download-menu" onClick={(event) => { if (event.target instanceof Element && event.target.closest('button:not(:disabled)') && downloadRef.current) downloadRef.current.open = false; }}>
        <p>{t("导出图表")}</p>
        <button type="button" aria-label={t("图片 PNG")} disabled={!ready} onClick={() => action(async () => { const uri = await instanceRef.current?.png(); if (uri) download(uri, `${filename}${isThree ? '-3d' : ''}.png`); })}><ChartIcon name="image" /><span>{t("图片")}</span><small>PNG</small></button>
        {!isThree && current.renderer === 'svg' && <button type="button" aria-label={t("矢量 SVG")} disabled={!ready} onClick={() => action(() => { const svg = instanceRef.current?.svg?.(); if (svg) download(new Blob([svg], { type: 'image/svg+xml' }), `${filename}.svg`); })}><ChartIcon name="image" /><span>{t("矢量图")}</span><small>SVG</small></button>}
        <button type="button" aria-label={t("完整配置 JSON")} onClick={() => download(new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' }), `${filename}.json`)}><ChartIcon name="code" /><span>{t("完整配置")}</span><small>JSON</small></button>
        {dataTables.length > 0 && <p>{t("导出数据")}</p>}
        {dataTables.map((table, index) => <button type="button" key={table.id} aria-label={t('数据 CSV · {name}', { name: table.label })} onClick={() => download(new Blob([tableCsv(table, t)], { type: 'text/csv;charset=utf-8' }), `${filename}-data-${index + 1}.csv`)}><ChartIcon name="grid" /><span>{table.label}</span><small>CSV</small></button>)}
      </div></details>
      <button type="button" className="capability-chart-icon-button" aria-label={t(fullscreen ? '退出全屏' : '全屏')} title={t(fullscreen ? '退出全屏' : '全屏')} onClick={() => action(async () => {
        if (document.fullscreenElement === rootRef.current) await document.exitFullscreen();
        else if (rootRef.current?.requestFullscreen) await rootRef.current.requestFullscreen();
        else throw new Error('当前浏览器不支持全屏 API。');
      })}><ChartIcon name={fullscreen ? 'collapse' : 'expand'} /></button>
      </div>
    </figcaption>
    <div className={`${classNames.canvas || 'capability-chart-canvas'} capability-chart-viewport`} style={{ height: current.height }}>
      <div className={`${classNames.surface || 'capability-chart-surface'} capability-chart-render-surface`} ref={surfaceRef} />
      {!ready && !error && <span className="capability-chart-loading">{t("正在渲染图表…")}</span>}
    </div>
    {isThree && <p className="capability-chart-hint">{t('拖动旋转 · 滚轮或双指缩放 · 右键拖动平移')}{threeView && current.engine !== 'three' ? ` · ${t('3D 预览不改动原图配置')}` : ''}</p>}
    {error && <p role="alert" className="capability-chart-message">{t(error)} <button type="button" onClick={() => setRefresh(refresh + 1)}>{t("重试渲染")}</button></p>}
    {notice && <p role="status" className="capability-chart-message">{t(notice)}</p>}
    {editing && <ChartDataEditor translate={t} option={(editSnapshotRef.current || current).option} title={current.title} saving={saving} onSave={save} onCancel={() => setEditing(false)}
      onReload={onReload ? async () => { setSaving(true); try { setCurrent(await onReload()); setEditing(false); setNotice('已加载最新保存版本。'); } finally { setSaving(false); } } : undefined} />}
  </figure>;
}
