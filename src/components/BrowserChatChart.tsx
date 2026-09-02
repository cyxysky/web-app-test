'use client';

import { useEffect, useState } from 'react';
import type { ChartRecord } from '@webpilot/capability-chart';
import { ChartRenderer } from '@webpilot/capability-chart/react';
import { withWebPilotBasePath } from '@/lib/webpilot-base-path';

export function BrowserChatChart({ chartId, sessionId }: { chartId: string; sessionId?: string }) {
  const [record, setRecord] = useState<ChartRecord | null>(null);
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
        const payload = await response.json() as { chart?: ChartRecord };
        if (!payload.chart) throw new Error('图表配置无效。');
        setRecord(payload.chart);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '图表读取失败。');
      });
    return () => controller.abort();
  }, [chartId, sessionId]);

  if (record) {
    return <ChartRenderer
      chart={record}
      classNames={{
        root: 'browser-chat-chart',
        canvas: 'browser-chat-chart-canvas',
        surface: 'browser-chat-chart-surface',
      }}
    />;
  }
  return (
    <figure
      aria-label={chartId}
      className={`browser-chat-chart${error ? ' has-error' : ''}`}
      data-chart-id={chartId}
    >
      <div className="browser-chat-chart-canvas">
        {error
          ? <p role="alert">{error}</p>
          : <span className="browser-chat-chart-loading">正在加载图表…</span>}
      </div>
    </figure>
  );
}
