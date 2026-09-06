'use client';

import { useEffect, useState } from 'react';
import type { ChartRecord } from '@webpilot/capability-chart';
import { ChartRenderer } from '@webpilot/capability-chart/react';
import { withWebPilotBasePath } from '@/lib/webpilot-base-path';
import { useI18n } from '@/i18n/I18nProvider';

export function BrowserChatChart({ chartId, sessionId, automationRunId }: { chartId: string; sessionId?: string; automationRunId?: string }) {
  const { t } = useI18n();
  const [record, setRecord] = useState<ChartRecord | null>(null);
  const [error, setError] = useState('');
  const endpoint = withWebPilotBasePath(automationRunId
    ? `/api/automation/runs/${encodeURIComponent(automationRunId)}/charts/${encodeURIComponent(chartId)}`
    : `/api/browser-chat/${encodeURIComponent(sessionId || '')}/charts/${encodeURIComponent(chartId)}`);
  async function loadLatest() {
    const response = await fetch(endpoint, { credentials: 'same-origin', cache: 'no-store' });
    const payload = await response.json() as { chart?: ChartRecord; error?: string };
    if (!response.ok || !payload.chart) throw new Error(payload.error || '图表读取失败。');
    setRecord(payload.chart);
    return payload.chart;
  }

  useEffect(() => {
    setRecord(null);
    setError('');
    if (!sessionId && !automationRunId) {
      setError('当前会话不可用，无法读取图表。');
      return undefined;
    }
    const controller = new AbortController();
    void fetch(endpoint, {
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
  }, [chartId, sessionId, automationRunId, endpoint]);

  if (record) {
    return <ChartRenderer
      key={`${automationRunId || sessionId}/${chartId}`}
      chart={record}
      translate={t}
      onReload={loadLatest}
      onSave={automationRunId ? undefined : async (next, expectedRevision) => {
        const response = await fetch(endpoint, {
          method: 'PATCH', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ expectedRevision, option: next.option }),
        });
        const payload = await response.json() as { chart?: ChartRecord; error?: string };
        if (!response.ok || !payload.chart) throw Object.assign(new Error(payload.error || '图表保存失败，请重试。'), { status: response.status });
        setRecord(payload.chart);
        return payload.chart;
      }}
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
          ? <p role="alert">{t(error)}</p>
          : <span className="browser-chat-chart-loading">{t('正在加载图表…')}</span>}
      </div>
    </figure>
  );
}
