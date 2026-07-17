'use client';

import { useCallback, useRef, useState } from 'react';
import { startGlobalLoading, stopGlobalLoading } from '@/lib/global-loading';

export function useApiAction() {
  const runningRef = useRef(false);
  const [running, setRunning] = useState(false);

  const run = useCallback(async <T,>(action: () => Promise<T>, options: { loadingLabel?: string } = {}) => {
    if (runningRef.current) return undefined;
    runningRef.current = true;
    setRunning(true);
    if (options.loadingLabel) startGlobalLoading(options.loadingLabel);
    try {
      return await action();
    } finally {
      if (options.loadingLabel) stopGlobalLoading();
      runningRef.current = false;
      setRunning(false);
    }
  }, []);

  return { run, running };
}
