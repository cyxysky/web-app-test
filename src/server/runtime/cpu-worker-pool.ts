import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { incrementMetric, recordMetricTiming, setMetricGauge, structuredLog } from '@/server/observability/runtime-observability';

type AttachmentExtractionKind = 'archive' | 'pdf' | 'presentation' | 'spreadsheet' | 'text' | 'unknown' | 'word';

type CpuJob = {
  extension: string;
  id: number;
  kind: AttachmentExtractionKind;
  path: string;
  reject: (error: Error) => void;
  resolve: (value: string) => void;
  startedAt: number;
  timeout?: ReturnType<typeof setTimeout>;
};

type WorkerSlot = {
  active?: CpuJob;
  worker: Worker;
};

type CpuPoolState = {
  idleTimer?: ReturnType<typeof setTimeout>;
  nextId: number;
  queue: CpuJob[];
  slots: WorkerSlot[];
};

const state: CpuPoolState = ((globalThis as typeof globalThis & {
  __webPilotCpuPoolState?: CpuPoolState;
}).__webPilotCpuPoolState ??= { nextId: 1, queue: [], slots: [] });

const workerSource = String.raw`
  const { parentPort } = require('node:worker_threads');
  const { readFile } = require('node:fs/promises');

  function decodeXml(value) {
    return value.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  }
  function officeXmlText(value) {
    return decodeXml(value.replace(/<a:br\s*\/>/g, '\n').replace(/<a:p[^>]*>/g, '')
      .replace(/<\/a:p>/g, '\n').replace(/<text:line-break\s*\/>/g, '\n')
      .replace(/<text:p[^>]*>/g, '').replace(/<\/text:p>/g, '\n'))
      .replace(/\n{3,}/g, '\n\n').trim();
  }
  async function zipFrom(buffer) {
    const imported = await import('jszip');
    const JSZip = imported.default || imported;
    return JSZip.loadAsync(buffer);
  }
  function legacyOfficeText(buffer) {
    const CFB = require('cfb');
    const container = CFB.read(buffer, { type: 'buffer' });
    return container.FileIndex.filter((entry) => entry.content && entry.content.length)
      .map((entry) => Buffer.from(entry.content))
      .flatMap((content) => [content.toString('utf16le'), content.toString('latin1')])
      .flatMap((value) => value.match(/[\p{L}\p{N}][\p{L}\p{N}\p{P}\p{Z}\r\n\t]{2,}/gu) || [])
      .map((value) => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]+/g, ' ').replace(/\s+/g, ' ').trim())
      .filter((value) => value.length >= 3).filter((value, index, values) => values.indexOf(value) === index)
      .slice(0, 10000).join('\n').trim();
  }
  async function extract(job) {
    const buffer = await readFile(job.path);
    if (job.kind === 'pdf') {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: buffer });
      try { return (await parser.getText()).text.trim(); } finally { await parser.destroy(); }
    }
    if (job.kind === 'word') {
      if (job.extension === '.doc') return legacyOfficeText(buffer);
      if (job.extension === '.odt') {
        const archive = await zipFrom(buffer);
        const document = archive.files['content.xml'];
        if (!document) throw new Error('OpenDocument 文件缺少 content.xml。');
        return officeXmlText(await document.async('text'));
      }
      const imported = await import('mammoth');
      const mammoth = imported.default || imported;
      return (await mammoth.extractRawText({ buffer })).value.trim();
    }
    if (job.kind === 'spreadsheet') {
      const XLSX = require('xlsx');
      const workbook = XLSX.read(buffer, { cellDates: true, dense: false, type: 'buffer' });
      return workbook.SheetNames.map((name) => '## 工作表：' + name + '\n' + XLSX.utils.sheet_to_csv(workbook.Sheets[name]).trim())
        .join('\n\n').trim();
    }
    if (job.kind === 'presentation') {
      if (['.ppt', '.pps', '.pot'].includes(job.extension)) return legacyOfficeText(buffer);
      const archive = await zipFrom(buffer);
      const slides = Object.keys(archive.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
        .sort((left, right) => Number((left.match(/\d+/) || [0])[0]) - Number((right.match(/\d+/) || [0])[0]));
      if (!slides.length && archive.files['content.xml']) return officeXmlText(await archive.files['content.xml'].async('text'));
      const values = await Promise.all(slides.map(async (name, index) => '## 幻灯片 ' + (index + 1) + '\n' + officeXmlText(await archive.files[name].async('text'))));
      return values.join('\n\n').trim();
    }
    if (job.kind === 'archive') {
      const archive = await zipFrom(buffer);
      const names = Object.values(archive.files).filter((entry) => !entry.dir).map((entry) => entry.name).slice(0, 2000);
      return '压缩包文件列表（' + names.length + ' 项）：\n' + names.join('\n');
    }
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '').trim();
    if (text && !buffer.includes(0)) return text;
    if (job.kind === 'text') return '';
    throw new Error('该文件是未知二进制格式，当前没有可用的文本解析器。');
  }
  parentPort.on('message', async (job) => {
    try { parentPort.postMessage({ id: job.id, ok: true, value: await extract(job) }); }
    catch (error) { parentPort.postMessage({ id: job.id, ok: false, error: error instanceof Error ? error.message : String(error) }); }
  });
`;

function configuredInteger(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value))) : fallback;
}

function workerCount() {
  return configuredInteger('CPU_WORKER_COUNT', Math.max(1, Math.min(4, availableParallelism() - 1)), 1, 16);
}

function updateGauges() {
  setMetricGauge('cpu_worker_queue_depth', state.queue.length);
  setMetricGauge('cpu_worker_active', state.slots.filter((slot) => slot.active).length);
}

function dispatch() {
  for (const slot of state.slots) {
    if (slot.active || !state.queue.length) continue;
    const job = state.queue.shift()!;
    slot.active = job;
    job.startedAt = performance.now();
    job.timeout = setTimeout(() => {
      if (slot.active?.id !== job.id) return;
      slot.active = undefined;
      job.reject(new Error('文件解析超时。'));
      incrementMetric('cpu_worker_task_timeout_total', { task: 'attachment_extract' });
      void slot.worker.terminate();
      const index = state.slots.indexOf(slot);
      if (index >= 0) state.slots.splice(index, 1);
      ensureWorkers();
      dispatch();
    }, configuredInteger('CPU_WORKER_TASK_TIMEOUT_MS', 60_000, 5_000, 5 * 60_000));
    job.timeout.unref?.();
    slot.worker.postMessage({ id: job.id, extension: job.extension, kind: job.kind, path: job.path });
  }
  updateGauges();
  if (!state.queue.length && !state.slots.some((slot) => slot.active) && !state.idleTimer) {
    state.idleTimer = setTimeout(() => {
      state.idleTimer = undefined;
      if (state.queue.length || state.slots.some((slot) => slot.active)) return;
      const slots = state.slots.splice(0);
      for (const slot of slots) void slot.worker.terminate();
      updateGauges();
    }, 250);
    state.idleTimer.unref?.();
  }
}

function createSlot() {
  const slot: WorkerSlot = { worker: new Worker(workerSource, { eval: true }) };
  slot.worker.unref();
  slot.worker.on('message', (message: { error?: string; id: number; ok: boolean; value?: string }) => {
    const job = slot.active;
    if (!job || job.id !== message.id) return;
    if (job.timeout) clearTimeout(job.timeout);
    slot.active = undefined;
    recordMetricTiming('cpu_worker_task_ms', performance.now() - job.startedAt, {
      status: message.ok ? 'ok' : 'error',
      task: 'attachment_extract',
    });
    if (message.ok) job.resolve(message.value || '');
    else job.reject(new Error(message.error || '文件解析失败。'));
    dispatch();
  });
  slot.worker.on('error', (error) => {
    structuredLog({ event: 'cpu_worker.error', level: 'error', error });
    const job = slot.active;
    if (job?.timeout) clearTimeout(job.timeout);
    slot.active = undefined;
    job?.reject(error);
  });
  slot.worker.on('exit', () => {
    const index = state.slots.indexOf(slot);
    if (index >= 0) state.slots.splice(index, 1);
    if (state.queue.length) ensureWorkers();
    dispatch();
  });
  return slot;
}

function ensureWorkers() {
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
  }
  while (state.slots.length < workerCount()) state.slots.push(createSlot());
}

export function extractAttachmentTextInWorker(input: {
  extension: string;
  kind: AttachmentExtractionKind;
  path: string;
}) {
  const maximumQueued = configuredInteger('CPU_WORKER_MAX_QUEUED', 64, 4, 1_000);
  if (state.queue.length >= maximumQueued) {
    incrementMetric('cpu_worker_task_rejected_total', { task: 'attachment_extract' });
    return Promise.reject(new Error('文件解析队列繁忙，请稍后重试。'));
  }
  const result = new Promise<string>((resolve, reject) => {
    state.queue.push({
      extension: input.extension,
      id: state.nextId++,
      kind: input.kind,
      path: input.path,
      reject,
      resolve,
      startedAt: 0,
    });
  });
  ensureWorkers();
  dispatch();
  return result;
}

export function cpuWorkerPoolSnapshot() {
  return {
    active: state.slots.filter((slot) => slot.active).length,
    queued: state.queue.length,
    workers: state.slots.length,
  };
}
