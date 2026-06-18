'use client';

import { useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { startGlobalLoading, stopGlobalLoading } from '@/lib/global-loading';

export function RunDefaultRecordedRunButton({
  defaultRecordedRunId,
  testCaseId,
}: {
  defaultRecordedRunId?: string;
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
      const response = await fetch(`/api/test-cases/${testCaseId}/run-default-recorded`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok || !data.runId) throw new Error(data.error || '按默认记录执行失败');
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
        className="icon-text-button"
        disabled={disabled}
        onClick={start}
        title={defaultRecordedRunId ? '按当前默认记录执行' : '请先在执行记录中设为默认记录'}
        type="button"
      >
        {starting ? <Loader2 className="spin" size={16} /> : <RotateCcw size={16} />}
        {starting ? '正在启动' : '按默认记录执行'}
      </button>
    </div>
  );
}
