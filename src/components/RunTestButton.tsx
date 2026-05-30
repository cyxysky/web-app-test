'use client';

import { useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import { useRouter } from 'next/navigation';

export function RunTestButton({ testCaseId }: { testCaseId: string }) {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  async function start() {
    if (starting) return;
    setStarting(true);
    setError('');
    try {
      const response = await fetch(`/api/test-cases/${testCaseId}/run`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok || !data.runId) throw new Error(data.error || '启动失败');
      router.push(`/runs/${data.runId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '启动失败');
      setStarting(false);
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
      {error ? <span className="error">{error}</span> : null}
      <button className="icon-text-button" disabled={starting} onClick={start} type="button">
        {starting ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
        {starting ? '正在启动' : '启动 AI 浏览器测试'}
      </button>
    </div>
  );
}
