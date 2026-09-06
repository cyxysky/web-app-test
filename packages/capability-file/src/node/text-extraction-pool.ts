import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CapabilityTaskQueue } from '@webpilot/capability-sdk';

export type NodeFileTextExtractionObserver = {
  incrementMetric?: (name: string, labels?: Record<string, string>) => void;
  recordMetricTiming?: (name: string, milliseconds: number, labels?: Record<string, string>) => void;
  setMetricGauge?: (name: string, value: number) => void;
  structuredLog?: (entry: { event: string; level: 'error'; error: unknown }) => void;
};
let observer: NodeFileTextExtractionObserver = {};
export function configureNodeFileTextExtractionObserver(value: NodeFileTextExtractionObserver = {}) { observer = value; }
export type FileTextExtractionKind = 'archive' | 'pdf' | 'presentation' | 'spreadsheet' | 'text' | 'unknown' | 'word';
export type FileTextSelection = { sheet?: string; range?: string; contentPages?: number[]; section?: string };
export type FileTextExtractionInput = FileTextSelection & { extension: string; kind: FileTextExtractionKind; path: string; abortSignal?: AbortSignal };
type Slot = { worker: Worker; busy: boolean; digest?: string; timer?: ReturnType<typeof setTimeout> };
const slots = new Set<Slot>();
const cache = new Map<string, string>();
let cacheBytes = 0;
let nextId = 1;
let disposing: Promise<void> | undefined;
function integer(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}
const queue = new CapabilityTaskQueue({
  concurrency: integer('CPU_WORKER_COUNT', Math.max(1, Math.min(4, availableParallelism() - 1)), 1, 16),
  maxQueued: integer('CPU_WORKER_MAX_QUEUED', 64, 1, 1000),
  queueTimeoutMs: integer('CPU_WORKER_QUEUE_TIMEOUT_MS', 120_000, 100, 300_000),
});
function gauges() {
  const state = queue.snapshot();
  observer.setMetricGauge?.('cpu_worker_queue_depth', state.queued);
  observer.setMetricGauge?.('cpu_worker_active', state.active);
}
function retire(slot: Slot) {
  if (slot.timer) clearTimeout(slot.timer);
  slots.delete(slot);
  return slot.worker.terminate();
}
function workerPath() {
  const relative = 'javascript/text-extraction-worker.cjs';
  const candidates = [
    process.env.CAPABILITY_FILE_RUNTIME_DIR ? path.join(process.env.CAPABILITY_FILE_RUNTIME_DIR, relative) : '',
    fileURLToPath(new URL('../../runtime/javascript/text-extraction-worker.cjs', import.meta.url)),
    path.join(process.cwd(), 'capability-runtime/file', relative),
    path.join(process.cwd(), 'packages/capability-file/runtime', relative),
    path.join(process.cwd(), 'node_modules/@webpilot/capability-file/runtime', relative),
  ];
  const found = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!found) throw new Error('File text extraction worker is missing from the package runtime.');
  return found;
}
async function parse(input: FileTextExtractionInput, digest: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  let slot = [...slots].find((item) => !item.busy && item.digest === digest) || [...slots].find((item) => !item.busy);
  if (!slot) {
    slot = { worker: new Worker(workerPath(), {
      resourceLimits: { maxOldGenerationSizeMb: integer('CPU_WORKER_MAX_HEAP_MB', 256, 32, 2048) },
    }), busy: false };
    const created = slot;
    slot.worker.on('error', (error) => {
      observer.structuredLog?.({ event: 'cpu_worker.error', level: 'error', error });
      slots.delete(created);
    });
    slot.worker.on('exit', () => slots.delete(created));
    slots.add(slot);
  }
  const current = slot;
  if (current.timer) clearTimeout(current.timer);
  current.busy = true;
  current.worker.ref();
  const id = nextId++;
  let reusable = false;
  try {
    const value = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        signal.removeEventListener('abort', abort);
        current.worker.off('message', message);
        current.worker.off('error', failure);
        current.worker.off('exit', exited);
      };
      const finish = (error?: Error, text?: string) => {
        if (settled) return;
        settled = true; cleanup();
        if (error) reject(error); else resolve(text || '');
      };
      const abort = () => finish(signal.reason instanceof Error ? signal.reason : new Error('File extraction aborted.'));
      const failure = (error: Error) => finish(error);
      const exited = (code: number) => finish(new Error(`File extraction worker exited (${code}).`));
      const message = (result: { id: number; ok: boolean; value?: string; error?: string }) => {
        if (result.id !== id) return;
        reusable = true;
        finish(result.ok ? undefined : new Error(result.error || 'File extraction failed.'), result.value);
      };
      signal.addEventListener('abort', abort, { once: true });
      current.worker.on('message', message);
      current.worker.once('error', failure);
      current.worker.once('exit', exited);
      current.worker.postMessage({ id, digest, extension: input.extension, kind: input.kind, path: input.path,
        sheet: input.sheet, range: input.range, contentPages: input.contentPages, section: input.section });
    });
    current.digest = digest;
    return value;
  } finally {
    if (!reusable || signal.aborted || !slots.has(current)) await retire(current);
    else {
      current.busy = false; current.worker.unref();
      current.timer = setTimeout(() => { void retire(current); }, integer('CPU_WORKER_IDLE_TIMEOUT_MS', 30_000, 0, 300_000));
      current.timer.unref?.();
    }
  }
}

/** Offsets are deliberately absent from the cache key: subsequent text pages reuse extraction. */
export function extractFileTextInWorker(input: FileTextExtractionInput): Promise<string> {
  if (disposing) return Promise.reject(new Error('File extraction pool is being disposed.'));
  const started = performance.now();
  const pending = queue.run(async (signal) => {
    const maxBytes = integer('CPU_WORKER_MAX_FILE_BYTES', 128 * 1024 * 1024, 1024, 1024 * 1024 * 1024);
    if ((await stat(input.path)).size > maxBytes) throw new Error(`File exceeds the ${maxBytes} byte extraction limit.`);
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(input.path, { signal })) {
      bytes += (chunk as Buffer).length;
      if (bytes > maxBytes) throw new Error(`File exceeds the ${maxBytes} byte extraction limit.`);
      hash.update(chunk as Buffer);
    }
    signal.throwIfAborted();
    const digest = hash.digest('hex');
    const key = JSON.stringify(['file-text-v2', digest, input.kind, input.extension, input.sheet, input.range, input.contentPages, input.section]);
    const cached = cache.get(key);
    if (cached !== undefined) {
      cache.delete(key); cache.set(key, cached);
      observer.incrementMetric?.('cpu_worker_cache_hit_total');
      return cached;
    }
    const text = await parse(input, digest, signal);
    const budget = integer('CPU_WORKER_TEXT_CACHE_BYTES', 32 * 1024 * 1024, 0, 256 * 1024 * 1024);
    const size = text.length * 2;
    if (size <= budget) {
      const previous = cache.get(key);
      if (previous !== undefined) { cacheBytes -= previous.length * 2; cache.delete(key); }
      while (cache.size && (cacheBytes + size > budget || cache.size >= 128)) {
        const oldest = cache.keys().next().value!;
        cacheBytes -= cache.get(oldest)!.length * 2; cache.delete(oldest);
      }
      cache.set(key, text); cacheBytes += size;
    }
    return text;
  }, { abortSignal: input.abortSignal, executionTimeoutMs: integer('CPU_WORKER_TASK_TIMEOUT_MS', 60_000, 100, 300_000) });
  gauges();
  return pending.finally(() => {
    gauges();
    observer.recordMetricTiming?.('cpu_worker_task_ms', performance.now() - started, { task: 'attachment_extract' });
  });
}
export function nodeFileTextExtractionPoolSnapshot() { return { ...queue.snapshot(), workers: slots.size, cached: cache.size, cacheBytes }; }
export function disposeNodeFileTextExtractionPool(): Promise<void> {
  if (disposing) return disposing;
  queue.cancel(new Error('File text extraction pool disposed.'));
  disposing = (async () => {
    await queue.idle();
    await Promise.allSettled([...slots].map(retire));
    cache.clear(); cacheBytes = 0; gauges();
  })().finally(() => { disposing = undefined; });
  return disposing;
}
