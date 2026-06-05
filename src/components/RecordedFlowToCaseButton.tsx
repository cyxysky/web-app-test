'use client';

import { useState } from 'react';
import { FilePlus2, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';

export function RecordedFlowToCaseButton({ runId, disabled }: { runId: string; disabled?: boolean }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function createCase() {
    if (loading || disabled) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/runs/${runId}/recorded-flow/to-test-case`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok || !data.testCase?.id) throw new Error(data.error || '生成用例失败');
      router.push(`/test-cases/${data.testCase.id}`);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '生成用例失败');
      setLoading(false);
    }
  }

  return (
    <button className="run-history-replay" disabled={disabled || loading} onClick={createCase} type="button">
      {loading ? <Loader2 className="spin" size={14} /> : <FilePlus2 size={14} />}
      转用例
    </button>
  );
}
