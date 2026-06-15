'use client';

import { useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/i18n/I18nProvider';
import { startGlobalLoading, stopGlobalLoading } from '@/lib/global-loading';

export function DeleteTestCaseButton({
  className = 'icon-text-button danger',
  disabled,
  label = '删除用例',
  redirectTo,
  testCaseId,
  testCaseTitle,
}: {
  className?: string;
  disabled?: boolean;
  label?: string;
  redirectTo?: string;
  testCaseId: string;
  testCaseTitle?: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function remove() {
    if (loading || disabled) return;
    const name = testCaseTitle ? `“${testCaseTitle}”` : t('这个测试用例');
    if (!window.confirm(t('确定删除{name}吗？关联执行记录会一起移除。', { name }))) return;
    setLoading(true);
    startGlobalLoading(t('正在删除测试用例'));
    try {
      const response = await fetch(`/api/test-cases/${testCaseId}`, { method: 'DELETE' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || t('删除用例失败'));
      if (redirectTo) {
        router.push(redirectTo);
        return;
      }
      router.refresh();
      setLoading(false);
      stopGlobalLoading();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t('删除用例失败'));
      setLoading(false);
      stopGlobalLoading();
    }
  }

  return (
    <button className={className} disabled={disabled || loading} onClick={remove} type="button" title={t('删除用例')}>
      {loading ? <Loader2 className="spin" size={14} /> : <Trash2 size={14} />}
      {label ? <span>{t(label)}</span> : null}
    </button>
  );
}
