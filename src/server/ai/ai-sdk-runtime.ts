import type { LanguageModelCallOptions, TelemetryOptions } from 'ai';

export type AiReasoningEffort = NonNullable<LanguageModelCallOptions['reasoning']>;

const reasoningEfforts = new Set<AiReasoningEffort>([
  'provider-default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function aiReasoningEffort(): AiReasoningEffort | undefined {
  const value = String(process.env.AI_REASONING_EFFORT || '').trim() as AiReasoningEffort;
  return reasoningEfforts.has(value) && value !== 'provider-default' ? value : undefined;
}

export function aiRequestTimeoutMs(fallback = 30_000) {
  return positiveInteger(process.env.AI_REQUEST_TIMEOUT_MS, fallback);
}

export function aiStreamTimeouts() {
  const requestMs = aiRequestTimeoutMs();
  const toolMs = positiveInteger(process.env.AI_TOOL_TIMEOUT_MS, 120_000);
  const configuredChunkMs = positiveInteger(process.env.AI_STREAM_CHUNK_TIMEOUT_MS, requestMs);
  return {
    firstChunkMs: positiveInteger(process.env.AI_STREAM_FIRST_CHUNK_TIMEOUT_MS, requestMs),
    // AI SDK keeps the inter-chunk timer running while a tool executes. Keep
    // it above the complete tool window so a successful long-running tool does
    // not abort the stream before the following model step can begin.
    chunkMs: Math.max(configuredChunkMs, toolMs + requestMs),
    toolMs,
  };
}

export function aiTelemetry(functionId: string): TelemetryOptions {
  return {
    isEnabled: process.env.AI_TELEMETRY_ENABLED !== 'false',
    functionId,
    recordInputs: false,
    recordOutputs: false,
  };
}
