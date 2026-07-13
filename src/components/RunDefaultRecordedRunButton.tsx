'use client';

import { useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { startGlobalLoading, stopGlobalLoading } from '@/lib/global-loading';
import type { ModelProvider } from '@/server/ai/schemas/test-case.schema';
import { readApiJson } from '@/lib/api-client';

export function RunDefaultRecordedRunButton({
  defaultRecordedRunId,
  iconOnly = false,
  model,
  modelProvider,
  onStarted,
  testCaseId,
}: {
  defaultRecordedRunId?: string;
  iconOnly?: boolean;
  model?: string;
  modelProvider?: ModelProvider;
  onStarted?: (runId: string) => void;
  testCaseId: string;
}) {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const disabled = starting || !defaultRecordedRunId;

  async function start() {
    if (disabled) return;
    setStarting(true);
    setError('');
    startGlobalLoading('正在按默认记录执行');
    try {
      const modelPayload = modelProvider && model ? { modelProvider, model } : {};
      const response = await fetch(`/api/test-cases/${testCaseId}/run-default-recorded`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(modelPayload),
      });
      const data = await readApiJson<{ runId?: string }>(response, '按默认记录执行失败');
      if (!data.runId) throw new Error('按默认记录执行失败');
      if (onStarted) {
        stopGlobalLoading();
        setStarting(false);
        onStarted(data.runId);
        return;
      }
      router.push(`/runs/${data.runId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '按默认记录执行失败');
      setStarting(false);
      stopGlobalLoading();
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
      {error ? <span className="error">{error}</span> : null}
      <button
        aria-label="按默认记录执行"
        className={iconOnly ? 'ui-icon-button case-detail-icon-button' : 'ui-button ui-button--neutral'}
        disabled={disabled}
        onClick={start}
        title={defaultRecordedRunId ? '按当前默认记录执行' : '请先在执行记录中设为默认记录'}
        type="button"
      >
        {starting ? <Loader2 className="spin" size={16} /> : <RotateCcw size={16} />}
        {iconOnly ? null : (starting ? '正在启动' : '按默认记录执行')}
      </button>
    </div>
  );
}
