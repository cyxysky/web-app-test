const controllers = new Map<string, AbortController>();

// 生成运行步骤级别的控制器 key，确保同一次运行的不同步骤可以分别中断。
function key(runId: string, stepIndex: number) {
  return `${runId}:${stepIndex}`;
}

// 注册当前步骤的 AbortController，供跳过、暂停或停止时主动取消 AI 请求。
export function registerStepAbortController(runId: string, stepIndex: number) {
  const controller = new AbortController();
  controllers.set(key(runId, stepIndex), controller);
  return controller;
}

// 步骤结束后清理控制器，避免后续步骤误中断或内存残留。
export function clearStepAbortController(runId: string, stepIndex: number) {
  controllers.delete(key(runId, stepIndex));
}

// 中断指定运行的当前步骤；未传 stepIndex 时会中断该运行下所有已注册步骤。
export function abortRunStep(runId: string, stepIndex?: number) {
  let aborted = false;
  for (const [controllerKey, controller] of controllers.entries()) {
    if (!controllerKey.startsWith(`${runId}:`)) continue;
    if (stepIndex && controllerKey !== key(runId, stepIndex)) continue;
    controller.abort();
    controllers.delete(controllerKey);
    aborted = true;
  }
  return aborted;
}
