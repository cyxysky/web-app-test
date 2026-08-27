'use client';

import { memo } from 'react';
import {
  AnimatePresence,
  motion,
  type DOMMotionComponents,
  type MotionProps,
  type Variants,
} from 'motion/react';
import { cn } from '@/lib/utils';

type AnimationType = 'character' | 'line' | 'text' | 'word';
type AnimationVariant = 'blurIn' | 'blurInUp' | 'fadeIn' | 'slideUp';
type MotionElementType = Extract<
  keyof DOMMotionComponents,
  'article' | 'div' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'li' | 'p' | 'section' | 'span'
>;

const motionElements = {
  article: motion.article,
  div: motion.div,
  h1: motion.h1,
  h2: motion.h2,
  h3: motion.h3,
  h4: motion.h4,
  h5: motion.h5,
  h6: motion.h6,
  li: motion.li,
  p: motion.p,
  section: motion.section,
  span: motion.span,
} as const;

const containerVariants: Variants = {
  exit: { opacity: 0 },
  hidden: { opacity: 1 },
  show: { opacity: 1 },
};

const itemVariants: Record<AnimationVariant, Variants> = {
  blurIn: {
    hidden: { filter: 'blur(10px)', opacity: 0 },
    show: { filter: 'blur(0px)', opacity: 1 },
  },
  blurInUp: {
    hidden: { filter: 'blur(10px)', opacity: 0, y: 20 },
    show: { filter: 'blur(0px)', opacity: 1, y: 0 },
  },
  fadeIn: {
    hidden: { opacity: 0, y: 12 },
    show: { opacity: 1, y: 0 },
  },
  slideUp: {
    hidden: { opacity: 0, y: 20 },
    show: { opacity: 1, y: 0 },
  },
};

export interface TextAnimateProps extends Omit<MotionProps, 'children'> {
  accessible?: boolean;
  animation?: AnimationVariant;
  as?: MotionElementType;
  by?: AnimationType;
  children: string;
  className?: string;
  delay?: number;
  duration?: number;
  once?: boolean;
  segmentClassName?: string;
  startOnView?: boolean;
}

function splitText(text: string, by: AnimationType) {
  if (by === 'word') return text.split(/(\s+)/);
  if (by === 'character') return Array.from(text);
  if (by === 'line') return text.split('\n');
  return [text];
}

const TextAnimateBase = ({
  accessible = true,
  animation = 'fadeIn',
  as: Component = 'p',
  by = 'word',
  children,
  className,
  delay = 0,
  duration = 0.3,
  once = false,
  segmentClassName,
  startOnView = true,
  ...props
}: TextAnimateProps) => {
  const MotionComponent = motionElements[Component];
  const segments = splitText(children, by);
  const stagger = duration / Math.max(segments.length, 1);
  const finalContainerVariants: Variants = {
    ...containerVariants,
    exit: {
      opacity: 0,
      transition: { staggerChildren: stagger, staggerDirection: -1 },
    },
    show: {
      opacity: 1,
      transition: { delayChildren: delay, staggerChildren: stagger },
    },
  };
  const finalItemVariants: Variants = {
    ...itemVariants[animation],
    show: {
      ...itemVariants[animation].show,
      transition: {
        duration: Math.min(0.5, Math.max(0.24, duration)),
        ease: [0.22, 1, 0.36, 1],
      },
    },
  };

  return (
    <AnimatePresence mode="popLayout">
      <MotionComponent
        animate={startOnView ? undefined : 'show'}
        aria-label={accessible ? children : undefined}
        className={cn('text-animate', className)}
        exit="exit"
        initial="hidden"
        variants={finalContainerVariants}
        viewport={{ once }}
        whileInView={startOnView ? 'show' : undefined}
        {...props}
      >
        {accessible ? <span className="sr-only">{children}</span> : null}
        {segments.map((segment, index) => (
          <motion.span
            aria-hidden={accessible ? true : undefined}
            className={cn(by === 'line' ? 'text-animate-line' : 'text-animate-segment', segmentClassName)}
            key={`${by}-${segment}-${index}`}
            variants={finalItemVariants}
          >
            {segment}
          </motion.span>
        ))}
      </MotionComponent>
    </AnimatePresence>
  );
};

export const TextAnimate = memo(TextAnimateBase);
