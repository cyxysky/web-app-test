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
    <div className="ui-modal-overlay" onClick={() => setOpen(false)} role="presentation">
      <section className="ui-modal ui-modal--wide" onClick={(event) => event.stopPropagation()} role="dialog" aria-label={t('新增测试用例')}>
        <header className="ui-modal-header">
          <div className="ui-modal-heading">
            <h2 className="ui-modal-title">{t('新增测试用例')}</h2>
          </div>
          <button className="ui-icon-button ui-modal-close" onClick={() => setOpen(false)} type="button" aria-label={t('关闭')}>
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
        className={iconOnly ? 'ui-icon-button dashboard-action-icon' : 'ui-button ui-button--neutral'}
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
