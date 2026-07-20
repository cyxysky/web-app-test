export type BrowserChatSubagentSettled<TTask, TResult> = {
  task: TTask;
  result?: TResult;
  error?: unknown;
};

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
