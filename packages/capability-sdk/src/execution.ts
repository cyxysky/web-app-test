import type { CapabilityExecutionContext, CapabilityProgressEvent, ResolvedCapabilityTool } from './index.js';

export type CapabilityExecutionPolicyOptions = {
  authorize?(permissions: readonly string[], tool: ResolvedCapabilityTool, context: CapabilityExecutionContext): void | Promise<void>;
  prerequisite?(name: string, tool: ResolvedCapabilityTool, context: CapabilityExecutionContext): void | Promise<void>;
  reportProgress?(event: CapabilityProgressEvent, context: CapabilityExecutionContext): void | Promise<void>;
};

/** One executor per mounted run; serial groups stay locked until the operation actually ends. */
export function createCapabilityExecutor(options: CapabilityExecutionPolicyOptions = {}) {
  const queues = new Map<string, Promise<void>>();
  return async <T>(tool: ResolvedCapabilityTool, context: CapabilityExecutionContext, invoke: (context: CapabilityExecutionContext) => Promise<T>): Promise<T> => {
    const run = async () => {
      context.abortSignal?.throwIfAborted();
      await options.authorize?.(tool.tool.policy?.permissions || [], tool, context);
      const prerequisite = tool.tool.policy?.prerequisite;
      if (prerequisite) {
        if (!options.prerequisite) throw new Error(`No host handler for prerequisite: ${prerequisite}.`);
        await options.prerequisite(prerequisite, tool, context);
      }
      context.abortSignal?.throwIfAborted();
      return invoke({ ...context, reportProgress: context.reportProgress || (options.reportProgress ? (event) => options.reportProgress!(event, context) : undefined) });
    };
    if (tool.tool.policy?.concurrency !== 'serial') return run();
    const group = tool.tool.policy.concurrencyGroup || tool.internalId;
    const pending = (queues.get(group) || Promise.resolve()).then(run);
    const tail = pending.then(() => undefined, () => undefined);
    queues.set(group, tail);
    void tail.then(() => { if (queues.get(group) === tail) queues.delete(group); });
    return pending;
  };
}

export function disposeOnce(dispose: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => pending ||= Promise.resolve().then(dispose);
}
