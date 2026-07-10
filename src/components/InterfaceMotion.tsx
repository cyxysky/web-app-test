'use client';

import { animate, createScope, stagger } from 'animejs';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

const PAGE_SELECTOR = [
  '.app-shell',
  '.dashboard-v2',
  '.case-workspace',
  '.redesigned-run-shell',
  '.browser-chat-main',
].join(',');

const NAV_SELECTOR = [
  '.browser-chat-sidebar',
  '.browser-chat-sub-sidebar',
].join(',');

const PANEL_SELECTOR = [
  '.browser-chat-settings-pane .settings-content > section',
  '.browser-chat-cases-pane .dashboard-folder-layout',
  '.browser-chat-chat-pane',
  '.case-main-panel',
  '.run-execution-panel',
].join(',');

const LIST_SELECTOR = [
  '.dashboard-v2-metrics > div',
  '.case-item',
  '.case-table-row',
  '.run-history-row',
  '.browser-chat-recent-item',
  '.browser-chat-message > div:last-child',
  '.settings-row',
  '.personal-memory-item',
  '.skills-manager-item',
  '.tool-call-list li',
  '.ledger-item-card',
  '.report-accordion',
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
  });
}

export function InterfaceMotion() {
  const pathname = usePathname();

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const animated = new WeakSet<HTMLElement>();
    const scope = createScope({
      root: document.body,
      mediaQueries: {
        reduceMotion: '(prefers-reduced-motion: reduce)',
      },
    }).add((self) => {
      if (self?.matches.reduceMotion) return undefined;

      const run = (elements: HTMLElement[], type: 'list' | 'nav' | 'page' | 'panel') => {
        const targets = elements.filter((element) => {
          if (animated.has(element)) return false;
          animated.add(element);
          return true;
        });
        if (!targets.length) return;

        const distance = type === 'page' ? 12 : type === 'panel' ? 9 : 7;
        animate(targets, {
          opacity: [0, 1],
          ...(type === 'nav' ? { x: [-10, 0] } : { y: [distance, 0] }),
          scale: type === 'list' ? [0.992, 1] : [0.997, 1],
          delay: type === 'list' ? stagger(24) : stagger(35),
          duration: type === 'page' ? 460 : 360,
          ease: 'out(4)',
          onComplete: () => clearMotionStyles(targets),
        });
      };

      const animateWithin = (root: ParentNode) => {
        run(matchingElements(root, PAGE_SELECTOR), 'page');
        run(matchingElements(root, NAV_SELECTOR), 'nav');
        run(matchingElements(root, PANEL_SELECTOR), 'panel');
        run(matchingElements(root, LIST_SELECTOR), 'list');
      };

      animateWithin(document.body);
      const pendingRoots = new Set<HTMLElement>();
      let animationFrame = 0;
      const observer = new MutationObserver((records) => {
        records.flatMap((record) => Array.from(record.addedNodes))
          .filter((node): node is HTMLElement => node instanceof HTMLElement)
          .forEach((element) => pendingRoots.add(element));
        if (!pendingRoots.size || animationFrame) return;
        animationFrame = requestAnimationFrame(() => {
          animationFrame = 0;
          const roots = [...pendingRoots];
          pendingRoots.clear();
          roots.filter((element) => element.isConnected).forEach(animateWithin);
        });
      });
      observer.observe(document.body, { childList: true, subtree: true });
      return () => {
        observer.disconnect();
        if (animationFrame) cancelAnimationFrame(animationFrame);
      };
    });

    return () => scope.revert();
  }, [pathname]);

  return null;
}
