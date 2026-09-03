'use client';

import { Button } from '@heroui/react/button';
import { Popover } from '@heroui/react/popover';
import { useId, useState, type ReactNode } from 'react';

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
  const [open, setOpen] = useState(false);

  return (
    <div
      className={className ? `browser-chat-overflow ${className}` : 'browser-chat-overflow'}
      data-open={open || undefined}
    >
      <Popover isOpen={open} onOpenChange={setOpen}>
        <Button
          aria-controls={menuId}
          aria-description={title}
          aria-expanded={open}
          aria-label={label}
          className="browser-chat-overflow-trigger"
          variant="ghost"
        >
          {icon}
        </Button>
        <Popover.Content
          className="browser-chat-overflow-popover"
          containerPadding={8}
          offset={6}
          placement="bottom end"
        >
          <Popover.Dialog
            aria-label={label}
            className="browser-chat-popover-actions"
            id={menuId}
            onClickCapture={(event) => {
              if (event.target instanceof Element && event.target.closest('button')) setOpen(false);
            }}
          >
            {children}
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
    </div>
  );
}
