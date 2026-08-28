import { registerTelemetry, type Telemetry } from 'ai';
import { OpenTelemetry } from '@ai-sdk/otel';
import {
  incrementMetric,
  recordMetricTiming,
  setMetricGauge,
  structuredLog,
} from '@/server/observability/runtime-observability';

type TelemetryGlobal = typeof globalThis & {
  __webPilotAiSdkTelemetryRegistered?: boolean;
};

type ActiveAiOperation = {
  functionId?: string;
  operationId: string;
};

const activeAiOperations = new Map<string, ActiveAiOperation>();

function telemetryCallId(event: unknown) {
  if (!event || typeof event !== 'object') return undefined;
  const callId = (event as Record<string, unknown>).callId;
  return typeof callId === 'string' && callId.trim() ? callId : undefined;
}

function finishTelemetryOperation(event: unknown) {
  const callId = telemetryCallId(event);
  if (callId) activeAiOperations.delete(callId);
}

function compactTelemetryError(error: unknown) {
  if (!(error instanceof Error)) return { message: String(error) };
  const record = error as Error & { code?: unknown; statusCode?: unknown; cause?: unknown };
  const cause = record.cause instanceof Error
    ? record.cause as Error & { code?: unknown }
    : undefined;
  return {
    name: error.name,
    message: error.message,
    code: typeof record.code === 'string' ? record.code : undefined,
    statusCode: typeof record.statusCode === 'number' ? record.statusCode : undefined,
    cause: cause ? {
      name: cause.name,
      message: cause.message,
      code: typeof cause.code === 'string' ? cause.code : undefined,
    } : undefined,
  };
}

function addTokenMetric(name: string, value: number | undefined, labels: Record<string, string>) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    incrementMetric(name, labels, value);
  }
}

const runtimeTelemetry: Telemetry = {
  onStart(event) {
    activeAiOperations.set(event.callId, {
      functionId: event.functionId,
      operationId: event.operationId,
    });
  },
  onLanguageModelCallEnd(event) {
    const labels = { provider: event.provider, model: event.modelId };
    recordMetricTiming('ai_sdk_model_response_ms', event.performance.responseTimeMs, labels);
    if (event.performance.timeToFirstOutputMs !== undefined) {
      recordMetricTiming('ai_sdk_time_to_first_output_ms', event.performance.timeToFirstOutputMs, labels);
    }
    if (event.performance.outputTokensPerSecond !== undefined) {
      setMetricGauge('ai_sdk_output_tokens_per_second', event.performance.outputTokensPerSecond, labels);
    }
    addTokenMetric('ai_sdk_input_tokens_total', event.usage.inputTokens, labels);
    addTokenMetric('ai_sdk_input_no_cache_tokens_total', event.usage.inputTokenDetails.noCacheTokens, labels);
    addTokenMetric('ai_sdk_input_cache_read_tokens_total', event.usage.inputTokenDetails.cacheReadTokens, labels);
    addTokenMetric('ai_sdk_input_cache_write_tokens_total', event.usage.inputTokenDetails.cacheWriteTokens, labels);
    const cacheReadTokens = event.usage.inputTokenDetails.cacheReadTokens;
    const inputTokens = event.usage.inputTokens;
    if (typeof cacheReadTokens === 'number' && typeof inputTokens === 'number' && inputTokens > 0) {
      setMetricGauge('ai_sdk_prompt_cache_hit_ratio', cacheReadTokens / inputTokens, labels);
    }
    addTokenMetric('ai_sdk_output_tokens_total', event.usage.outputTokens, labels);
    addTokenMetric('ai_sdk_total_tokens_total', event.usage.totalTokens, labels);
    incrementMetric('ai_sdk_model_calls_total', { ...labels, finishReason: event.finishReason });
  },
  onToolExecutionEnd(event) {
    const status = event.toolOutput.type === 'tool-result' ? 'ok' : 'error';
    recordMetricTiming('ai_sdk_tool_execution_ms', event.toolExecutionMs, {
      tool: event.toolCall.toolName,
      status,
    });
    incrementMetric('ai_sdk_tool_executions_total', {
      tool: event.toolCall.toolName,
      status,
    });
  },
  onEnd(event) {
    finishTelemetryOperation(event);
  },
  onAbort(event) {
    finishTelemetryOperation(event);
  },
  onError(event) {
    const details = event && typeof event === 'object' ? event as Record<string, unknown> : {};
    const callId = telemetryCallId(event);
    const activeOperation = callId ? activeAiOperations.get(callId) : undefined;
    const operation = activeOperation?.functionId || activeOperation?.operationId || callId || 'unscoped';
    const error = details.error ?? event;
    incrementMetric('ai_sdk_operation_errors_total', { operation });
    structuredLog({
      event: 'ai.sdk.call.error',
      level: 'warn',
      operationId: operation,
      callId,
      scope: 'single-ai-sdk-call',
      runtimeRetryOutcome: 'reported-by-caller',
      errorDetails: compactTelemetryError(error),
    });
    if (callId) activeAiOperations.delete(callId);
  },
};

export function ensureAiSdkTelemetryRegistered() {
  const telemetryGlobal = globalThis as TelemetryGlobal;
  if (telemetryGlobal.__webPilotAiSdkTelemetryRegistered) return;
  registerTelemetry(runtimeTelemetry, new OpenTelemetry({
    usage: true,
    providerMetadata: false,
    runtimeContext: false,
    headers: false,
    toolChoice: false,
    schema: false,
  }));
  telemetryGlobal.__webPilotAiSdkTelemetryRegistered = true;
}
