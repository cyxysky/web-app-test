export function runtimeToolTraceId(input: {
  runId?: string;
  stepIndex?: number;
  traceIndex: number;
  timestamp?: number;
}) {
  return [
    input.runId || 'runtime',
    input.stepIndex || 0,
    input.traceIndex,
    (input.timestamp ?? Date.now()).toString(36),
  ].join(':');
}

export async function notifyRuntimeToolTrace<TTrace>(
  onToolTrace: ((trace: TTrace) => void | Promise<void>) | undefined,
  trace: TTrace,
) {
  try {
    await onToolTrace?.(trace);
  } catch (error) {
    console.warn('[browser-agent] Tool progress trace callback failed; browser action will continue.', error);
    // Progress persistence failures must not make a browser action look unexecuted.
  }
}
