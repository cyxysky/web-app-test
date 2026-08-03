'use client';

import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { LiquidGlassLoader } from '@/components/LiquidGlassLoader';
import { useI18n } from '@/i18n/I18nProvider';
import { withoutWebPilotBasePath } from '@/lib/webpilot-base-path';

function isInternalNavigationLink(anchor: HTMLAnchorElement) {
  if (anchor.target && anchor.target !== '_self') return false;
  if (anchor.hasAttribute('download')) return false;
  const href = anchor.getAttribute('href');
  if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return false;

  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin) return false;
  return `${url.pathname}${url.search}${url.hash}` !== `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function isWorkspaceViewPathname(pathname: string) {
  pathname = withoutWebPilotBasePath(pathname);
  return pathname === '/automation'
    || pathname === '/browser-chat'
    || pathname === '/dashboard'
    || pathname === '/settings';
}

type NavigationLoadingScope = 'viewport' | 'workspace';

function workspaceContentBounds(): CSSProperties | undefined {
  if (typeof document === 'undefined') return undefined;
  const content = document.querySelector<HTMLElement>('.browser-chat-main');
  if (!content) return undefined;
  const bounds = content.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return undefined;
  return {
    height: bounds.height,
    left: bounds.left,
    top: bounds.top,
    width: bounds.width,
  };
}

function LoadingOverlay({ label, scope }: { label: string; scope: NavigationLoadingScope }) {
  const { t } = useI18n();
  const translatedLabel = t(label);
  const contentBounds = scope === 'workspace' ? workspaceContentBounds() : undefined;
  return (
    <div
      className={contentBounds ? 'navigation-loading-overlay navigation-loading-overlay--workspace' : 'navigation-loading-overlay'}
      role="status"
      aria-live="polite"
      aria-label={translatedLabel}
      style={contentBounds}
    >
      <div className="navigation-loading-content">
        <LiquidGlassLoader />
        <p>{translatedLabel}</p>
      </div>
    </div>
  );
}

export function NavigationLoading() {
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);
  const [label, setLabel] = useState('正在切换界面');
  const [scope, setScope] = useState<NavigationLoadingScope>('viewport');
  const pendingRef = useRef(0);
  const showTimeoutRef = useRef<number | undefined>(undefined);
  const timeoutRef = useRef<number | undefined>(undefined);

  function start(nextLabel = '正在处理', nextScope: NavigationLoadingScope = 'viewport') {
    window.clearTimeout(timeoutRef.current);
    const wasIdle = pendingRef.current === 0;
    pendingRef.current += 1;
    setLabel(nextLabel);
    setScope(nextScope);
    if (wasIdle) {
      window.clearTimeout(showTimeoutRef.current);
      showTimeoutRef.current = window.setTimeout(() => setVisible(true), 160);
    }
    timeoutRef.current = window.setTimeout(() => {
      pendingRef.current = 0;
      setVisible(false);
    }, 8000);
  }

  function stop(force = false) {
    window.clearTimeout(timeoutRef.current);
    pendingRef.current = force ? 0 : Math.max(0, pendingRef.current - 1);
    if (pendingRef.current > 0) return;
    window.clearTimeout(showTimeoutRef.current);
    timeoutRef.current = window.setTimeout(() => setVisible(false), 180);
  }

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (anchor instanceof HTMLAnchorElement && isInternalNavigationLink(anchor)) {
        const target = new URL(anchor.href, window.location.href);
        start('正在切换界面', isWorkspaceViewPathname(target.pathname) ? 'workspace' : 'viewport');
      }
    }

    function onPopState() {
      start('正在切换界面', isWorkspaceViewPathname(window.location.pathname) ? 'workspace' : 'viewport');
    }

    function onManualStart(event: Event) {
      const customEvent = event as CustomEvent<{ label?: string; scope?: NavigationLoadingScope }>;
      start(customEvent.detail?.label || '正在处理', customEvent.detail?.scope || 'viewport');
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
      window.clearTimeout(showTimeoutRef.current);
      window.clearTimeout(timeoutRef.current);
    };
  }, []);

  useEffect(() => {
    stop(true);
  }, [pathname]);

  return visible ? <LoadingOverlay label={label} scope={scope} /> : null;
}
