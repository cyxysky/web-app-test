const controllers = new Map<string, AbortController>();

function key(runId: string, stepIndex: number) {
  return `${runId}:${stepIndex}`;
}

export function registerStepAbortController(runId: string, stepIndex: number) {
  const controller = new AbortController();
  controllers.set(key(runId, stepIndex), controller);
  return controller;
}

export function clearStepAbortController(runId: string, stepIndex: number) {
  controllers.delete(key(runId, stepIndex));
}

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
