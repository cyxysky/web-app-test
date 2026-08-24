'use client';

import { useEffect } from 'react';
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform } from 'motion/react';
import { cn } from '@/lib/utils';

export type AnimatedCircularProgressBarProps = {
  className?: string;
  gaugePrimaryColor?: string;
  gaugeSecondaryColor?: string;
  max?: number;
  min?: number;
  size?: number;
  strokeWidth?: number;
  value?: number;
};

export function AnimatedCircularProgressBar({
  className,
  gaugePrimaryColor = 'var(--accent-strong)',
  gaugeSecondaryColor = 'color-mix(in srgb, var(--foreground) 10%, transparent)',
  max = 100,
  min = 0,
  size = 30,
  strokeWidth = 3,
  value = 0,
}: AnimatedCircularProgressBarProps) {
  const reduceMotion = useReducedMotion();
  const safeRange = Math.max(1, max - min);
  const clamped = Math.min(max, Math.max(min, value));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const targetProgress = (clamped - min) / safeRange;
  const progress = useMotionValue(reduceMotion ? targetProgress : 0);
  const spring = useSpring(progress, { damping: 24, stiffness: 62 });
  const dashOffset = useTransform(spring, (latest) => circumference * (1 - latest));

  useEffect(() => {
    if (reduceMotion) {
      progress.jump(targetProgress);
      return undefined;
    }

    const frame = window.requestAnimationFrame(() => progress.set(targetProgress));
    return () => window.cancelAnimationFrame(frame);
  }, [progress, reduceMotion, targetProgress]);

  return (
    <svg
      aria-hidden="true"
      className={cn('magic-circular-progress', className)}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      width={size}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        fill="none"
        r={radius}
        stroke={gaugeSecondaryColor}
        strokeWidth={strokeWidth}
      />
      <motion.circle
        cx={size / 2}
        cy={size / 2}
        fill="none"
        r={radius}
        stroke={gaugePrimaryColor}
        strokeDasharray={circumference}
        strokeLinecap="round"
        strokeWidth={strokeWidth}
        style={{ strokeDashoffset: dashOffset }}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}
