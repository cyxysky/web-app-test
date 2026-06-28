'use client';

import { useState } from 'react';
import { FilePlus2, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/i18n/I18nProvider';
import { startGlobalLoading, stopGlobalLoading } from '@/lib/global-loading';

export function RecordedFlowToCaseButton({ runId, disabled }: { runId: string; disabled?: boolean }) {
  const { t } = useI18n();
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function createCase() {
    if (loading || disabled) return;
    setLoading(true);
    startGlobalLoading(t('正在转为测试用例'));
    try {
      const response = await fetch(`/api/runs/${runId}/recorded-flow/to-test-case`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok || !data.testCase?.id) throw new Error(data.error || t('生成用例失败'));
      stopGlobalLoading();
      setLoading(false);
      router.push('/dashboard');
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t('生成用例失败'));
      setLoading(false);
      stopGlobalLoading();
    }
  }

  return (
    <button aria-label={t('转为测试用例')} className="run-history-replay" disabled={disabled || loading} onClick={createCase} title={t('转为测试用例')} type="button">
      {loading ? <Loader2 className="spin" size={14} /> : <FilePlus2 size={14} />}
    </button>
  );
}
