'use client';

import { useRef, type ReactNode } from 'react';
import { motion, useInView, useReducedMotion, type HTMLMotionProps, type Variants } from 'motion/react';
import { cn } from '@/lib/utils';

type BlurFadeDirection = 'up' | 'down' | 'left' | 'right';

export type BlurFadeProps = Omit<HTMLMotionProps<'div'>, 'children' | 'variants'> & {
  blur?: string;
  children: ReactNode;
  delay?: number;
  direction?: BlurFadeDirection;
  duration?: number;
  inView?: boolean;
  inViewMargin?: `${number}px` | `${number}%`;
  offset?: number;
  variants?: Variants;
};

export function BlurFade({
  blur = '6px',
  children,
  className,
  delay = 0,
  direction = 'down',
  duration = 0.4,
  inView = false,
  inViewMargin = '-50px',
  offset = 6,
  variants,
  ...props
}: BlurFadeProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const isInView = useInView(ref, { once: true, margin: inViewMargin });
  const reduceMotion = useReducedMotion();
  const axis = direction === 'left' || direction === 'right' ? 'x' : 'y';
  const sign = direction === 'right' || direction === 'down' ? -1 : 1;
  const defaultVariants: Variants = {
    hidden: {
      filter: `blur(${blur})`,
      opacity: 0,
      [axis]: sign * offset,
    },
    visible: {
      filter: 'blur(0px)',
      opacity: 1,
      [axis]: 0,
    },
  };

  return (
    <motion.div
      animate={reduceMotion || !inView || isInView ? 'visible' : 'hidden'}
      className={cn(className)}
      initial={reduceMotion ? 'visible' : 'hidden'}
      ref={ref}
      transition={{ delay, duration, ease: [0.16, 1, 0.3, 1] }}
      variants={variants || defaultVariants}
      {...props}
    >
      {children}
    </motion.div>
  );
}
