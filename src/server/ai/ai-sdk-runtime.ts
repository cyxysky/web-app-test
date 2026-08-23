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

export function aiRequestTimeoutMs(fallback = 120_000) {
  return positiveInteger(process.env.AI_REQUEST_TIMEOUT_MS, fallback);
}

/** Agent Loop requests can spend substantially longer on a large prompt before
 * emitting their first chunk. Keep this deadline separate from short auxiliary
 * model calls and expose it in runtime settings. */
export function aiRuntimeRequestTimeoutMs() {
  return positiveInteger(process.env.AI_RUNTIME_REQUEST_TIMEOUT_MS, 600_000);
}

/**
 * Providers can leave a stalled connection open even after the SDK timeout.
 * This watchdog has its own abort signal and a hard rejection deadline so the
 * runtime can record a terminal failure and apply its normal retry policy.
 */
export class AiRequestWatchdogTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`AI request watchdog timed out after ${timeoutMs}ms.`);
    this.name = 'AiRequestWatchdogTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export function createAiRequestWatchdog(parentSignal?: AbortSignal, timeoutMs = aiRequestTimeoutMs()) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let paused = false;
  let timeoutReject: ((reason: unknown) => void) | undefined;
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal) {
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener('abort', abortFromParent, { once: true });
  }
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const arm = () => {
    clear();
    if (paused || controller.signal.aborted) return;
    timer = setTimeout(() => {
      const error = new AiRequestWatchdogTimeoutError(timeoutMs);
      controller.abort(error);
      timeoutReject?.(error);
    }, timeoutMs);
  };
  return {
    abortSignal: controller.signal,
    touch: arm,
    pause() {
      paused = true;
      clear();
    },
    resume() {
      paused = false;
      arm();
    },
    async run<T>(operation: Promise<T>) {
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error('AI request was aborted before it started.');
      }
      arm();
      try {
        return await Promise.race([
          operation,
          new Promise<never>((_resolve, reject) => { timeoutReject = reject; }),
        ]);
      } finally {
        timeoutReject = undefined;
        clear();
      }
    },
    dispose() {
      clear();
      timeoutReject = undefined;
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

export function aiMaxOutputTokens(fallback = 32_768) {
  return Math.min(131_072, positiveInteger(process.env.AI_MAX_OUTPUT_TOKENS, fallback));
}

export function aiStreamTimeouts(requestTimeoutMs = aiRequestTimeoutMs()) {
  const requestMs = requestTimeoutMs;
  const toolMs = positiveInteger(process.env.AI_TOOL_TIMEOUT_MS, 120_000);
  // A stale per-stream setting must never undercut the active request
  // deadline. The first chunk has its own SDK timer, so enforce the same
  // lower bound here rather than only on the outer watchdog.
  const configuredFirstChunkMs = positiveInteger(process.env.AI_STREAM_FIRST_CHUNK_TIMEOUT_MS, requestMs);
  const configuredChunkMs = positiveInteger(process.env.AI_STREAM_CHUNK_TIMEOUT_MS, requestMs);
  return {
    firstChunkMs: Math.max(requestMs, configuredFirstChunkMs),
    // AI SDK keeps the inter-chunk timer running while a tool executes. Keep
    // it above the complete tool window so a successful long-running tool does
    // not abort the stream before the following model step can begin.
    chunkMs: Math.max(requestMs, configuredChunkMs, toolMs + requestMs),
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
