'use client';

import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export type BorderBeamProps = {
  anchor?: number;
  borderWidth?: number;
  className?: string;
  colorFrom?: string;
  colorTo?: string;
  delay?: number;
  duration?: number;
  size?: number;
};

export function BorderBeam({
  anchor = 90,
  borderWidth = 1.5,
  className,
  colorFrom = '#f59e0b',
  colorTo = '#7c3aed',
  delay = 0,
  duration = 7,
  size = 72,
}: BorderBeamProps) {
  const reduceMotion = useReducedMotion();
  const host = useRef<HTMLDivElement>(null);
  const gradientId = `border-beam-${useId().replace(/:/g, '')}`;
  const [bounds, setBounds] = useState({ width: 0, height: 0, radius: 0 });
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      const radius = parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0;
      setBounds({ width, height, radius: Math.min(radius, width / 2, height / 2) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const inset = borderWidth / 2;
  const width = Math.max(0, bounds.width - borderWidth);
  const height = Math.max(0, bounds.height - borderWidth);
  const radius = Math.max(0, bounds.radius - inset);
  const perimeter = Math.max(1, 2 * (width + height) - (8 - 2 * Math.PI) * radius);
  const segment = Math.min(size, perimeter / 3);
  const offset = perimeter * anchor / 100;
  return (
    <div
      ref={host}
      aria-hidden="true"
      className={cn('pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]', className)}
    >
      {width > 0 && height > 0 ? (
        <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${bounds.width} ${bounds.height}`} fill="none">
          <defs>
            <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor={colorFrom} />
              <stop offset="50%" stopColor={colorTo} />
              <stop offset="100%" stopColor={colorFrom} />
            </linearGradient>
          </defs>
          <motion.rect
            x={inset} y={inset} width={width} height={height} rx={radius}
            stroke={`url(#${gradientId})`} strokeWidth={borderWidth} strokeLinecap="round"
            strokeDasharray={`${segment} ${perimeter - segment}`}
            initial={false}
            animate={{ strokeDashoffset: reduceMotion ? offset : [offset, offset - perimeter] }}
            transition={reduceMotion ? { duration: 0 } : { delay: -delay, duration, ease: 'linear', repeat: Infinity }}
          />
        </svg>
      ) : null}
    </div>
  );
}
