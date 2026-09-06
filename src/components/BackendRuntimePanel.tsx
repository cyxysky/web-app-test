'use client';

import { Activity, CircleStop, Gauge, MemoryStick, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { readApiJson } from '@/lib/api-client';
import { withWebPilotBasePath } from '@/lib/webpilot-base-path';
import { useI18n } from '@/i18n/I18nProvider';
import type { BackendRuntimeStatus } from '@/server/observability/backend-runtime-status';

function mb(value?: number) {
  return `${Number(value || 0).toFixed(1)} MB`;
}

function chartTime(value: string, language: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

export function BackendRuntimePanel() {
  const { t, language } = useI18n();
  const [data, setData] = useState<BackendRuntimeStatus>();
  const [loading, setLoading] = useState(true);
  const [closing, setClosing] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await fetch(withWebPilotBasePath('/api/admin/ai-operations/runtime'), { cache: 'no-store' });
      setData(await readApiJson<BackendRuntimeStatus>(response, '加载后端状态失败'));
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载后端状态失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const closeBrowser = async (browserId: string) => {
    setClosing(browserId);
    try {
      const response = await fetch(withWebPilotBasePath(`/api/admin/ai-operations/runtime/browsers/${encodeURIComponent(browserId)}`), { method: 'DELETE' });
      await readApiJson(response, '关闭测试浏览器失败');
      await load();
    } catch (closeError) {
      setError(closeError instanceof Error ? closeError.message : '关闭测试浏览器失败');
    } finally {
      setClosing('');
    }
  };

  const chart = useMemo(() => {
    const points = data?.memoryTrend || [];
    if (points.length < 2) return undefined;
    const width = 1000;
    const height = 260;
    const plot = { bottom: 222, left: 72, right: 980, top: 16 };
    const values = points.flatMap((point) => [point.rssMb, point.heapUsedMb]);
    const rawMinimum = Math.min(...values);
    const rawMaximum = Math.max(...values);
    const rawRange = Math.max(10, rawMaximum - rawMinimum);
    const minimum = Math.max(0, Math.floor((rawMinimum - rawRange * 0.12) / 10) * 10);
    const maximum = Math.max(minimum + 10, Math.ceil((rawMaximum + rawRange * 0.12) / 10) * 10);
    const x = (index: number) => plot.left + index / (points.length - 1) * (plot.right - plot.left);
    const y = (value: number) => plot.bottom - (value - minimum) / (maximum - minimum) * (plot.bottom - plot.top);
    const line = (value: (point: (typeof points)[number]) => number) => points
      .map((point, index) => `${x(index)},${y(value(point))}`)
      .join(' ');
    const yTicks = Array.from({ length: 5 }, (_, index) => {
      const value = maximum - index / 4 * (maximum - minimum);
      return { value, y: y(value) };
    });
    const xTickIndexes = [...new Set([0, Math.round((points.length - 1) / 2), points.length - 1])];
    return {
      height,
      latest: points.at(-1)!,
      points,
      width,
      x,
      xTicks: xTickIndexes.map((index) => ({ index, label: chartTime(points[index]!.time, language), x: x(index) })),
      y,
      yTicks,
      rss: line((point) => point.rssMb),
      heap: line((point) => point.heapUsedMb),
    };
  }, [data?.memoryTrend, language]);

  if (!data && loading) return <div className="ai-runtime-loading"><RefreshCw className="spin" size={18} /> {t("正在读取后端状态…")}</div>;

  return (
    <div className="ai-runtime-status" aria-busy={loading}>
      <div className="ai-runtime-toolbar">
        <div><strong>{t("当前后端状态")}</strong><span>{t("每 10 秒自动刷新，仅管理员 1 可见")}</span></div>
        <button onClick={() => void load()} type="button"><RefreshCw className={loading ? 'spin' : undefined} size={15} />{t("刷新")}</button>
      </div>
      {error ? <p className="ai-runtime-error" role="alert">{t(error)}</p> : null}
      <section className="ai-runtime-metrics">
        <article><MemoryStick size={18} /><span>{t("RSS 内存")}</span><strong>{mb(data?.process.memoryMb.rss)}</strong><small>{t('堆 {used} / {limit}', { used: mb(data?.process.memoryMb.heapUsed), limit: mb(data?.process.memoryMb.heapLimit) })}</small></article>
        <article><MemoryStick size={18} /><span>{t("原生与缓冲区")}</span><strong>{mb(data?.process.memoryMb.external)}</strong><small>ArrayBuffer {mb(data?.process.memoryMb.arrayBuffers)}</small></article>
        <article><Gauge size={18} /><span>{t("堆使用率")}</span><strong>{Number(data?.process.utilizationPercent.heap || 0).toFixed(1)}%</strong><small>{t('压力：{pressure}', { pressure: t(data?.process.pressure === 'critical' ? '严重' : data?.process.pressure === 'high' ? '偏高' : '正常') })}</small></article>
        <article><Activity size={18} /><span>{t("活跃对话")}</span><strong>{data?.activeConversations || 0}</strong><small>{t("当前正在执行或排队")}</small></article>
        <article><CircleStop size={18} /><span>{t("测试浏览器")}</span><strong>{data?.browserCount || 0}</strong><small>{t("主会话与子 Agent 浏览器")}</small></article>
      </section>
      <section className="ai-operations-panel ai-runtime-chart-panel">
        <header className="ai-operations-panel-header">
          <div><h2>{t("内存趋势")}</h2><p>{t("最多保留最近 180 个采样点，悬停采样点可查看精确值")}</p></div>
          {chart ? <div className="ai-runtime-chart-current"><span>{t("当前 RSS")} <strong>{mb(chart.latest.rssMb)}</strong></span><span>{t("当前 V8 堆")} <strong>{mb(chart.latest.heapUsedMb)}</strong></span></div> : null}
        </header>
        <div className="ai-runtime-chart">
          {chart ? (
            <svg aria-label={t("RSS 与 V8 堆内存趋势，单位 MB")} role="img" viewBox={`0 0 ${chart.width} ${chart.height}`}>
              {chart.yTicks.map((tick) => <g className="ai-runtime-chart-y-tick" key={tick.value}><line x1="72" x2="980" y1={tick.y} y2={tick.y} /><text x="62" y={tick.y + 4}>{tick.value.toFixed(0)} MB</text></g>)}
              {chart.xTicks.map((tick) => <text className="ai-runtime-chart-x-label" key={tick.index} textAnchor={tick.index === 0 ? 'start' : tick.index === chart.points.length - 1 ? 'end' : 'middle'} x={tick.x} y="250">{tick.label}</text>)}
              <polyline className="is-rss" points={chart.rss} />
              <polyline className="is-heap" points={chart.heap} />
              {chart.points.map((point, index) => (
                <g key={`${point.time}-${index}`}>
                  <circle className="ai-runtime-chart-hit is-rss" cx={chart.x(index)} cy={chart.y(point.rssMb)} r="7"><title>{`${chartTime(point.time, language)} · RSS ${mb(point.rssMb)}`}</title></circle>
                  <circle className="ai-runtime-chart-hit is-heap" cx={chart.x(index)} cy={chart.y(point.heapUsedMb)} r="7"><title>{t('{time} · V8 堆 {memory}', { time: chartTime(point.time, language), memory: mb(point.heapUsedMb) })}</title></circle>
                </g>
              ))}
              <circle className="ai-runtime-chart-point is-rss" cx={chart.x(chart.points.length - 1)} cy={chart.y(chart.latest.rssMb)} r="4" />
              <circle className="ai-runtime-chart-point is-heap" cx={chart.x(chart.points.length - 1)} cy={chart.y(chart.latest.heapUsedMb)} r="4" />
            </svg>
          ) : <span>{t("等待更多采样点")}</span>}
        </div>
        <div className="ai-runtime-chart-legend"><span><i className="is-rss" />RSS {chart ? mb(chart.latest.rssMb) : ''}</span><span><i className="is-heap" />{t("V8 堆使用")} {chart ? mb(chart.latest.heapUsedMb) : ''}</span></div>
      </section>
      <section className="ai-operations-panel ai-runtime-browser-panel">
        <header className="ai-operations-panel-header"><div><h2>{t("当前测试浏览器")}</h2><p>{t("展示所属用户、会话、页面与实时状态")}</p></div><span>{data?.browsers.length || 0}</span></header>
        {data?.browsers.length ? (
          <div className="ai-runtime-browser-list">
            {data.browsers.map((browser) => (
              <article key={browser.id}>
                <div><strong>{browser.title || browser.sessionId}</strong><span>{t('用户 {id} · {kind} · {count} 个标签页', { id: browser.userId || t('未知'), kind: t(browser.kind === 'subagent' ? '子 Agent' : '主会话'), count: browser.tabCount })}</span><code title={browser.currentUrl}>{browser.currentUrl || 'about:blank'}</code></div>
                <span className={browser.busy ? 'is-busy' : undefined}>{browser.busy ? t('使用中') : t(({ initializing: '正在初始化', ready: '就绪', running: '执行中', completed: '已完成', interrupted: '已中断', failed: '失败', closed: '已结束', blocked: '阻塞' } as Record<string, string>)[browser.status] || browser.status)}</span>
                <button disabled={closing === browser.id} onClick={() => void closeBrowser(browser.id)} type="button"><CircleStop size={15} />{t(closing === browser.id ? '关闭中…' : '关闭浏览器')}</button>
              </article>
            ))}
          </div>
        ) : <div className="ai-operations-empty">{t("当前没有测试浏览器")}</div>}
      </section>
    </div>
  );
}
