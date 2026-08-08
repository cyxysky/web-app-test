'use client';

import { useEffect, useRef } from 'react';

export function useEscapeDismiss(active: boolean, onDismiss: () => void) {
  const dismissRef = useRef(onDismiss);

  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!active) return;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'));
    const dialog = dialogs[dialogs.length - 1] || null;
    const focusableSelector = [
      'button:not([disabled])',
      '[href]',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');

    const focusDialog = window.requestAnimationFrame(() => {
      if (!dialog?.isConnected) return;
      const preferred = dialog.querySelector<HTMLElement>('[autofocus]')
        || dialog.querySelector<HTMLElement>('.ui-modal-close')
        || dialog.querySelector<HTMLElement>(focusableSelector);
      if (preferred && !dialog.contains(document.activeElement)) preferred.focus({ preventScroll: true });
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        dismissRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialog?.isConnected) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
        .filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusDialog);
      document.removeEventListener('keydown', handleKeyDown, true);
      if (!previousFocus?.isConnected) return;
      window.requestAnimationFrame(() => previousFocus.focus({ preventScroll: true }));
    };
  }, [active]);
}
