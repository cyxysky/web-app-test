'use client';

import { motion, useReducedMotion } from 'motion/react';
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
  return (
    <div
      aria-hidden="true"
      className={cn('pointer-events-none absolute inset-0 rounded-[inherit]', className)}
      style={{
        border: `${borderWidth}px solid transparent`,
        maskClip: 'padding-box, border-box',
        maskComposite: 'intersect',
        maskImage: 'linear-gradient(transparent, transparent), linear-gradient(#000, #000)',
        WebkitMaskClip: 'padding-box, border-box',
        WebkitMaskComposite: 'source-in',
        WebkitMaskImage: 'linear-gradient(transparent, transparent), linear-gradient(#000, #000)',
      }}
    >
      <motion.div
        className="absolute aspect-square"
        style={{
          background: `linear-gradient(to left, ${colorFrom}, ${colorTo}, transparent)`,
          offsetPath: `rect(0 auto auto 0 round ${anchor}%)`,
          width: size,
        }}
        animate={reduceMotion ? { offsetDistance: '18%' } : { offsetDistance: ['0%', '100%'] }}
        transition={reduceMotion ? undefined : { delay: -delay, duration, ease: 'linear', repeat: Infinity }}
      />
    </div>
  );
}
