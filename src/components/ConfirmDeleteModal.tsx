'use client';

import { AlertDialog } from '@heroui/react/alert-dialog';
import { Button } from '@heroui/react/button';
import { Loader2, Trash2, X } from 'lucide-react';
import { useI18n } from '@/i18n/I18nProvider';

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

  return (
    <AlertDialog>
      <AlertDialog.Backdrop
        isDismissable={!deleting}
        isKeyboardDismissDisabled={deleting}
        isOpen
        onOpenChange={(open) => {
          if (!open && !deleting) onClose();
        }}
      >
        <AlertDialog.Container placement="center" size="sm">
          <AlertDialog.Dialog aria-labelledby={id}>
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger" />
              <AlertDialog.Heading id={id}>{title}</AlertDialog.Heading>
              <AlertDialog.CloseTrigger aria-label={t('关闭')} isDisabled={deleting} />
            </AlertDialog.Header>
            <AlertDialog.Body>
              <h3>{itemTitle}</h3>
              <p>{description}</p>
              {error ? <p role="alert">{error}</p> : null}
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button isDisabled={deleting} onPress={onClose} variant="secondary">
                <X size={15} />
                {t('取消')}
              </Button>
              <Button isDisabled={deleting} onPress={() => void onConfirm()} variant="danger">
                {deleting ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
                {t('删除')}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  );
}
