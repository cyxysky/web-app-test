/* eslint-disable @typescript-eslint/no-require-imports */
const os = require('node:os');
const v8 = require('node:v8');
const { monitorEventLoopDelay } = require('node:perf_hooks');

const memoryMonitorStateKey = '__webpilotProcessMemoryMonitor';
const diagnosticProvidersKey = '__webpilotMemoryDiagnosticProviders';

function boundedIntervalMs(value) {
  const parsed = Number(value || 60_000);
  return Number.isFinite(parsed)
    ? Math.min(60 * 60 * 1000, Math.max(10_000, Math.floor(parsed)))
    : 60_000;
}

function mib(value) {
  return Math.round((Number(value) || 0) / 1024 / 1024 * 10) / 10;
}

function percent(value, total) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.round(value / total * 1_000) / 10;
}

function eventLoopMilliseconds(value) {
  return Number.isFinite(value) ? Math.round(value / 1e6 * 10) / 10 : 0;
}

function activeResourceCounts() {
  const counts = new Map();
  for (const name of process.getActiveResourcesInfo?.() || []) {
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((left, right) => (
    right[1] - left[1] || left[0].localeCompare(right[0])
  )));
}

function providerSnapshots() {
  const providers = globalThis[diagnosticProvidersKey];
  if (!(providers instanceof Map)) return {};
  const snapshots = {};
  for (const [name, provider] of providers) {
    if (typeof provider !== 'function') continue;
    try {
      snapshots[name] = provider();
    } catch (error) {
      snapshots[name] = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  return snapshots;
}

function memoryPressure(heapUsed, heapLimit) {
  const utilization = heapLimit > 0 ? heapUsed / heapLimit : 0;
  if (utilization >= 0.9) return 'critical';
  if (utilization >= 0.75) return 'high';
  return 'normal';
}

function startProcessMemoryMonitor() {
  const existing = globalThis[memoryMonitorStateKey];
  if (existing?.timer) return existing;

  const intervalMs = boundedIntervalMs(process.env.WEBPILOT_MEMORY_LOG_INTERVAL_MS);
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  eventLoop.enable();
  let previous;

  const writeSnapshot = (reason = 'interval') => {
    const usage = process.memoryUsage();
    const heap = v8.getHeapStatistics();
    const resourceUsage = process.resourceUsage();
    const systemTotal = os.totalmem();
    const systemFree = os.freemem();
    const pressure = memoryPressure(usage.heapUsed, heap.heap_size_limit);
    const payload = {
      time: new Date().toISOString(),
      level: pressure === 'normal' ? 'info' : 'warn',
      event: pressure === 'normal' ? 'process.memory.snapshot' : 'process.memory.pressure',
      reason,
      role: String(process.env.WEBPILOT_SERVER_ROLE || 'single'),
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      intervalSeconds: Math.round(intervalMs / 1000),
      pressure,
      memoryMb: {
        rss: mib(usage.rss),
        heapUsed: mib(usage.heapUsed),
        heapTotal: mib(usage.heapTotal),
        heapLimit: mib(heap.heap_size_limit),
        heapAvailable: mib(heap.total_available_size),
        external: mib(usage.external),
        arrayBuffers: mib(usage.arrayBuffers),
        rssDelta: previous ? mib(usage.rss - previous.rss) : 0,
        heapUsedDelta: previous ? mib(usage.heapUsed - previous.heapUsed) : 0,
      },
      utilizationPercent: {
        heap: percent(usage.heapUsed, heap.heap_size_limit),
        rssOfSystem: percent(usage.rss, systemTotal),
        systemFree: percent(systemFree, systemTotal),
      },
      v8: {
        nativeContexts: heap.number_of_native_contexts,
        detachedContexts: heap.number_of_detached_contexts,
        executableMemoryMb: mib(heap.total_heap_size_executable),
        mallocedMemoryMb: mib(heap.malloced_memory),
        peakMallocedMemoryMb: mib(heap.peak_malloced_memory),
      },
      eventLoopMs: {
        mean: eventLoopMilliseconds(eventLoop.mean),
        max: eventLoopMilliseconds(eventLoop.max),
        p99: eventLoopMilliseconds(eventLoop.percentile(99)),
      },
      cpuSeconds: {
        system: Math.round(resourceUsage.systemCPUTime / 100_000) / 10,
        user: Math.round(resourceUsage.userCPUTime / 100_000) / 10,
      },
      maxRssMb: mib(resourceUsage.maxRSS * 1024),
      activeResources: activeResourceCounts(),
      diagnostics: providerSnapshots(),
    };
    previous = { heapUsed: usage.heapUsed, rss: usage.rss };
    eventLoop.reset();
    const line = JSON.stringify(payload);
    if (pressure === 'normal') console.info(line);
    else console.warn(line);
    return payload;
  };

  const timer = setInterval(() => writeSnapshot('interval'), intervalMs);
  timer.unref?.();
  const pressureTimer = setInterval(() => {
    const usage = process.memoryUsage();
    const heap = v8.getHeapStatistics();
    if (memoryPressure(usage.heapUsed, heap.heap_size_limit) !== 'normal') {
      writeSnapshot('pressure-watch');
    }
  }, Math.min(intervalMs, 10_000));
  pressureTimer.unref?.();
  const state = {
    intervalMs,
    pressureTimer,
    timer,
    writeSnapshot,
    stop() {
      clearInterval(timer);
      clearInterval(pressureTimer);
      eventLoop.disable();
      if (globalThis[memoryMonitorStateKey] === state) delete globalThis[memoryMonitorStateKey];
    },
  };
  globalThis[memoryMonitorStateKey] = state;
  writeSnapshot('startup');
  return state;
}

module.exports = {
  boundedIntervalMs,
  memoryPressure,
  startProcessMemoryMonitor,
};
