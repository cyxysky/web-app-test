'use client';

import { Moon, Sun } from 'lucide-react';
import { flushSync } from 'react-dom';
import { useCallback, useEffect, useRef, type ButtonHTMLAttributes, type MouseEvent } from 'react';
import { cn } from '@/lib/utils';

type ThemeValue = 'light' | 'dark';

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => {
    finished: Promise<void>;
    ready: Promise<void>;
  };
};

export type AnimatedThemeTogglerProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  duration?: number;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  onThemeChange: (theme: ThemeValue) => void;
  theme: ThemeValue;
};

export function AnimatedThemeToggler({
  className,
  duration = 400,
  onClick,
  onThemeChange,
  theme,
  ...props
}: AnimatedThemeTogglerProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const transitionRunningRef = useRef(false);
  const animationRef = useRef<Animation | null>(null);
  const fallbackLayerRef = useRef<HTMLSpanElement | null>(null);

  const finishTransition = useCallback(() => {
    transitionRunningRef.current = false;
    animationRef.current?.cancel();
    animationRef.current = null;
    fallbackLayerRef.current?.remove();
    fallbackLayerRef.current = null;
    const root = document.documentElement;
    delete root.dataset.magicuiThemeVt;
    root.style.removeProperty('--magicui-theme-toggle-vt-duration');
    root.style.removeProperty('--magicui-theme-vt-clip-from');
  }, []);

  useEffect(() => finishTransition, [finishTransition]);

  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    if (transitionRunningRef.current) return;

    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    const doc = document as ViewTransitionDocument;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      onThemeChange(nextTheme);
      return;
    }

    const button = buttonRef.current;
    if (!button) return;
    const bounds = button.getBoundingClientRect();
    const x = bounds.left + bounds.width / 2;
    const y = bounds.top + bounds.height / 2;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const radius = Math.hypot(
      Math.max(x, viewportWidth - x),
      Math.max(y, viewportHeight - y),
    );
    const point = `${(x / viewportWidth) * 100}% ${(y / viewportHeight) * 100}%`;
    const relativeRadius = `${(radius / (Math.hypot(viewportWidth, viewportHeight) / Math.SQRT2)) * 100}%`;
    const clipPath = [`circle(0% at ${point})`, `circle(${relativeRadius} at ${point})`];
    const root = document.documentElement;

    if (!doc.startViewTransition) {
      const fallbackLayer = document.createElement('span');
      fallbackLayer.className = 'magicui-theme-toggle-fallback';
      fallbackLayer.setAttribute('aria-hidden', 'true');
      document.body.append(fallbackLayer);
      fallbackLayerRef.current = fallbackLayer;
      transitionRunningRef.current = true;
      const fallbackAnimation = fallbackLayer.animate(
        { clipPath },
        { duration, easing: 'ease-in-out', fill: 'forwards' },
      );
      animationRef.current = fallbackAnimation;
      void fallbackAnimation.finished.then(() => {
        flushSync(() => onThemeChange(nextTheme));
      }).finally(finishTransition).catch(() => undefined);
      return;
    }

    transitionRunningRef.current = true;
    root.dataset.magicuiThemeVt = 'active';
    root.style.setProperty('--magicui-theme-toggle-vt-duration', `${duration}ms`);
    root.style.setProperty('--magicui-theme-vt-clip-from', clipPath[0]);

    const transition = doc.startViewTransition(() => flushSync(() => onThemeChange(nextTheme)));
    void transition.finished.finally(finishTransition).catch(() => undefined);
    void transition.ready.then(() => {
      animationRef.current = root.animate(
        { clipPath },
        {
          duration,
          easing: 'ease-in-out',
          fill: 'forwards',
          pseudoElement: '::view-transition-new(root)',
        },
      );
    }).catch(finishTransition);
  };

  return (
    <button className={cn(className)} onClick={toggle} ref={buttonRef} type="button" {...props}>
      {theme === 'dark' ? <Sun aria-hidden="true" size={17} /> : <Moon aria-hidden="true" size={17} />}
    </button>
  );
}
