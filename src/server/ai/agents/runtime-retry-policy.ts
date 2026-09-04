export type RuntimeRetryCategory =
  | 'aborted'
  | 'authentication'
  | 'billing'
  | 'configuration'
  | 'invalid-request'
  | 'network'
  | 'provider-overloaded'
  | 'protocol'
  | 'rate-limited'
  | 'request-timeout'
  | 'server-error'
  | 'unknown';

export type RuntimeRetryDecision = {
  category: RuntimeRetryCategory;
  reason: string;
  recovery?: 'compact-context';
  retryAfterMs?: number;
  retryable: boolean;
  statusCode?: number;
};

export type RuntimeExecutionIdentity = {
  attemptId: string;
  attemptNumber: number;
  turnId: string;
};

const retryableNetworkCodes = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const nonRetryableCodes = new Set([
  'ERR_INVALID_ARG_TYPE',
  'ERR_INVALID_URL',
  'INVALID_API_KEY',
  'MODEL_NOT_FOUND',
]);

function errorRecords(error: unknown) {
  const records: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || seen.has(current)) break;
    seen.add(current);
    const record = current as Record<string, unknown>;
    records.push(record);
    current = record.cause;
  }
  return records;
}

function firstNumber(records: Record<string, unknown>[], keys: string[]) {
  for (const record of records) {
    for (const key of keys) {
      const value = Number(record[key]);
      if (Number.isFinite(value)) return Math.floor(value);
    }
  }
  return undefined;
}

function firstString(records: Record<string, unknown>[], keys: string[]) {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return undefined;
}

function headerValue(value: unknown, name: string): string | undefined {
  if (!value) return undefined;
  if (typeof (value as { get?: unknown }).get === 'function') {
    const header = (value as { get: (key: string) => unknown }).get(name);
    return typeof header === 'string' && header.trim() ? header.trim() : undefined;
  }
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const direct = record[name] ?? record[name.toLowerCase()] ?? record[name.toUpperCase()];
  if (Array.isArray(direct)) return direct.map(String).join(', ');
  return typeof direct === 'string' || typeof direct === 'number' ? String(direct).trim() : undefined;
}

export function parseRetryAfterMs(value: unknown, nowMs = Date.now()) {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(120_000, Math.ceil(seconds * 1000));
  const date = Date.parse(text);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(120_000, Math.max(0, date - nowMs));
}

function retryAfterFromRecords(records: Record<string, unknown>[]) {
  for (const record of records) {
    const direct = record.retryAfter ?? record.retry_after ?? record.retryAfterMs;
    if (record.retryAfterMs !== undefined) {
      const milliseconds = Number(record.retryAfterMs);
      if (Number.isFinite(milliseconds) && milliseconds >= 0) return Math.min(120_000, Math.ceil(milliseconds));
    }
    const parsedDirect = parseRetryAfterMs(direct);
    if (parsedDirect !== undefined) return parsedDirect;
    for (const container of [record.headers, record.responseHeaders, record.response]) {
      const nestedHeaders = container && typeof container === 'object' && !Array.isArray(container)
        ? (container as Record<string, unknown>).headers ?? container
        : container;
      const parsed = parseRetryAfterMs(headerValue(nestedHeaders, 'retry-after'));
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

function errorMessage(error: unknown, records: Record<string, unknown>[]) {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return firstString(records, ['message', 'statusText', 'error']) || String(error || 'Unknown runtime error');
}

function missingToolCallIdFromMessage(message: string) {
  const direct = message.match(/tool result(?:'s)?\s+tool id\s*\(\s*([^)\s]+)\s*\)\s+not found/i);
  if (direct?.[1]) return direct[1];
  const functionOutput = message.match(/no tool call found for (?:function call )?output(?:\s+with)?\s+call[_ ]id\s*[:=]?\s*["'(]?([\w.:-]+)/i);
  return functionOutput?.[1];
}

export function runtimeMissingToolCallId(error: unknown) {
  const records = errorRecords(error);
  return missingToolCallIdFromMessage(errorMessage(error, records));
}

export function isRuntimeToolResultCallMismatch(error: unknown) {
  const records = errorRecords(error);
  const message = errorMessage(error, records);
  return Boolean(missingToolCallIdFromMessage(message))
    || /tool result.{0,80}tool(?:[_ ]call)? id.{0,80}not found/i.test(message)
    || /no tool call found for (?:function call )?output/i.test(message);
}

export function isProviderBillingLimitMessage(value: string) {
  const message = value.trim();
  if (!message) return false;
  return /(?:已达到|达到|超过|超出).{0,24}(?:Token Plan|用量|额度|套餐|积分).{0,16}(?:上限|限制)/i.test(message)
    || /(?:用量|额度|积分).{0,16}(?:已用完|已用尽|不足)/.test(message)
    || /\b(?:token plan|billing quota|credit balance|credits?|account balance|quota).{0,48}(?:exhausted|exceeded|insufficient|depleted|limit reached)\b/i.test(message)
    || /\b(?:exhausted|exceeded|insufficient|depleted).{0,32}(?:credits?|quota|balance)\b/i.test(message);
}

export function classifyRuntimeRetry(error: unknown, signal?: AbortSignal): RuntimeRetryDecision {
  const records = errorRecords(error);
  const message = errorMessage(error, records);
  const normalizedMessage = message.toLowerCase();
  const name = firstString(records, ['name']) || (error instanceof Error ? error.name : undefined);
  const code = (firstString(records, ['code', 'errno', 'type']) || '').toUpperCase();
  const statusCode = firstNumber(records, ['status', 'statusCode', 'httpStatusCode']);
  const retryAfterMs = retryAfterFromRecords(records);
  const privateToolProtocolRetryable = records.some((record) => record.privateToolProtocolRetryable === true);
  const privateToolProtocolFailure = records.some((record) => record.privateToolProtocolRetryable === false)
    || name === 'AI_PrivateToolProtocolError';

  if (signal?.aborted || name === 'AbortError' || /\b(aborted|cancelled|canceled)\b/.test(normalizedMessage)) {
    return { category: 'aborted', reason: 'request was aborted', retryable: false, statusCode };
  }
  if (privateToolProtocolFailure) {
    return {
      category: 'protocol',
      reason: 'provider emitted a private textual tool protocol',
      retryable: privateToolProtocolRetryable,
      statusCode,
    };
  }
  if (isRuntimeToolResultCallMismatch(error)) {
    return {
      category: 'protocol',
      reason: 'tool result references a tool call missing from the provider request',
      retryable: true,
      statusCode,
    };
  }
  if (statusCode === 401 || statusCode === 403 || /\b(api key|authentication|unauthori[sz]ed|forbidden)\b/.test(normalizedMessage)) {
    return { category: 'authentication', reason: `authentication failure${statusCode ? ` (${statusCode})` : ''}`, retryable: false, statusCode };
  }
  if (statusCode === 402 || isProviderBillingLimitMessage(message) || /\b(insufficient balance|payment required|billing quota)\b/.test(normalizedMessage)) {
    return { category: 'billing', reason: `provider balance is unavailable${statusCode ? ` (${statusCode})` : ''}`, retryable: false, statusCode };
  }
  if (
    statusCode === 400
    && (
      code === 'INVALIDPARAMETER'
      || /\binvalidparameter\b|\binvalid parameter\b|\ba parameter specified in the request is not valid\b/i.test(message)
    )
  ) {
    return {
      category: 'invalid-request',
      reason: 'provider rejected request parameters; retry with compacted context',
      recovery: 'compact-context',
      retryable: true,
      statusCode,
    };
  }
  if (statusCode === 400 || statusCode === 404 || statusCode === 405 || statusCode === 410 || statusCode === 422 || nonRetryableCodes.has(code)) {
    return { category: 'invalid-request', reason: `deterministic request failure${statusCode ? ` (${statusCode})` : code ? ` (${code})` : ''}`, retryable: false, statusCode };
  }
  if (/\b(model not found|unknown model|unsupported|invalid (request|argument|parameter)|schema|tool input)\b/.test(normalizedMessage)) {
    return { category: 'configuration', reason: 'model or request configuration is invalid', retryable: false, statusCode };
  }
  if (statusCode === 429) {
    return { category: 'rate-limited', reason: 'provider rate limit', retryAfterMs, retryable: true, statusCode };
  }
  if (statusCode === 408 || statusCode === 425 || /timed? out|timeout/.test(normalizedMessage)) {
    return { category: 'request-timeout', reason: `temporary request timeout${statusCode ? ` (${statusCode})` : ''}`, retryAfterMs, retryable: true, statusCode };
  }
  if (statusCode !== undefined && statusCode >= 500 && statusCode <= 599 && statusCode !== 501 && statusCode !== 505) {
    return { category: 'server-error', reason: `provider server failure (${statusCode})`, retryAfterMs, retryable: true, statusCode };
  }
  if (statusCode === 503 || /\b(overloaded|over capacity|temporarily unavailable|service unavailable)\b/.test(normalizedMessage)) {
    return { category: 'provider-overloaded', reason: 'provider is temporarily overloaded', retryAfterMs, retryable: true, statusCode };
  }
  if (retryableNetworkCodes.has(code) || /\b(socket hang up|connection reset|connection closed|other side closed|cannot connect to api|network error|fetch failed|terminated)\b/.test(normalizedMessage)) {
    return { category: 'network', reason: `temporary network failure${code ? ` (${code})` : ''}`, retryAfterMs, retryable: true, statusCode };
  }
  if (/ai sdk returned retryable finish reason\s+"(?:error|other)"/i.test(message)) {
    return { category: 'server-error', reason: 'provider returned an error finish state', retryAfterMs, retryable: true, statusCode };
  }
  if (name === 'AI_NoOutputGeneratedError' || /\bno output generated\b/i.test(message)) {
    return { category: 'server-error', reason: 'provider stream ended without an output', retryAfterMs, retryable: true, statusCode };
  }
  return { category: 'unknown', reason: 'error is not known to be transient', retryable: false, statusCode };
}

function configuredDelay(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

export function runtimeRetryDelayMs(
  failureNumber: number,
  decision: RuntimeRetryDecision,
  random: () => number = Math.random,
) {
  if (decision.retryAfterMs !== undefined) return decision.retryAfterMs;
  const base = configuredDelay('AI_BROWSER_CHAT_RETRY_BASE_DELAY_MS', 500);
  const maximum = Math.max(base, configuredDelay('AI_BROWSER_CHAT_RETRY_MAX_DELAY_MS', 8_000));
  const exponential = Math.min(maximum, base * (2 ** Math.max(0, Math.floor(failureNumber) - 1)));
  const jitter = 0.75 + Math.min(1, Math.max(0, random())) * 0.5;
  return Math.min(maximum, Math.max(0, Math.round(exponential * jitter)));
}

export function runtimeExecutionIdentity(turnId: string, stepIndex: number, attemptNumber: number): RuntimeExecutionIdentity {
  const normalizedTurnId = turnId.trim() || 'browser-chat-turn';
  const normalizedStepIndex = Math.max(0, Math.floor(stepIndex));
  const normalizedAttemptNumber = Math.max(1, Math.floor(attemptNumber));
  return {
    turnId: normalizedTurnId,
    attemptNumber: normalizedAttemptNumber,
    attemptId: `${normalizedTurnId}:step:${normalizedStepIndex}:attempt:${normalizedAttemptNumber}`,
  };
}

export function runtimeExecutionDetails(
  details: unknown,
  identity: RuntimeExecutionIdentity,
  toolCallId?: string,
) {
  const record = details && typeof details === 'object' && !Array.isArray(details)
    ? details as Record<string, unknown>
    : details === undefined ? {} : { value: details };
  const trace = record.trace && typeof record.trace === 'object' && !Array.isArray(record.trace)
    ? record.trace as Record<string, unknown>
    : undefined;
  const resolvedToolCallId = toolCallId
    || (typeof record.toolCallId === 'string' ? record.toolCallId : undefined)
    || (typeof trace?.id === 'string' ? trace.id : undefined);
  return {
    ...record,
    execution: {
      ...identity,
      ...(resolvedToolCallId ? { toolCallId: resolvedToolCallId } : {}),
    },
  };
}

export async function waitForRuntimeRetry(
  delayMs: number,
  signal?: AbortSignal,
  shouldContinue?: () => boolean,
) {
  if (signal?.aborted || (shouldContinue && !shouldContinue())) {
    throw signal?.reason || new Error('Browser chat retry was cancelled.');
  }
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      if (shouldContinue && !shouldContinue()) reject(new Error('Browser chat retry was cancelled.'));
      else resolve();
    }, delayMs);
    timer.unref?.();
    const onAbort = () => {
      cleanup();
      reject(signal?.reason || new Error('Browser chat retry was cancelled.'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
