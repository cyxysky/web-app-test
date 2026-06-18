'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';

function isInternalNavigationLink(anchor: HTMLAnchorElement) {
  if (anchor.target && anchor.target !== '_self') return false;
  if (anchor.hasAttribute('download')) return false;
  const href = anchor.getAttribute('href');
  if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return false;

  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin) return false;
  return `${url.pathname}${url.search}${url.hash}` !== `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function LoadingOverlay({ label }: { label: string }) {
  return (
    <div className="navigation-loading-overlay" role="status" aria-live="polite" aria-label={label}>
      <div className="navigation-loading-mark" aria-hidden="true">
        <span className="navigation-loading-ring" />
      </div>
      <p>{label}</p>
    </div>
  );
}

export function NavigationLoading() {
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);
  const [label, setLabel] = useState('正在切换界面');
  const pendingRef = useRef(0);
  const timeoutRef = useRef<number | undefined>(undefined);

  function start(nextLabel = '正在处理') {
    window.clearTimeout(timeoutRef.current);
    pendingRef.current += 1;
    setLabel(nextLabel);
    setVisible(true);
    timeoutRef.current = window.setTimeout(() => {
      pendingRef.current = 0;
      setVisible(false);
    }, 8000);
  }

  function stop(force = false) {
    window.clearTimeout(timeoutRef.current);
    pendingRef.current = force ? 0 : Math.max(0, pendingRef.current - 1);
    if (pendingRef.current > 0) return;
    timeoutRef.current = window.setTimeout(() => setVisible(false), 180);
  }

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (anchor instanceof HTMLAnchorElement && isInternalNavigationLink(anchor)) start('正在切换界面');
    }

    function onPopState() {
      start('正在切换界面');
    }

    function onManualStart(event: Event) {
      const customEvent = event as CustomEvent<{ label?: string }>;
      start(customEvent.detail?.label || '正在处理');
    }

    function onManualStop() {
      stop();
    }

    document.addEventListener('click', onClick, true);
    window.addEventListener('popstate', onPopState);
    window.addEventListener('navigation-loading:start', onManualStart);
    window.addEventListener('navigation-loading:stop', onManualStop);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('navigation-loading:start', onManualStart);
      window.removeEventListener('navigation-loading:stop', onManualStop);
      window.clearTimeout(timeoutRef.current);
    };
  }, []);

  useEffect(() => {
    stop(true);
  }, [pathname]);

  return visible ? <LoadingOverlay label={label} /> : null;
}
