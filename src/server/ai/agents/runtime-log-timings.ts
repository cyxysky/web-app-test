import { finiteNumber } from '@/lib/unknown-value';

export type RuntimeToolTimingTrace = {
  actionElapsedMs?: unknown;
  completedAt?: unknown;
  elapsedMs?: unknown;
  name?: unknown;
  postprocessTimings?: unknown;
  startedAt?: unknown;
};

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : String(value || '');
}

function numericRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const output: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    const numberValue = finiteNumber(raw);
    if (numberValue !== undefined) output[key] = numberValue;
  }
  return Object.keys(output).length ? output : undefined;
}

function traceElapsedMs(trace: RuntimeToolTimingTrace) {
  const explicit = finiteNumber(trace.elapsedMs);
  if (explicit !== undefined) return explicit;
  const startedAt = finiteNumber(trace.startedAt);
  const completedAt = finiteNumber(trace.completedAt);
  return startedAt !== undefined && completedAt !== undefined && completedAt >= startedAt
    ? completedAt - startedAt
    : undefined;
}

export function summarizeRuntimeLogTimings(input: {
  aiElapsedMs?: number;
  stepStartedAt?: number;
  totalElapsedMs: number;
  traces?: RuntimeToolTimingTrace[];
}) {
  const tools = (input.traces || [])
    .map((trace) => {
      const traceElapsed = traceElapsedMs(trace);
      const actionElapsed = finiteNumber(trace.actionElapsedMs);
      const elapsedMs = actionElapsed ?? traceElapsed;
      const overheadElapsedMs = traceElapsed !== undefined && actionElapsed !== undefined
        ? Math.max(0, traceElapsed - actionElapsed)
        : undefined;
      return {
        name: stringValue(trace.name),
        elapsedMs,
        actionElapsedMs: actionElapsed,
        overheadElapsedMs,
        postprocessTimings: numericRecord(trace.postprocessTimings),
        traceElapsedMs: traceElapsed,
        startedAt: finiteNumber(trace.startedAt),
        completedAt: finiteNumber(trace.completedAt),
      };
    })
    .filter((trace) => trace.name || trace.elapsedMs !== undefined);
  const toolElapsedMs = tools.reduce((total, trace) => total + (trace.elapsedMs || 0), 0);
  const toolOverheadElapsedMs = tools.reduce((total, trace) => total + (trace.overheadElapsedMs || 0), 0);
  const firstToolStartedAt = tools
    .map((trace) => trace.startedAt)
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => a - b)[0];
  const inferredAiElapsedMs = input.stepStartedAt !== undefined && firstToolStartedAt !== undefined
    ? Math.max(0, firstToolStartedAt - input.stepStartedAt)
    : Math.max(0, input.totalElapsedMs - toolElapsedMs);
  const aiRequestElapsedMs = finiteNumber(input.aiElapsedMs) ?? inferredAiElapsedMs;

  return {
    totalElapsedMs: input.totalElapsedMs,
    aiRequestElapsedMs,
    toolElapsedMs,
    toolOverheadElapsedMs,
    otherElapsedMs: Math.max(0, input.totalElapsedMs - aiRequestElapsedMs - toolElapsedMs - toolOverheadElapsedMs),
    toolCount: tools.length,
    tools,
  };
}
