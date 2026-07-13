'use client';

import { useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { startGlobalLoading, stopGlobalLoading } from '@/lib/global-loading';
import type { ModelProvider } from '@/server/ai/schemas/test-case.schema';
import { readApiJson } from '@/lib/api-client';

export function RunTestButton({
  iconOnly = false,
  model,
  modelProvider,
  onStarted,
  testCaseId,
}: {
  iconOnly?: boolean;
  model?: string;
  modelProvider?: ModelProvider;
  onStarted?: (runId: string) => void;
  testCaseId: string;
}) {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  async function start() {
    if (starting) return;
    setStarting(true);
    setError('');
    startGlobalLoading('正在启动测试');
    try {
      const modelPayload = modelProvider && model ? { modelProvider, model } : {};
      const response = await fetch(`/api/test-cases/${testCaseId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(modelPayload),
      });
      const data = await readApiJson<{ runId?: string }>(response, '启动失败');
      if (!data.runId) throw new Error('启动失败');
      if (onStarted) {
        stopGlobalLoading();
        setStarting(false);
        onStarted(data.runId);
        return;
      }
      router.push(`/runs/${data.runId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '启动失败');
      setStarting(false);
      stopGlobalLoading();
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
      {error ? <span className="error">{error}</span> : null}
      <button
        aria-label="启动 AI 浏览器测试"
        className={iconOnly ? 'ui-icon-button case-detail-icon-button' : 'ui-button ui-button--neutral'}
        disabled={starting}
        onClick={start}
        title="启动 AI 浏览器测试"
        type="button"
      >
        {starting ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
        {iconOnly ? null : (starting ? '正在启动' : '启动 AI 浏览器测试')}
      </button>
    </div>
  );
}
