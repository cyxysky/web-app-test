'use client';

import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type AnimatedShinyTextProps = HTMLAttributes<HTMLSpanElement> & {
  children: ReactNode;
  shimmerWidth?: number;
};

export function AnimatedShinyText({
  children,
  className,
  shimmerWidth = 100,
  style,
  ...props
}: AnimatedShinyTextProps) {
  return (
    <span
      className={cn('magic-animated-shiny-text', className)}
      style={{
        ...style,
        '--shiny-width': `${shimmerWidth}px`,
      } as CSSProperties}
      {...props}
    >
      {children}
    </span>
  );
}
