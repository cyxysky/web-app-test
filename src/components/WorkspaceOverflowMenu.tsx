'use client';

import { useCallback, useId, useRef, useState, type ReactNode } from 'react';
import { FloatingLayer } from '@/components/FloatingLayer';

type WorkspaceOverflowMenuProps = {
  children: ReactNode;
  className?: string;
  icon: ReactNode;
  label: string;
  title: string;
};

export function WorkspaceOverflowMenu({
  children,
  className,
  icon,
  label,
  title,
}: WorkspaceOverflowMenuProps) {
  const menuId = useId();
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => detailsRef.current?.removeAttribute('open'), []);

  return (
    <details
      className={className ? `browser-chat-overflow ${className}` : 'browser-chat-overflow'}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      ref={detailsRef}
    >
      <summary aria-controls={menuId} aria-expanded={open} aria-label={label} ref={triggerRef} title={title}>
        {icon}
      </summary>
      <FloatingLayer
        anchorRef={triggerRef}
        className="browser-chat-overflow-menu"
        id={menuId}
        maxHeight={320}
        onDismiss={close}
        present={open}
      >
        {children}
      </FloatingLayer>
    </details>
  );
}
