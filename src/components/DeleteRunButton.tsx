'use client';

import { useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { startGlobalLoading, stopGlobalLoading } from '@/lib/global-loading';

export function DeleteRunButton({ runId, disabled }: { runId: string; disabled?: boolean }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function remove() {
    if (loading || disabled) return;
    if (!window.confirm('确定删除这条历史执行记录吗？')) return;
    setLoading(true);
    startGlobalLoading('正在删除执行记录');
    try {
      const response = await fetch(`/api/runs/${runId}/delete`, { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || '删除失败');
      router.refresh();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '删除失败');
    } finally {
      setLoading(false);
      stopGlobalLoading();
    }
  }

  return (
    <button className="run-history-replay danger" disabled={disabled || loading} onClick={remove} type="button">
      {loading ? <Loader2 className="spin" size={14} /> : <Trash2 size={14} />}
      删除
    </button>
  );
}
