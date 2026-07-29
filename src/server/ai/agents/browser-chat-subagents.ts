export type BrowserChatSubagentSettled<TTask, TResult> = {
  task: TTask;
  result?: TResult;
  error?: unknown;
};

export function browserChatSubagentSuggestedSummaryChars() {
  const configured = Number(process.env.AI_SUBAGENT_RESULT_MAX_CHARS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : undefined;
}

export function preserveBrowserChatSubagentSummary(value: unknown) {
  const summary = typeof value === 'string' ? value : String(value || '');
  return {
    summary,
    summaryChars: summary.length,
    summaryOriginalChars: summary.length,
    summaryTruncated: false,
  };
}

const inFlightBatches = new Map<string, Promise<unknown>>();
const completedBatches = new Map<string, unknown>();
let activeSubagents = 0;
const subagentWaiters: Array<() => void> = [];

function subagentConcurrency() {
  const configured = Number(process.env.AI_SUBAGENT_CONCURRENCY || 3);
  return Number.isFinite(configured) ? Math.min(12, Math.max(1, Math.floor(configured))) : 3;
}

async function withSubagentSlot<TResult>(runner: () => Promise<TResult>) {
  if (activeSubagents >= subagentConcurrency()) {
    await new Promise<void>((resolve) => subagentWaiters.push(resolve));
  } else {
    activeSubagents += 1;
  }
  try {
    return await runner();
  } finally {
    const next = subagentWaiters.shift();
    if (next) next();
    else activeSubagents = Math.max(0, activeSubagents - 1);
  }
}

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
  activeSubagents = 0;
  subagentWaiters.splice(0).forEach((resolve) => resolve());
}

/** Run independent child Agents without allowing one rejected branch to cancel siblings. */
export async function settleBrowserChatSubagents<TTask, TResult>(
  tasks: TTask[],
  runner: (task: TTask, index: number) => Promise<TResult>,
): Promise<Array<BrowserChatSubagentSettled<TTask, TResult>>> {
  const settled = await Promise.allSettled(tasks.map((task, index) => (
    withSubagentSlot(() => runner(task, index))
  )));
  return settled.map((item, index) => item.status === 'fulfilled'
    ? { task: tasks[index], result: item.value }
    : { task: tasks[index], error: item.reason });
}
