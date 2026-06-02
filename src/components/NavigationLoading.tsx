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

function LoadingOverlay() {
  return (
    <div className="navigation-loading-overlay" role="status" aria-live="polite" aria-label="页面切换中">
      <div className="navigation-loading-mark">
        <span />
      </div>
      <p>正在切换界面</p>
    </div>
  );
}

export function NavigationLoading() {
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);
  const timeoutRef = useRef<number | undefined>(undefined);

  function start() {
    window.clearTimeout(timeoutRef.current);
    setVisible(true);
    timeoutRef.current = window.setTimeout(() => setVisible(false), 8000);
  }

  function stop() {
    window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => setVisible(false), 180);
  }

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (anchor instanceof HTMLAnchorElement && isInternalNavigationLink(anchor)) start();
    }

    function onPopState() {
      start();
    }

    function onManualStart() {
      start();
    }

    document.addEventListener('click', onClick, true);
    window.addEventListener('popstate', onPopState);
    window.addEventListener('navigation-loading:start', onManualStart);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('navigation-loading:start', onManualStart);
      window.clearTimeout(timeoutRef.current);
    };
  }, []);

  useEffect(() => {
    stop();
  }, [pathname]);

  return visible ? <LoadingOverlay /> : null;
}
