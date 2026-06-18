'use client';

import { useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/i18n/I18nProvider';
import { startGlobalLoading, stopGlobalLoading } from '@/lib/global-loading';

export function ReplayRunButton({ runId, disabled }: { runId: string; disabled?: boolean }) {
  const { t } = useI18n();
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function replay() {
    if (loading || disabled) return;
    setLoading(true);
    startGlobalLoading(t('正在按记录执行'));
    try {
      const response = await fetch(`/api/runs/${runId}/replay`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok || !data.runId) throw new Error(data.error || t('按记录执行失败'));
      router.push(`/runs/${data.runId}`);
    } catch (error) {
      setLoading(false);
      stopGlobalLoading();
      window.alert(error instanceof Error ? error.message : t('按记录执行失败'));
    }
  }

  return (
    <button className="run-history-replay" disabled={disabled || loading} onClick={replay} type="button">
      {loading ? <Loader2 className="spin" size={14} /> : <RotateCcw size={14} />}
      {t('按记录执行')}
    </button>
  );
}
