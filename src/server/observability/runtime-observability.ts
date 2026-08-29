type MetricState = {
  counters: Map<string, number>;
  gauges: Map<string, number>;
  timings: Map<string, { count: number; maxMs: number; totalMs: number }>;
};

const state = ((globalThis as typeof globalThis & {
  __webPilotMetricState?: MetricState;
}).__webPilotMetricState ??= {
  counters: new Map(),
  gauges: new Map(),
  timings: new Map(),
});

const memoryDiagnosticProviders = ((globalThis as typeof globalThis & {
  __webpilotMemoryDiagnosticProviders?: Map<string, () => unknown>;
}).__webpilotMemoryDiagnosticProviders ??= new Map());
memoryDiagnosticProviders.set('runtimeMetrics', () => ({
  counters: state.counters.size,
  gauges: state.gauges.size,
  timings: state.timings.size,
}));

function metricKey(name: string, labels: Record<string, string | number> = {}) {
  const suffix = Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(',');
  return suffix ? `${name}{${suffix}}` : name;
}

export function incrementMetric(name: string, labels: Record<string, string | number> = {}, amount = 1) {
  const key = metricKey(name, labels);
  state.counters.set(key, (state.counters.get(key) || 0) + amount);
}

export function setMetricGauge(name: string, value: number, labels: Record<string, string | number> = {}) {
  state.gauges.set(metricKey(name, labels), Number.isFinite(value) ? value : 0);
}

export function recordMetricTiming(name: string, elapsedMs: number, labels: Record<string, string | number> = {}) {
  const key = metricKey(name, labels);
  const previous = state.timings.get(key) || { count: 0, maxMs: 0, totalMs: 0 };
  state.timings.set(key, {
    count: previous.count + 1,
    maxMs: Math.max(previous.maxMs, elapsedMs),
    totalMs: previous.totalMs + elapsedMs,
  });
}

export function runtimeMetricsSnapshot() {
  return {
    counters: Object.fromEntries(state.counters),
    gauges: Object.fromEntries(state.gauges),
    timings: Object.fromEntries([...state.timings].map(([key, value]) => [key, {
      ...value,
      averageMs: value.count ? value.totalMs / value.count : 0,
    }])),
    generatedAt: new Date().toISOString(),
  };
}

type StructuredLogInput = {
  error?: unknown;
  event: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
  requestId?: string;
  [key: string]: unknown;
};

function serializedError(error: unknown) {
  if (!(error instanceof Error)) return error === undefined ? undefined : String(error);
  return {
    message: error.message,
    name: error.name,
    stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
  };
}

export function structuredLog(input: StructuredLogInput) {
  const { error, level = 'info', ...fields } = input;
  const payload = JSON.stringify({
    time: new Date().toISOString(),
    level,
    ...fields,
    ...(error === undefined ? {} : { error: serializedError(error) }),
  });
  if (level === 'error') console.error(payload);
  else if (level === 'warn') console.warn(payload);
  else console.info(payload);
}
