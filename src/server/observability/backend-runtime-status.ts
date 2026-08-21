import v8 from 'node:v8';
import { readBrowserChatRuntimeStatus } from '@/server/ai/agents/browser-chat.service';

export type BackendMemoryTrendPoint = {
  time: string;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  arrayBuffersMb: number;
};

export type BackendRuntimeStatus = ReturnType<typeof readBackendRuntimeStatus>;

type MemoryMonitorState = {
  latest?: {
    time: string;
    pid: number;
    uptimeSeconds: number;
    pressure: string;
    memoryMb: Record<string, number>;
    utilizationPercent: Record<string, number>;
  };
  history?: BackendMemoryTrendPoint[];
  writeSnapshot?: (reason?: string) => unknown;
};

function roundMb(bytes: number) {
  return Math.round(bytes / 1024 / 1024 * 10) / 10;
}

function fallbackSnapshot() {
  const usage = process.memoryUsage();
  const heap = v8.getHeapStatistics();
  const heapPercent = heap.heap_size_limit > 0 ? usage.heapUsed / heap.heap_size_limit * 100 : 0;
  return {
    time: new Date().toISOString(),
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    pressure: heapPercent >= 90 ? 'critical' : heapPercent >= 75 ? 'high' : 'normal',
    memoryMb: {
      rss: roundMb(usage.rss),
      heapUsed: roundMb(usage.heapUsed),
      heapTotal: roundMb(usage.heapTotal),
      heapLimit: roundMb(heap.heap_size_limit),
      external: roundMb(usage.external),
      arrayBuffers: roundMb(usage.arrayBuffers),
    },
    utilizationPercent: { heap: Math.round(heapPercent * 10) / 10 },
  };
}

export function readBackendRuntimeStatus() {
  const monitor = (globalThis as typeof globalThis & {
    __webpilotProcessMemoryMonitor?: MemoryMonitorState;
  }).__webpilotProcessMemoryMonitor;
  monitor?.writeSnapshot?.('admin-request');
  const memory = monitor?.latest || fallbackSnapshot();
  const point: BackendMemoryTrendPoint = {
    time: memory.time,
    rssMb: memory.memoryMb.rss || 0,
    heapUsedMb: memory.memoryMb.heapUsed || 0,
    heapTotalMb: memory.memoryMb.heapTotal || 0,
    externalMb: memory.memoryMb.external || 0,
    arrayBuffersMb: memory.memoryMb.arrayBuffers || 0,
  };
  const history = [...(monitor?.history || [])];
  if (!history.length || history.at(-1)?.time !== point.time) history.push(point);
  const browserChat = readBrowserChatRuntimeStatus();
  return {
    generatedAt: new Date().toISOString(),
    process: memory,
    memoryTrend: history.slice(-180),
    browserCount: browserChat.browserCount,
    activeConversations: browserChat.activeConversations,
    browsers: browserChat.browsers,
    diagnostics: browserChat.diagnostics,
  };
}
