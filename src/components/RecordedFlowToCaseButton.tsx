'use client';

import { FilePlus2, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/i18n/I18nProvider';
import { readApiJson } from '@/lib/api-client';
import { useApiAction } from '@/lib/use-api-action';

export function RecordedFlowToCaseButton({ runId, disabled }: { runId: string; disabled?: boolean }) {
  const { t } = useI18n();
  const router = useRouter();
  const { run, running: loading } = useApiAction();

  async function createCase() {
    if (loading || disabled) return;
    await run(async () => {
      const response = await fetch(`/api/runs/${runId}/recorded-flow/to-test-case`, { method: 'POST' });
      const data = await readApiJson<{ testCase?: { id?: string } }>(response, t('生成用例失败'));
      if (!data.testCase?.id) throw new Error(t('生成用例失败'));
      router.push('/dashboard');
    }, { loadingLabel: t('正在转为测试用例') }).catch((error) => {
      window.alert(error instanceof Error ? error.message : t('生成用例失败'));
    });
  }

  return (
    <button aria-label={t('转为测试用例')} className="run-history-replay" disabled={disabled || loading} onClick={createCase} title={t('转为测试用例')} type="button">
      {loading ? <Loader2 className="spin" size={14} /> : <FilePlus2 size={14} />}
    </button>
  );
}
