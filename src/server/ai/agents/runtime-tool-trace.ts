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

export type RuntimeToolTraceOutcome = {
  result?: { ok?: boolean };
  recovered?: boolean;
  transient?: boolean;
};

export function markRuntimeToolTraceRecovered<TTrace extends RuntimeToolTraceOutcome>(trace: TTrace) {
  trace.recovered = true;
  trace.transient = true;
  return trace;
}

export function isRecoveredTransientToolTrace(trace: RuntimeToolTraceOutcome) {
  return trace.recovered === true && trace.transient === true;
}

export function isEffectiveToolTraceFailure(trace: RuntimeToolTraceOutcome) {
  return trace.result?.ok === false && !isRecoveredTransientToolTrace(trace);
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
