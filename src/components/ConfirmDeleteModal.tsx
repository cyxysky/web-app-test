'use client';

import { Loader2, Trash2, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/i18n/I18nProvider';
import { useEscapeDismiss } from '@/hooks/useEscapeDismiss';

type ConfirmDeleteModalProps = {
  description: string;
  deleting: boolean;
  error?: string;
  id: string;
  itemTitle: string;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
};

export function ConfirmDeleteModal({
  description,
  deleting,
  error,
  id,
  itemTitle,
  onClose,
  onConfirm,
  title,
}: ConfirmDeleteModalProps) {
  const { t } = useI18n();
  useEscapeDismiss(true, () => {
    if (!deleting) onClose();
  });

  return createPortal((
    <div className="ui-modal-overlay" onMouseDown={onClose}>
      <section
        aria-labelledby={id}
        aria-modal="true"
        className="ui-modal ui-modal--compact"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="ui-modal-header">
          <h2 className="ui-modal-title" id={id}>{title}</h2>
          <button aria-label={t('关闭')} className="ui-icon-button ui-modal-close" disabled={deleting} onClick={onClose} type="button">
            <X size={16} />
          </button>
        </header>
        <div className="ui-modal-body skills-manager-delete-body">
          <h3>{itemTitle}</h3>
          <p>{description}</p>
          {error ? <p className="personal-memory-delete-error">{error}</p> : null}
        </div>
        <footer className="ui-modal-footer">
          <button className="ui-button ui-button--neutral" disabled={deleting} onClick={onClose} type="button">
            <X size={15} />
            {t('取消')}
          </button>
          <button className="ui-button ui-button--danger" disabled={deleting} onClick={() => void onConfirm()} type="button">
            {deleting ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
            {t('删除')}
          </button>
        </footer>
      </section>
    </div>
  ), document.body);
}
