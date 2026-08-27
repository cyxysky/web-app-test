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
  const step = 100 / blurLevels.length;
  const directions = position === 'both' ? ['top', 'bottom'] as const : [position] as const;
  return (
    <>
      {directions.map((direction) => (
        <div
          aria-hidden="true"
          className={cn('gradient-blur', className)}
          key={direction}
          style={{
            bottom: direction === 'bottom' ? 0 : undefined,
            height,
            left: 0,
            overflow: 'hidden',
            pointerEvents: 'none',
            position: 'absolute',
            right: 0,
            top: direction === 'top' ? 0 : undefined,
            zIndex: 10,
          }}
        >
          <div
            style={{
              backdropFilter: `blur(${blurLevels[0]}px)`,
              inset: 0,
              maskImage: `linear-gradient(to ${direction}, transparent 0%, black ${step}%, black ${step * 2}%, transparent ${step * 3}%)`,
              position: 'absolute',
              WebkitBackdropFilter: `blur(${blurLevels[0]}px)`,
              WebkitMaskImage: `linear-gradient(to ${direction}, transparent 0%, black ${step}%, black ${step * 2}%, transparent ${step * 3}%)`,
              zIndex: 1,
            }}
          />
          {blurLevels.slice(1, -1).map((blur, index) => {
            const blurIndex = index + 1;
            const start = blurIndex * step;
            const middle = (blurIndex + 1) * step;
            const end = (blurIndex + 2) * step;
            const mask = `linear-gradient(to ${direction}, transparent ${start}%, black ${middle}%, black ${end}%, transparent ${end + step}%)`;
            return <div key={`${direction}-${blur}`} style={{ backdropFilter: `blur(${blur}px)`, inset: 0, maskImage: mask, position: 'absolute', WebkitBackdropFilter: `blur(${blur}px)`, WebkitMaskImage: mask, zIndex: blurIndex + 1 }} />;
          })}
          <div
            style={{
              backdropFilter: `blur(${blurLevels[blurLevels.length - 1]}px)`,
              inset: 0,
              maskImage: `linear-gradient(to ${direction}, transparent ${100 - step}%, black 100%)`,
              position: 'absolute',
              WebkitBackdropFilter: `blur(${blurLevels[blurLevels.length - 1]}px)`,
              WebkitMaskImage: `linear-gradient(to ${direction}, transparent ${100 - step}%, black 100%)`,
              zIndex: blurLevels.length,
            }}
          />
          {children}
        </div>
      ))}
    </>
  );
}
