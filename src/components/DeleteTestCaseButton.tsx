'use client';

import { Loader2, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/i18n/I18nProvider';
import { readApiJson } from '@/lib/api-client';
import { useApiAction } from '@/lib/use-api-action';

export function DeleteTestCaseButton({
  className = 'ui-button ui-button--danger',
  disabled,
  label = '删除用例',
  onDeleted,
  redirectTo,
  testCaseId,
  testCaseTitle,
}: {
  className?: string;
  disabled?: boolean;
  label?: string;
  onDeleted?: () => void;
  redirectTo?: string;
  testCaseId: string;
  testCaseTitle?: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const { run, running: loading } = useApiAction();

  async function remove() {
    if (loading || disabled) return;
    const name = testCaseTitle ? `“${testCaseTitle}”` : t('这个测试用例');
    if (!window.confirm(t('确定删除{name}吗？关联执行记录会一起移除。', { name }))) return;
    await run(async () => {
      const response = await fetch(`/api/test-cases/${testCaseId}`, { method: 'DELETE' });
      await readApiJson<Record<string, unknown>>(response, t('删除用例失败'));
      if (onDeleted) {
        onDeleted();
        return;
      }
      if (redirectTo) {
        router.push(redirectTo);
        return;
      }
      router.refresh();
    }, { loadingLabel: t('正在删除测试用例') }).catch((error) => {
      window.alert(error instanceof Error ? error.message : t('删除用例失败'));
    });
  }

  return (
    <button className={className} disabled={disabled || loading} onClick={remove} type="button" title={t('删除用例')}>
      {loading ? <Loader2 className="spin" size={14} /> : <Trash2 size={14} />}
      {label ? <span>{t(label)}</span> : null}
    </button>
  );
}
