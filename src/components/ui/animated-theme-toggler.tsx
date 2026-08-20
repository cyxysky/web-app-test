'use client';

import { flushSync } from 'react-dom';
import type { ButtonHTMLAttributes, MouseEvent } from 'react';
import { cn } from '@/lib/utils';

type ThemeValue = 'light' | 'dark';

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { ready: Promise<void> };
};

export type AnimatedThemeTogglerProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  duration?: number;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  onThemeChange: (theme: ThemeValue) => void;
  theme: ThemeValue;
};

export function AnimatedThemeToggler({
  children,
  className,
  duration = 430,
  onClick,
  onThemeChange,
  theme,
  ...props
}: AnimatedThemeTogglerProps) {
  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    const doc = document as ViewTransitionDocument;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!doc.startViewTransition || reduceMotion) {
      onThemeChange(nextTheme);
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = bounds.left + bounds.width / 2;
    const y = bounds.top + bounds.height / 2;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    const transition = doc.startViewTransition(() => flushSync(() => onThemeChange(nextTheme)));
    void transition.ready.then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        {
          duration,
          easing: 'cubic-bezier(.16, 1, .3, 1)',
          pseudoElement: '::view-transition-new(root)',
        },
      );
    });
  };

  return (
    <button className={cn(className)} onClick={toggle} type="button" {...props}>
      {children}
    </button>
  );
}
