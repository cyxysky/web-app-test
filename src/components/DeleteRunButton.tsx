'use client';

import { useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/i18n/I18nProvider';
import { startGlobalLoading, stopGlobalLoading } from '@/lib/global-loading';

export function DeleteRunButton({ runId, disabled }: { runId: string; disabled?: boolean }) {
  const { t } = useI18n();
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function remove() {
    if (loading || disabled) return;
    if (!window.confirm(t('确定删除这条历史执行记录吗？'))) return;
    setLoading(true);
    startGlobalLoading(t('正在删除执行记录'));
    try {
      const response = await fetch(`/api/runs/${runId}/delete`, { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || t('删除失败'));
      router.refresh();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t('删除失败'));
    } finally {
      setLoading(false);
      stopGlobalLoading();
    }
  }

  return (
    <button aria-label={t('删除执行记录')} className="run-history-replay danger" disabled={disabled || loading} onClick={remove} title={t('删除执行记录')} type="button">
      {loading ? <Loader2 className="spin" size={14} /> : <Trash2 size={14} />}
    </button>
  );
}
