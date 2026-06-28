'use client';

import { useState } from 'react';

export function BrowserChatPayloadDetails({
  className = '',
  defaultOpen = false,
  payload,
  title,
}: {
  className?: string;
  defaultOpen?: boolean;
  payload: string;
  title: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (!payload) return null;
  return (
    <details className={className} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{title}</summary>
      {open ? <pre>{payload}</pre> : null}
    </details>
  );
}
