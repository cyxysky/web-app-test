'use client';

import { Loader2, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/i18n/I18nProvider';
import { readApiJson } from '@/lib/api-client';
import { useApiAction } from '@/lib/use-api-action';

export function DeleteRunButton({ runId, disabled }: { runId: string; disabled?: boolean }) {
  const { t } = useI18n();
  const router = useRouter();
  const { run, running: loading } = useApiAction();

  async function remove() {
    if (loading || disabled) return;
    if (!window.confirm(t('确定删除这条历史执行记录吗？'))) return;
    await run(async () => {
      const response = await fetch(`/api/runs/${runId}/delete`, { method: 'POST' });
      await readApiJson<any>(response, t('删除失败'));
      router.refresh();
    }, { loadingLabel: t('正在删除执行记录') }).catch((error) => {
      window.alert(error instanceof Error ? error.message : t('删除失败'));
    });
  }

  return (
    <button aria-label={t('删除执行记录')} className="run-history-replay danger" disabled={disabled || loading} onClick={remove} title={t('删除执行记录')} type="button">
      {loading ? <Loader2 className="spin" size={14} /> : <Trash2 size={14} />}
    </button>
  );
}
