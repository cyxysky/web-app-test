'use client';

import { useEffect, useState } from 'react';

const DRIVE_DELAYS = Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3);
  const column = index % 3;
  return (column + Math.abs(row - 1)) * 90;
});

function useElapsedTime(enabled = true) {
  const [deciseconds, setDeciseconds] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    const timer = window.setInterval(() => setDeciseconds((current) => current + 1), 100);
    return () => window.clearInterval(timer);
  }, [enabled]);

  if (!enabled) return '';

  const seconds = deciseconds / 10;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s`;
}

export function BeautifulLoadingState({
  className = '',
  detail,
  label,
  showElapsed = true,
  variant = 'grid',
}: {
  className?: string;
  detail?: string;
  label: string;
  showElapsed?: boolean;
  variant?: 'grid' | 'orbit';
}) {
  const elapsed = useElapsedTime(showElapsed);

  return (
    <div className={`beautiful-loading-state${className ? ` ${className}` : ''}`} role="status">
      {variant === 'orbit' ? (
        <span aria-hidden="true" className="beautiful-loading-orbit" />
      ) : (
        <span aria-hidden="true" className="beautiful-loading-grid">
          {DRIVE_DELAYS.map((delay, index) => (
            <span
              className="beautiful-loading-pixel"
              key={index}
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </span>
      )}
      <span className="beautiful-loading-copy">
        <span className="beautiful-loading-label">{label}</span>
        {detail ? <small>{detail}</small> : null}
      </span>
      {showElapsed ? <span className="beautiful-loading-elapsed">{elapsed}</span> : null}
    </div>
  );
}
