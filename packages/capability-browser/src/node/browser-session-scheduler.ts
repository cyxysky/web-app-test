import { AsyncLocalStorage } from 'node:async_hooks';
import { CapabilityTaskQueue } from '@webpilot/capability-sdk';

/** One transaction includes preparation, browser work and observation/cleanup. */
export class BrowserSessionScheduler {
  private readonly queue = new CapabilityTaskQueue({ maxQueued: 64, queueTimeoutMs: 120_000 });
  private readonly scope = new AsyncLocalStorage<{ active: boolean; signal: AbortSignal }>();

  run<T>(operation: (signal: AbortSignal) => Promise<T>, abortSignal?: AbortSignal): Promise<T> {
    const parent = this.scope.getStore();
    if (parent?.active) return operation(parent.signal);
    return this.queue.run(async (signal) => {
      const scope = { active: true, signal };
      try { return await this.scope.run(scope, () => operation(signal)); }
      finally { scope.active = false; }
    }, { abortSignal });
  }

  async cancelAndDrain() {
    this.queue.cancel(new Error('Browser session is closing.'));
    if (!this.scope.getStore()?.active) await this.queue.idle();
  }
}
