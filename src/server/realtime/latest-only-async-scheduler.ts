export type LatestOnlyAsyncScheduler<TKey, TValue> = {
  cancel: (key: TKey) => void;
  schedule: (key: TKey, value: TValue) => void;
};

export function createLatestOnlyAsyncScheduler<TKey, TValue>(options: {
  delayMs: () => number;
  publish: (key: TKey, value: TValue) => Promise<void>;
}): LatestOnlyAsyncScheduler<TKey, TValue> {
  const active = new Set<TKey>();
  const pending = new Map<TKey, TValue>();
  const timers = new Map<TKey, ReturnType<typeof setTimeout>>();

  const arm = (key: TKey) => {
    if (active.has(key) || timers.has(key) || !pending.has(key)) return;
    const timer = setTimeout(() => {
      timers.delete(key);
      const value = pending.get(key);
      if (value === undefined) return;
      pending.delete(key);
      active.add(key);
      void options.publish(key, value).catch(() => undefined).finally(() => {
        active.delete(key);
        arm(key);
      });
    }, options.delayMs());
    timer.unref?.();
    timers.set(key, timer);
  };

  return {
    cancel(key) {
      const timer = timers.get(key);
      if (timer) clearTimeout(timer);
      timers.delete(key);
      pending.delete(key);
    },
    schedule(key, value) {
      pending.set(key, value);
      arm(key);
    },
  };
}
