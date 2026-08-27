'use client';

import React, { memo } from 'react';
import { cn } from '@/lib/utils';

export interface AuroraTextProps {
  children: React.ReactNode;
  className?: string;
  colors?: string[];
  speed?: number;
}

export const AuroraText = memo(function AuroraText({
  children,
  className,
  colors = ['#FF0080', '#7928CA', '#0070F3', '#38bdf8'],
  speed = 1,
}: AuroraTextProps) {
  return (
    <span className={cn('aurora-text', className)}>
      <span className="sr-only">{children}</span>
      <span
        aria-hidden="true"
        className="aurora-text-surface"
        style={{
          animationDuration: `${10 / speed}s`,
          backgroundImage: `linear-gradient(135deg, ${colors.join(', ')}, ${colors[0]})`,
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
        }}
      >
        {children}
      </span>
    </span>
  );
});

AuroraText.displayName = 'AuroraText';
