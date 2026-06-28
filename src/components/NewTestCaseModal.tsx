'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { CirclePlus, X } from 'lucide-react';
import { NewTestCaseForm } from '@/components/NewTestCaseForm';
import { useI18n } from '@/i18n/I18nProvider';

export function NewTestCaseModal({
  groupId,
  iconOnly = false,
  onCreated,
}: {
  groupId?: string;
  iconOnly?: boolean;
  onCreated?: (testCaseId: string) => void;
} = {}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const modal = open ? (
    <div className="modal-overlay" onClick={() => setOpen(false)} role="presentation">
      <section className="new-case-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-label={t('新增测试用例')}>
        <header>
          <div>
            <h2>{t('新增测试用例')}</h2>
          </div>
          <button className="icon-button" onClick={() => setOpen(false)} type="button" aria-label={t('关闭')}>
            <X size={18} />
          </button>
        </header>
        <NewTestCaseForm
          groupId={groupId}
          onCreated={(testCaseId) => {
            setOpen(false);
            onCreated?.(testCaseId);
          }}
        />
      </section>
    </div>
  ) : null;

  return (
    <>
      <button
        aria-label={t('新增测试用例')}
        className={iconOnly ? 'icon-button dashboard-action-icon' : 'icon-text-button'}
        onClick={() => setOpen(true)}
        title={t('新增测试用例')}
        type="button"
      >
        <CirclePlus size={16} />
        {iconOnly ? null : t('新增测试用例')}
      </button>
      {modal && typeof document !== 'undefined' ? createPortal(modal, document.body) : modal}
    </>
  );
}
