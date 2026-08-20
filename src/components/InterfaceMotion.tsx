'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

const PAGE_SELECTOR = [
  '.app-shell',
  '.dashboard-v2',
  '.case-workspace',
  '.redesigned-run-shell',
].join(',');

const PANEL_SELECTOR = [
  '.browser-chat-cases-pane .dashboard-folder-layout',
  '.case-main-panel',
  '.run-execution-panel',
].join(',');

function matchingElements(root: ParentNode, selector: string) {
  const matches: HTMLElement[] = [];
  if (root instanceof HTMLElement && root.matches(selector)) matches.push(root);
  root.querySelectorAll<HTMLElement>(selector).forEach((element) => matches.push(element));
  return matches;
}

export function InterfaceMotion() {
  const pathname = usePathname();
  const previousPathnameRef = useRef(pathname);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const isNavigation = previousPathnameRef.current !== pathname;
    previousPathnameRef.current = pathname;
    if (!isNavigation || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const animated = new WeakSet<HTMLElement>();
    const animations: Animation[] = [];
    const run = (elements: HTMLElement[], type: 'page' | 'panel') => {
      const targets = elements.filter((element) => {
        if (element.closest('.browser-chat-sidebar') || animated.has(element)) return false;
        animated.add(element);
        return element.getClientRects().length > 0;
      }).slice(0, 6);
      const distance = type === 'page' ? 8 : 5;
      targets.forEach((element) => {
        animations.push(element.animate(
          [
            { opacity: 0, transform: `translateY(${distance}px) scale(.998)` },
            { opacity: 1, transform: 'translateY(0) scale(1)' },
          ],
          {
            duration: type === 'page' ? 260 : 220,
            easing: 'cubic-bezier(.16, 1, .3, 1)',
            fill: 'none',
          },
        ));
      });
    };
    run(matchingElements(document.body, PAGE_SELECTOR), 'page');
    run(matchingElements(document.body, PANEL_SELECTOR), 'panel');
    return () => animations.forEach((animation) => animation.cancel());
  }, [pathname]);

  return null;
}
