export type BrowserChatSubagentSettled<TTask, TResult> = {
  task: TTask;
  result?: TResult;
  error?: unknown;
};

const inFlightBatches = new Map<string, Promise<unknown>>();
const completedBatches = new Map<string, unknown>();

/** Reuse the original child-Agent barrier when a main-Agent attempt repeats a batch. */
export async function runOrReuseBrowserChatSubagentBatch<TResult>(
  key: string,
  runner: () => Promise<TResult>,
): Promise<TResult> {
  if (completedBatches.has(key)) return completedBatches.get(key) as TResult;
  const existing = inFlightBatches.get(key);
  if (existing) return existing as Promise<TResult>;

  const promise = runner();
  inFlightBatches.set(key, promise);
  try {
    const result = await promise;
    completedBatches.set(key, result);
    while (completedBatches.size > 200) {
      const oldest = completedBatches.keys().next().value as string | undefined;
      if (!oldest) break;
      completedBatches.delete(oldest);
    }
    return result;
  } finally {
    if (inFlightBatches.get(key) === promise) inFlightBatches.delete(key);
  }
}

export function clearBrowserChatSubagentBatchRegistryForTests() {
  inFlightBatches.clear();
  completedBatches.clear();
}

/** Run independent child Agents without allowing one rejected branch to cancel siblings. */
export async function settleBrowserChatSubagents<TTask, TResult>(
  tasks: TTask[],
  runner: (task: TTask, index: number) => Promise<TResult>,
): Promise<Array<BrowserChatSubagentSettled<TTask, TResult>>> {
  const settled = await Promise.allSettled(tasks.map(runner));
  return settled.map((item, index) => item.status === 'fulfilled'
    ? { task: tasks[index], result: item.value }
    : { task: tasks[index], error: item.reason });
}
