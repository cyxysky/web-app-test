'use client';

import { useState } from 'react';
import { CirclePlus, X } from 'lucide-react';
import { NewTestCaseForm } from '@/components/NewTestCaseForm';
import { useI18n } from '@/i18n/I18nProvider';

export function NewTestCaseModal({ groupId }: { groupId?: string } = {}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button className="icon-text-button" onClick={() => setOpen(true)} type="button">
        <CirclePlus size={16} />
        {t('新增测试用例')}
      </button>
      {open ? (
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
            <NewTestCaseForm groupId={groupId} />
          </section>
        </div>
      ) : null}
    </>
  );
}
