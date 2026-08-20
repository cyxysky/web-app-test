'use client';

import { useEffect, useRef } from 'react';
import { useInView, useMotionValue, useMotionValueEvent, useReducedMotion, useSpring } from 'motion/react';
import { cn } from '@/lib/utils';

export type NumberTickerProps = {
  className?: string;
  decimalPlaces?: number;
  delay?: number;
  prefix?: string;
  suffix?: string;
  value: number;
};

function formatTickerValue(value: number, decimalPlaces: number, prefix: string, suffix: string) {
  return `${prefix}${Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: decimalPlaces,
    minimumFractionDigits: decimalPlaces,
  }).format(value)}${suffix}`;
}

export function NumberTicker({
  className,
  decimalPlaces = 0,
  delay = 0,
  prefix = '',
  suffix = '',
  value,
}: NumberTickerProps) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const motionValue = useMotionValue(0);
  const springValue = useSpring(motionValue, { damping: 60, stiffness: 100 });
  const isInView = useInView(ref, { once: true, margin: '0px' });
  const reduceMotion = useReducedMotion();
  useEffect(() => {
    if (!isInView) return undefined;
    if (reduceMotion) {
      motionValue.jump(value);
      if (ref.current) ref.current.textContent = formatTickerValue(value, decimalPlaces, prefix, suffix);
      return undefined;
    }
    const timer = window.setTimeout(() => motionValue.set(value), delay * 1000);
    return () => window.clearTimeout(timer);
  }, [decimalPlaces, delay, isInView, motionValue, prefix, reduceMotion, suffix, value]);

  useMotionValueEvent(springValue, 'change', (latest) => {
    if (ref.current) ref.current.textContent = formatTickerValue(latest, decimalPlaces, prefix, suffix);
  });

  return <span className={cn('tabular-nums', className)} ref={ref}>{formatTickerValue(reduceMotion ? value : 0, decimalPlaces, prefix, suffix)}</span>;
}
