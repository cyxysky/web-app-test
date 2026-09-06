'use client';

import { useCallback, useEffect, useId, useRef, useState, type FocusEventHandler, type PointerEventHandler, type ReactNode, type RefObject } from 'react';
import { FloatingLayer, type FloatingLayerAlign, type FloatingLayerPlacement } from '@/components/FloatingLayer';
import styles from './HoverCard.module.css';

type HoverCardTriggerProps = {
  'aria-describedby'?: string;
  onBlur: FocusEventHandler<HTMLElement>;
  onFocus: FocusEventHandler<HTMLElement>;
  onPointerDown: PointerEventHandler<HTMLElement>;
  onPointerEnter: PointerEventHandler<HTMLElement>;
  onPointerLeave: PointerEventHandler<HTMLElement>;
  ref: (node: HTMLElement | null) => void;
};

export function HoverCard({
  align = 'end',
  anchorRef,
  children,
  content,
  disabled = false,
  headerAside,
  placement = 'top',
  title,
  width = 420,
}: {
  align?: FloatingLayerAlign;
  anchorRef?: RefObject<HTMLElement | null>;
  children: (props: HoverCardTriggerProps) => ReactNode;
  content?: ReactNode;
  disabled?: boolean;
  headerAside?: ReactNode;
  placement?: FloatingLayerPlacement;
  title?: ReactNode;
  width?: number;
}) {
  const id = useId();
  const internalAnchorRef = useRef<HTMLElement | null>(null);
  const triggerRef = anchorRef || internalAnchorRef;
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const enabled = !disabled && Boolean(title || content);
  const cancelClose = useCallback(() => clearTimeout(closeTimer.current), []);
  const dismiss = useCallback(() => {
    cancelClose();
    setOpen(false);
  }, [cancelClose]);
  const show = useCallback(() => {
    cancelClose();
    if (enabled) setOpen(true);
  }, [cancelClose, enabled]);
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  }, [cancelClose]);
  const setAnchor = useCallback((node: HTMLElement | null) => {
    triggerRef.current = node;
  }, [triggerRef]);

  useEffect(() => cancelClose, [cancelClose]);
  useEffect(() => {
    if (!enabled) dismiss();
  }, [dismiss, enabled]);

  return (
    <>
      {children({
        'aria-describedby': enabled ? id : undefined,
        onBlur: scheduleClose,
        onFocus: (event) => { if (event.currentTarget.matches(':focus-visible')) show(); },
        onPointerDown: dismiss,
        onPointerEnter: (event) => { if (event.pointerType !== 'touch') show(); },
        onPointerLeave: scheduleClose,
        ref: setAnchor,
      })}
      {enabled ? (
        <FloatingLayer
          align={align}
          anchorRef={triggerRef}
          className={`ui-hover-card ${styles.card}`}
          gap={8}
          id={id}
          onDismiss={dismiss}
          onPointerEnter={cancelClose}
          onPointerLeave={scheduleClose}
          placement={placement}
          preferredWidth={width}
          present={open}
          role="tooltip"
        >
          {title ? (
            <header className={styles.header}>
              <strong className={styles.title}>{title}</strong>
              {headerAside != null ? <span className={styles.aside}>{headerAside}</span> : null}
            </header>
          ) : null}
          {content}
        </FloatingLayer>
      ) : null}
    </>
  );
}
