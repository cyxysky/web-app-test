'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type ProgressiveBlurProps = {
  blurLevels?: number[];
  children?: ReactNode;
  className?: string;
  height?: string;
  position?: 'top' | 'bottom' | 'both';
};

export function ProgressiveBlur({
  blurLevels = [0.5, 1, 2, 4, 8, 16, 32, 64],
  children,
  className,
  height = '30%',
  position = 'bottom',
}: ProgressiveBlurProps) {
  const directions = position === 'both' ? ['top', 'bottom'] as const : [position] as const;
  return (
    <>
      {directions.map((direction) => (
        <div
          aria-hidden="true"
          className={cn('pointer-events-none absolute inset-x-0 z-10 overflow-hidden', direction === 'top' ? 'top-0' : 'bottom-0', className)}
          key={direction}
          style={{ height }}
        >
          {blurLevels.map((blur, index) => {
            const start = Math.max(0, (index - 1) / blurLevels.length * 100);
            const middle = (index + 1) / blurLevels.length * 100;
            const end = Math.min(100, (index + 2) / blurLevels.length * 100);
            const maskDirection = direction === 'top' ? 'to top' : 'to bottom';
            const mask = `linear-gradient(${maskDirection}, transparent ${start}%, black ${middle}%, transparent ${end}%)`;
            return (
              <div
                className="absolute inset-0"
                key={`${direction}-${blur}`}
                style={{
                  backdropFilter: `blur(${blur}px)`,
                  maskImage: mask,
                  WebkitBackdropFilter: `blur(${blur}px)`,
                  WebkitMaskImage: mask,
                }}
              />
            );
          })}
          {children}
        </div>
      ))}
    </>
  );
}
