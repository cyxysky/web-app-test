'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ECharts, EChartsOption } from 'echarts';
import { echartsMapDefinition, normalizeChartOption, type ChartRecord } from './core.js';

export type ChartRendererClassNames = {
  root?: string;
  canvas?: string;
  surface?: string;
  error?: string;
};

export function ChartRenderer({
  chart,
  classNames = {},
}: {
  chart: ChartRecord;
  classNames?: ChartRendererClassNames;
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ECharts | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return undefined;
    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;
    setError('');
    void import('echarts')
      .then((echarts) => {
        if (disposed) return;
        const option = normalizeChartOption(chart.option);
        for (const map of chart.maps || []) {
          echarts.registerMap(
            map.name,
            echartsMapDefinition(map) as unknown as Parameters<typeof echarts.registerMap>[1],
            map.specialAreas as Parameters<typeof echarts.registerMap>[2],
          );
        }
        const instance = echarts.init(surface, undefined, { renderer: chart.renderer || 'canvas' });
        try {
          instance.setOption(option as EChartsOption, { lazyUpdate: false, notMerge: true });
          if (disposed) {
            instance.dispose();
            return;
          }
          chartRef.current = instance;
          resizeObserver = new ResizeObserver(() => instance.resize());
          resizeObserver.observe(surface);
        } catch (reason) {
          instance.dispose();
          throw reason;
        }
      })
      .catch((reason) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : 'Chart rendering failed.');
      });
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, [chart]);

  const style = { height: `${chart.height}px` } satisfies CSSProperties;
  const rootClassName = [classNames.root || 'capability-chart', error ? classNames.error || 'has-error' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <figure
      aria-label={chart.description || chart.title || chart.chartId}
      className={rootClassName}
      data-chart-id={chart.chartId}
    >
      {chart.title ? <figcaption>{chart.title}</figcaption> : null}
      <div className={classNames.canvas || 'capability-chart-canvas'} style={style}>
        <div className={classNames.surface || 'capability-chart-surface'} ref={surfaceRef} />
        {error ? <p role="alert">{error}</p> : null}
      </div>
    </figure>
  );
}
