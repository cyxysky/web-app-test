import type { StepToolCall } from '@/server/ai/schemas/runtime.schema';

function tokenCount(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function elapsedMilliseconds(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

export function browserChatToolContextTokenMetrics(tool: Pick<StepToolCall, 'contextAfter' | 'contextBefore'>) {
  const before = tokenCount(tool.contextBefore?.estimatedTotalTokens);
  const after = tokenCount(tool.contextAfter?.estimatedTotalTokens);
  return {
    before,
    after,
    delta: before !== undefined && after !== undefined ? after - before : undefined,
  };
}

export function browserChatToolTimingMetrics(tool: Pick<StepToolCall, 'aiRequestElapsedMs' | 'elapsedMs'>) {
  return {
    toolElapsedMs: elapsedMilliseconds(tool.elapsedMs),
    aiRequestElapsedMs: elapsedMilliseconds(tool.aiRequestElapsedMs),
  };
}
