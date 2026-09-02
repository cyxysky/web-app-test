'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ECharts, EChartsOption } from 'echarts';
import { withWebPilotBasePath } from '@/lib/webpilot-base-path';

type BrowserChatChartRecord = {
  chartId: string;
  description?: string;
  height: number;
  maps?: Array<{
    geoJson: Record<string, unknown> | string;
    name: string;
    specialAreas?: Record<string, unknown>;
  }>;
  option: Record<string, unknown>;
  renderer: 'canvas' | 'svg';
  title?: string;
};

export function BrowserChatChart({ chartId, sessionId }: { chartId: string; sessionId?: string }) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ECharts | null>(null);
  const [record, setRecord] = useState<BrowserChatChartRecord | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setRecord(null);
    setError('');
    if (!sessionId) {
      setError('当前会话不可用，无法读取图表。');
      return undefined;
    }
    const controller = new AbortController();
    void fetch(withWebPilotBasePath(`/api/browser-chat/${encodeURIComponent(sessionId)}/charts/${encodeURIComponent(chartId)}`), {
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('图表配置不存在或已失效。');
        const payload = await response.json() as { chart?: BrowserChatChartRecord };
        if (!payload.chart) throw new Error('图表配置无效。');
        setRecord(payload.chart);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '图表读取失败。');
      });
    return () => controller.abort();
  }, [chartId, sessionId]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || !record) return undefined;
    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;
    void import('echarts')
      .then((echarts) => {
        if (disposed) return;
        for (const map of record.maps || []) {
          const mapDefinition = typeof map.geoJson === 'string' ? { svg: map.geoJson } : map.geoJson;
          echarts.registerMap(
            map.name,
            mapDefinition as unknown as Parameters<typeof echarts.registerMap>[1],
            map.specialAreas as Parameters<typeof echarts.registerMap>[2],
          );
        }
        const instance = echarts.init(surface, undefined, { renderer: record.renderer || 'canvas' });
        chartRef.current = instance;
        instance.setOption(record.option as EChartsOption, { lazyUpdate: false, notMerge: true });
        resizeObserver = new ResizeObserver(() => instance.resize());
        resizeObserver.observe(surface);
      })
      .catch((reason) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : '图表渲染失败。');
      });
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, [record]);

  const style = record ? { height: `${record.height}px` } satisfies CSSProperties : undefined;
  return (
    <figure
      aria-label={record?.description || record?.title || chartId}
      className={`browser-chat-chart${error ? ' has-error' : ''}`}
      data-chart-id={chartId}
    >
      {record?.title ? <figcaption>{record.title}</figcaption> : null}
      <div className="browser-chat-chart-canvas" style={style}>
        {error
          ? <p role="alert">{error}</p>
          : record
            ? <div className="browser-chat-chart-surface" ref={surfaceRef} />
            : <span className="browser-chat-chart-loading">正在加载图表…</span>}
      </div>
    </figure>
  );
}
