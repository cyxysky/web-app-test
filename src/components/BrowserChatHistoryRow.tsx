'use client';

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Retain measured geometry and navigation anchors while releasing distant message trees. */
export function BrowserChatHistoryRow({ children, keepMounted, turnId }: {
  children: ReactNode;
  keepMounted: boolean;
  turnId?: string;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const heightRef = useRef(0);
  const offscreenRef = useRef(false);
  const restoreRef = useRef(false);
  const [visible, setVisible] = useState(true);
  const mounted = visible || keepMounted;

  useLayoutEffect(() => {
    const row = rowRef.current;
    const root = row?.closest<HTMLElement>('.browser-chat-message-list');
    if (!row || !root || typeof IntersectionObserver === 'undefined') return;
    const update = () => {
      const focused = row.contains(document.activeElement);
      // Preserve local editor/dialog state while a message owns an interaction.
      const editing = Boolean(row.querySelector('[role="dialog"], textarea, [contenteditable="true"]'));
      setVisible(!offscreenRef.current || focused || editing || heightRef.current <= 0);
    };
    const observer = new IntersectionObserver(([entry]) => {
      offscreenRef.current = !entry.isIntersecting;
      update();
    }, { root, rootMargin: '1500px 0px' });
    observer.observe(row);
    row.addEventListener('focusout', update);
    return () => { observer.disconnect(); row.removeEventListener('focusout', update); };
  }, []);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || !mounted) { restoreRef.current = true; return; }
    const root = row.closest<HTMLElement>('.browser-chat-message-list');
    const measure = () => {
      const bounds = row.getBoundingClientRect();
      const previous = heightRef.current;
      heightRef.current = bounds.height;
      // Width changes can invalidate a placeholder's old height. Keep the visible turn fixed.
      if (restoreRef.current && previous > 0 && root && bounds.bottom < root.getBoundingClientRect().top) {
        root.scrollTop += bounds.height - previous;
      }
      if (root && bounds.bottom >= root.getBoundingClientRect().top) restoreRef.current = false;
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [mounted]);

  return <div
    className="browser-chat-history-row"
    data-browser-chat-turn-anchor={turnId}
    ref={rowRef}
    style={mounted ? undefined : { height: heightRef.current }}
  >{mounted ? children : null}</div>;
}
