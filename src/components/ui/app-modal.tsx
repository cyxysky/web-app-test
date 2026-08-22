'use client';

import { Modal } from '@heroui/react';
import { Children, cloneElement, isValidElement, type CSSProperties, type ReactNode } from 'react';

type AppModalSize = 'cover' | 'full' | 'lg' | 'log' | 'management' | 'md' | 'media' | 'preview' | 'sm' | 'wide' | 'xs';

type AppModalProps = {
  ariaLabel?: string;
  ariaLabelledBy?: string;
  children: ReactNode;
  dismissable?: boolean;
  dialogClassName?: string;
  keyboardDismissable?: boolean;
  onClose: () => void;
  open?: boolean;
  placement?: 'auto' | 'bottom' | 'center' | 'top';
  scroll?: 'inside' | 'outside';
  size?: AppModalSize;
};

type ModalContentProps = {
  'aria-label'?: string;
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  id?: string;
};

function splitModalClasses(className?: string) {
  const classes = className?.split(/\s+/).filter(Boolean) || [];
  return {
    modalClasses: classes.filter((name) => name.startsWith('ui-modal-')),
    remainingClassName: classes.filter((name) => !name.startsWith('ui-modal-')).join(' '),
  };
}

function joinModalSectionClasses(baseClassName: string, className?: string) {
  return [baseClassName, className].filter(Boolean).join(' ');
}

function stripModalClasses(node: ReactNode): ReactNode {
  return Children.map(node, (child) => {
    if (!isValidElement<ModalContentProps>(child)) return child;
    const { children, className } = child.props;
    const { modalClasses, remainingClassName } = splitModalClasses(className);
    if (modalClasses.includes('ui-modal-title')) {
      return <Modal.Heading id={child.props.id}>{stripModalClasses(children)}</Modal.Heading>;
    }
    if (modalClasses.includes('ui-modal-heading-icon')) {
      return null;
    }
    if (modalClasses.includes('ui-modal-heading') || modalClasses.includes('ui-modal-heading-copy')) {
      return stripModalClasses(children);
    }
    if (modalClasses.includes('ui-modal-close')) {
      return (
        <Modal.CloseTrigger
          aria-label={child.props['aria-label']}
          isDisabled={child.props.disabled}
        />
      );
    }
    const nextProps: ModalContentProps = { children: stripModalClasses(children) };
    if (Object.prototype.hasOwnProperty.call(child.props, 'className')) {
      nextProps.className = remainingClassName || undefined;
    }
    return cloneElement(child, nextProps);
  });
}

function renderModalSections(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (!isValidElement<ModalContentProps>(child)) return child;
    const { modalClasses, remainingClassName } = splitModalClasses(child.props.className);
    if (child.type === 'form') {
      return cloneElement(child, { children: renderModalSections(child.props.children) });
    }
    if (child.type === 'header' || modalClasses.includes('ui-modal-header')) {
      return <Modal.Header className={joinModalSectionClasses('app-modal-header', remainingClassName)}>{stripModalClasses(child.props.children)}</Modal.Header>;
    }
    if (child.type === 'footer' || modalClasses.includes('ui-modal-footer')) {
      return <Modal.Footer className={joinModalSectionClasses('app-modal-footer', remainingClassName)}>{stripModalClasses(child.props.children)}</Modal.Footer>;
    }
    if (modalClasses.includes('ui-modal-body')) {
      return <Modal.Body className={joinModalSectionClasses('app-modal-body', remainingClassName)}>{stripModalClasses(child.props.children)}</Modal.Body>;
    }
    return stripModalClasses(child);
  });
}

function modalDialogStyle(size: AppModalSize): CSSProperties | undefined {
  const base: CSSProperties = { boxSizing: 'border-box', padding: 0 };
  switch (size) {
    case 'wide':
      return { ...base, maxWidth: 'min(880px, calc(100vw - 32px))' };
    case 'management':
      return {
        ...base,
        height: 'min(88dvh, 860px)',
        maxWidth: 'min(1280px, calc(100vw - 40px))',
      };
    case 'log':
      return {
        ...base,
        height: 'min(82dvh, 760px)',
        maxWidth: 'min(1180px, calc(100vw - 40px))',
      };
    case 'media':
      return {
        ...base,
        maxHeight: 'min(84dvh, 820px)',
        maxWidth: 'min(1180px, calc(100vw - 40px))',
        overflow: 'hidden',
        padding: 0,
      };
    case 'preview':
      return {
        ...base,
        height: 'min(86dvh, 860px)',
        maxWidth: 'min(1320px, calc(100vw - 40px))',
        overflow: 'hidden',
        padding: 0,
      };
    default:
      return base;
  }
}

export function AppModal({
  ariaLabel,
  ariaLabelledBy,
  children,
  dismissable = true,
  dialogClassName,
  keyboardDismissable = true,
  onClose,
  open = true,
  placement = 'center',
  scroll = 'inside',
  size = 'lg',
}: AppModalProps) {
  const heroSize = size === 'wide' || size === 'management' || size === 'log' || size === 'media' || size === 'preview' ? 'lg' : size;
  const dialogStyle = modalDialogStyle(size);

  return (
    <Modal>
      <Modal.Backdrop
        isDismissable={dismissable}
        isKeyboardDismissDisabled={!keyboardDismissable}
        isOpen={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) onClose();
        }}
      >
        <Modal.Container
          placement={placement}
          scroll={scroll}
          size={heroSize}
        >
          <Modal.Dialog
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy}
            className={dialogClassName}
            style={dialogStyle}
          >
            {renderModalSections(children)}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
