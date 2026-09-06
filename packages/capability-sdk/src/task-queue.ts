export type CapabilityTaskOptions = {
  abortSignal?: AbortSignal;
  queueTimeoutMs?: number;
  executionTimeoutMs?: number;
};

type Task = {
  run(signal: AbortSignal): Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  controller: AbortController;
  cleanup(): void;
  executionTimeoutMs?: number;
};

/** Cancellation removes queued work immediately; running work owns its slot until cleanup finishes. */
export class CapabilityTaskQueue {
  private readonly waiting: Task[] = [];
  private readonly active = new Set<Task>();
  private readonly idleWaiters = new Set<() => void>();

  constructor(private readonly options: { concurrency?: number; maxQueued?: number; queueTimeoutMs?: number } = {}) {}

  run<T>(operation: (signal: AbortSignal) => Promise<T>, options: CapabilityTaskOptions = {}): Promise<T> {
    if (options.abortSignal?.aborted) return Promise.reject(options.abortSignal.reason);
    const concurrency = Math.max(1, this.options.concurrency || 1);
    if (this.active.size >= concurrency && this.waiting.length >= (this.options.maxQueued ?? 64)) {
      return Promise.reject(new Error('Task queue capacity reached. Retry after an active task completes.'));
    }
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      let queueTimer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        controller.abort(options.abortSignal?.reason || new Error('Task aborted.'));
        const index = this.waiting.indexOf(task);
        if (index >= 0) {
          this.waiting.splice(index, 1);
          task.cleanup();
          reject(controller.signal.reason);
          this.notifyIdle();
        }
      };
      const task: Task = {
        run: operation,
        resolve: (value) => resolve(value as T),
        reject,
        controller,
        executionTimeoutMs: options.executionTimeoutMs,
        cleanup: () => {
          if (queueTimer) clearTimeout(queueTimer);
          options.abortSignal?.removeEventListener('abort', onAbort);
        },
      };
      options.abortSignal?.addEventListener('abort', onAbort, { once: true });
      const queueTimeout = options.queueTimeoutMs ?? this.options.queueTimeoutMs ?? 120_000;
      if (queueTimeout > 0) queueTimer = setTimeout(() => {
        const index = this.waiting.indexOf(task);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        task.cleanup();
        reject(new Error(`Task queue wait timed out after ${queueTimeout}ms.`));
        this.notifyIdle();
      }, queueTimeout);
      // Stop only the queue timer when dispatched; retain the caller's abort listener.
      const run = task.run;
      task.run = (signal) => {
        if (queueTimer) clearTimeout(queueTimer);
        return run(signal);
      };
      this.waiting.push(task);
      this.dispatch();
    });
  }

  snapshot() { return { active: this.active.size, queued: this.waiting.length }; }

  cancel(reason: Error = new Error('Task queue cancelled.')) {
    for (const task of this.waiting.splice(0)) {
      task.cleanup();
      task.controller.abort(reason);
      task.reject(reason);
    }
    for (const task of this.active) task.controller.abort(reason);
    this.notifyIdle();
  }

  idle(): Promise<void> {
    if (!this.active.size && !this.waiting.length) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private notifyIdle() {
    if (this.active.size || this.waiting.length) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private dispatch() {
    const concurrency = Math.max(1, this.options.concurrency || 1);
    while (this.active.size < concurrency && this.waiting.length) {
      const task = this.waiting.shift()!;
      this.active.add(task);
      const timer = task.executionTimeoutMs && task.executionTimeoutMs > 0
        ? setTimeout(() => task.controller.abort(new Error(`Task execution timed out after ${task.executionTimeoutMs}ms.`)), task.executionTimeoutMs)
        : undefined;
      void Promise.resolve().then(() => {
        task.controller.signal.throwIfAborted();
        return task.run(task.controller.signal);
      }).then(task.resolve, task.reject).finally(() => {
        if (timer) clearTimeout(timer);
        task.cleanup();
        this.active.delete(task);
        this.dispatch();
        this.notifyIdle();
      });
    }
  }
}
