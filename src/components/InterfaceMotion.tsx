'use client';

import { animate, createScope } from 'animejs';
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

function clearMotionStyles(elements: HTMLElement[]) {
  elements.forEach((element) => {
    element.style.removeProperty('opacity');
    element.style.removeProperty('transform');
    element.style.removeProperty('will-change');
  });
}

export function InterfaceMotion() {
  const pathname = usePathname();
  const previousPathnameRef = useRef(pathname);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const isNavigation = previousPathnameRef.current !== pathname;
    previousPathnameRef.current = pathname;
    const animated = new WeakSet<HTMLElement>();
    const scope = createScope({
      root: document.body,
      mediaQueries: {
        reduceMotion: '(prefers-reduced-motion: reduce)',
      },
    }).add((self) => {
      if (self?.matches.reduceMotion) return undefined;

      const run = (elements: HTMLElement[], type: 'page' | 'panel') => {
        const fresh = elements.filter((element) => {
          // The workspace sidebar persists while its URL-controlled content view changes.
          // Replaying entrance motion here makes the stable navigation look like it reloaded.
          if (element.closest('.browser-chat-sidebar')) return false;
          if (animated.has(element)) return false;
          animated.add(element);
          return element.getClientRects().length > 0;
        });
        const targets = fresh.slice(0, 6);
        if (!targets.length) return;

        targets.forEach((element) => element.style.setProperty('will-change', 'transform, opacity'));
        const distance = type === 'page' ? 8 : 5;
        animate(targets, {
          opacity: [0, 1],
          y: [distance, 0],
          scale: [0.998, 1],
          duration: type === 'page' ? 260 : 220,
          ease: 'out(5)',
          onComplete: () => clearMotionStyles(targets),
        });
      };

      const animateWithin = (root: ParentNode) => {
        run(matchingElements(root, PAGE_SELECTOR), 'page');
        run(matchingElements(root, PANEL_SELECTOR), 'panel');
      };

      // Keep motion at the page/panel level. Animating every inserted row makes
      // dense workspaces feel busy and keeps a costly global observer alive.
      if (isNavigation) animateWithin(document.body);
      return undefined;
    });

    return () => scope.revert();
  }, [pathname]);

  return null;
}
