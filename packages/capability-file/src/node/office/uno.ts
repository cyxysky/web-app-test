import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { OfficeDocumentKind } from '../../office/types.js';
import { resolveLibreOfficeExecutable, resolveLibreOfficePythonExecutable } from '../libreoffice.js';

const WORKER_IDLE_TIMEOUT_MS = Math.max(60_000, Number(process.env.OFFICE_WORKER_IDLE_TIMEOUT_MS) || 120_000);
const WORKER_HARD_TIMEOUT_MS = Math.max(WORKER_IDLE_TIMEOUT_MS, Number(process.env.OFFICE_WORKER_HARD_TIMEOUT_MS) || 30 * 60_000);
const PROGRESS_PREFIX = '__WEBPILOT_PROGRESS__';
const PROGRAM_ENTRYPOINT = /^\s*def\s+create_document\s*\(\s*job\s*\)\s*:/m;
const OUTPUT_EXTENSIONS = new Set(['.doc', '.docx', '.odt', '.xls', '.xlsx', '.ods', '.ppt', '.pptx', '.odp', '.pdf']);
const UNO_BRIDGE_DISPOSED_PATTERN = /(?:com\.sun\.star\.lang\.DisposedException|Binary URP bridge disposed|bridge disposed during call)/i;
const UNO_BRIDGE_STARTUP_PATTERN = /(?:Unable to connect to LibreOffice UNO|couldn'?t connect to (?:pipe|socket))/i;

type PersistentUnoHost = {
  child: ChildProcess;
  directory: string;
  executable: string;
  pipeName: string;
};

let persistentUnoHost: PersistentUnoHost | undefined;
let persistentUnoQueue: Promise<void> = Promise.resolve();
let persistentUnoExitHookInstalled = false;

export type UnoGeneratedDocument = {
  buffer: Buffer;
  outputPath: string;
  previewPdf?: Buffer;
  previewPath: string;
  report: Record<string, unknown>;
};

/**
 * This intentionally validates only the public program contract. It does not
 * translate, rewrite, or infer UNO calls. Security is supplied by the Worker
 * process/container boundary, not by a brittle source-code blacklist.
 */
export function assertControlledUnoProgram(sourceCode: string) {
  if (!PROGRAM_ENTRYPOINT.test(sourceCode)) {
    throw new Error('UNO source must define def create_document(job): with exactly one job parameter.');
  }
}

export function isTransientUnoBridgeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return UNO_BRIDGE_DISPOSED_PATTERN.test(message) || UNO_BRIDGE_STARTUP_PATTERN.test(message);
}

export function isUnoBridgeStartupError(error: unknown) {
  return UNO_BRIDGE_STARTUP_PATTERN.test(error instanceof Error ? error.message : String(error));
}

export function isUnoWorkerInternalError(error: unknown) {
  return /\bUNO_WORKER_INTERNAL_ERROR:/.test(error instanceof Error ? error.message : String(error))
    || isUnoStylePropertyInfoError(error);
}

export function isUnoStylePropertyInfoError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return /getPropertySetInfo\(\)\.hasPropertyByName/.test(text)
    && /NoneType.*has no attribute ['"]hasPropertyByName['"]/.test(text);
}

export async function resolveUnoProgramWorker(options: {
  runtimeRoot?: string;
  workerPath?: string;
} = {}) {
  const configured = String(options.workerPath || process.env.LIBREOFFICE_UNO_PROGRAM_WORKER_PATH || '').trim();
  const runtimeRoot = String(options.runtimeRoot || process.env.CAPABILITY_FILE_RUNTIME_DIR || '').trim();
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const bundled = path.resolve(moduleDirectory, '..', '..', '..', 'runtime', 'python', 'libreoffice-program-worker.py');
  const candidates = [
    configured,
    runtimeRoot ? path.join(runtimeRoot, 'python', 'libreoffice-program-worker.py') : '',
    bundled,
    path.join(process.cwd(), 'capability-runtime', 'file', 'python', 'libreoffice-program-worker.py'),
    path.join(process.cwd(), 'packages', 'capability-file', 'runtime', 'python', 'libreoffice-program-worker.py'),
    path.join(process.cwd(), 'node_modules', '@webpilot', 'capability-file', 'runtime', 'python', 'libreoffice-program-worker.py'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      // Keep searching application and packaged runtime locations.
    }
  }
  return undefined;
}

/** Release the persistent LibreOffice host owned by this process. */
export async function disposeUnoRuntime() {
  await stopPersistentUnoHost();
  UNO_FACADE_CATALOG_CACHE.clear();
}

function abortReason(signal?: AbortSignal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('LibreOffice UNO generation was aborted.');
}

async function terminateWorkerProcessTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    return;
  }
  await new Promise<void>((resolve) => {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const fallback = setTimeout(() => {
      child.kill();
      resolve();
    }, 3_000);
    fallback.unref?.();
    killer.once('error', () => {
      clearTimeout(fallback);
      child.kill();
      resolve();
    });
    killer.once('exit', (code) => {
      clearTimeout(fallback);
      if (code !== 0) child.kill('SIGKILL');
      resolve();
    });
  });
}

function runWorker(input: {
  executable: string;
  args: string[];
  libreOfficeProgramDirectory: string;
  requireBytes?: boolean;
  abortSignal?: AbortSignal;
  onProgress?: (progress: { phase: string; message: string; current?: number; total?: number }) => void | Promise<void>;
}) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    if (input.abortSignal?.aborted) {
      reject(abortReason(input.abortSignal));
      return;
    }
    const existingPythonPath = String(process.env.PYTHONPATH || '').trim();
    let settled = false;
    let idleTimeout: ReturnType<typeof setTimeout> | undefined;
    let hardTimeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (idleTimeout) clearTimeout(idleTimeout);
      if (hardTimeout) clearTimeout(hardTimeout);
      idleTimeout = undefined;
      hardTimeout = undefined;
      input.abortSignal?.removeEventListener('abort', onAbort);
    };
    const failAndTerminate = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      void terminateWorkerProcessTree(child).finally(() => reject(error));
    };
    const onAbort = () => failAndTerminate(abortReason(input.abortSignal));
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputBytes = 0;
    const child = spawn(input.executable, input.args, {
      cwd: input.libreOfficeProgramDirectory,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        PATH: [input.libreOfficeProgramDirectory, process.env.PATH].filter(Boolean).join(path.delimiter),
        PYTHONPATH: [input.libreOfficeProgramDirectory, existingPythonPath].filter(Boolean).join(path.delimiter),
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > 2 * 1024 * 1024) {
        failAndTerminate(new Error('LibreOffice UNO program worker exceeded the 2MB diagnostics limit.'));
        return;
      }
      chunks.push(chunk);
    };
    child.stdout?.on('data', (chunk: Buffer) => collect(stdoutChunks, chunk));
    let stderrPending = '';
    const resetIdleTimeout = () => {
      if (idleTimeout) clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => {
        failAndTerminate(new Error(`LibreOffice UNO program worker made no progress for ${WORKER_IDLE_TIMEOUT_MS}ms. The saved draft remains editable.`));
      }, WORKER_IDLE_TIMEOUT_MS);
      idleTimeout.unref?.();
    };
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrPending += chunk.toString('utf8');
      const lines = stderrPending.split(/\r?\n/);
      stderrPending = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith(PROGRESS_PREFIX)) {
          resetIdleTimeout();
          try { void Promise.resolve(input.onProgress?.(JSON.parse(line.slice(PROGRESS_PREFIX.length)))).catch(() => undefined); } catch { /* Ignore malformed progress only. */ }
        } else collect(stderrChunks, Buffer.from(`${line}\n`, 'utf8'));
      }
    });
    child.once('error', (error) => failAndTerminate(error));
    child.once('close', (code, signal) => {
      if (settled) return;
      if (stderrPending) stderrChunks.push(Buffer.from(stderrPending, 'utf8'));
      settled = true;
      cleanup();
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code !== 0) {
        reject(new Error(String(stderr || stdout || `Worker exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.`).trim()));
        return;
      }
      try {
        const report = JSON.parse(String(stdout || '').trim()) as Record<string, unknown>;
        if (input.requireBytes !== false && !Number.isFinite(Number(report.bytes))) throw new Error('missing bytes');
        resolve(report);
      } catch (parseError) {
        reject(new Error(`LibreOffice UNO program worker returned unreadable diagnostics: ${parseError instanceof Error ? parseError.message : String(parseError)}`));
      }
    });
    resetIdleTimeout();
    hardTimeout = setTimeout(() => {
      failAndTerminate(new Error(`LibreOffice UNO program worker exceeded the ${WORKER_HARD_TIMEOUT_MS}ms hard limit. The saved draft remains editable.`));
    }, WORKER_HARD_TIMEOUT_MS);
    hardTimeout.unref?.();
    input.abortSignal?.addEventListener('abort', onAbort, { once: true });
  });
}

const UNO_FACADE_CATALOG_CACHE = new Map<string, Promise<Record<string, unknown>>>();

async function inspectUnoApiUncached(input: {
  documentType: OfficeDocumentKind;
  query?: string;
  offset?: number;
  limit?: number;
}) {
  const soffice = await resolveLibreOfficeExecutable();
  if (!soffice) throw new Error('UNO API inspection requires LibreOffice, but no LibreOffice executable is available.');
  const python = await resolveLibreOfficePythonExecutable(soffice);
  if (!python) throw new Error('UNO API inspection requires a Python interpreter with PyUNO support.');
  const worker = await resolveUnoProgramWorker();
  if (!worker) throw new Error('LibreOffice UNO program worker is missing from the application runtime.');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-uno-api-'));
  try {
    return await runWorker({
      executable: python,
      args: [
        worker,
        '--inspect-target', 'facade',
        '--document-type', input.documentType,
        '--profile', path.join(directory, 'profile'),
        '--soffice', soffice,
        '--api-offset', String(Math.max(0, input.offset || 0)),
        '--api-limit', String(Math.min(120, Math.max(1, input.limit || 40))),
        ...(input.query ? ['--api-query', input.query] : []),
      ],
      libreOfficeProgramDirectory: path.dirname(soffice),
      requireBytes: false,
    });
  } finally {
    await rm(directory, { force: true, recursive: true, maxRetries: 3, retryDelay: 150 }).catch(() => undefined);
  }
}

async function stopPersistentUnoHost(host = persistentUnoHost) {
  if (!host) return;
  if (persistentUnoHost === host) persistentUnoHost = undefined;
  await terminateWorkerProcessTree(host.child).catch(() => undefined);
  await rm(host.directory, { force: true, recursive: true, maxRetries: 3, retryDelay: 150 }).catch(() => undefined);
}

async function ensurePersistentUnoHost(executable: string) {
  const current = persistentUnoHost;
  if (current && current.executable === executable && current.child.exitCode === null) return current;
  if (current) await stopPersistentUnoHost(current);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-uno-host-'));
  const pipeName = `webpilot_host_${process.pid}_${randomUUID().replace(/-/g, '')}`;
  const profile = path.join(directory, 'profile');
  const accept = `pipe,name=${pipeName};urp;StarOffice.ComponentContext`;
  const child = spawn(executable, [
    '--headless', '--nologo', '--nodefault', '--nofirststartwizard', '--norestore', '--nolockcheck',
    `-env:UserInstallation=${pathToFileURL(profile).href}`,
    `--accept=${accept}`,
  ], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const host: PersistentUnoHost = { child, directory, executable, pipeName };
  persistentUnoHost = host;
  child.once('error', () => {
    if (persistentUnoHost === host) persistentUnoHost = undefined;
    void rm(directory, { force: true, recursive: true, maxRetries: 3, retryDelay: 150 }).catch(() => undefined);
  });
  child.once('exit', () => {
    if (persistentUnoHost === host) persistentUnoHost = undefined;
    void rm(directory, { force: true, recursive: true, maxRetries: 3, retryDelay: 150 }).catch(() => undefined);
  });
  if (!persistentUnoExitHookInstalled) {
    persistentUnoExitHookInstalled = true;
    process.once('exit', () => {
      persistentUnoHost?.child.kill();
    });
  }
  return host;
}

async function withPersistentUnoHost<T>(
  executable: string,
  operation: (host: PersistentUnoHost) => Promise<T>,
) {
  let release!: () => void;
  const previous = persistentUnoQueue;
  persistentUnoQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation(await ensurePersistentUnoHost(executable));
  } finally {
    release();
  }
}

export async function inspectUnoApi(input: {
  documentType: OfficeDocumentKind;
  query?: string;
  offset?: number;
  limit?: number;
}) {
  // Cache each exact installed module independently. Repeating a module query
  // is free, while unrelated modules stay out of the model context.
  const normalizedQuery = String(input.query || '').trim().toLowerCase();
  const workerPath = await resolveUnoProgramWorker();
  const workerDigest = workerPath ? createHash('sha256').update(await readFile(workerPath)).digest('hex') : 'missing-worker';
  const cacheKey = `${workerDigest}:${input.documentType}:${normalizedQuery || '__index__'}`;
  let pending = UNO_FACADE_CATALOG_CACHE.get(cacheKey);
  if (!pending) {
    pending = inspectUnoApiUncached({
      documentType: input.documentType,
      query: normalizedQuery || undefined,
      limit: 120,
    });
    if (UNO_FACADE_CATALOG_CACHE.size >= 128) UNO_FACADE_CATALOG_CACHE.delete(UNO_FACADE_CATALOG_CACHE.keys().next().value!);
    UNO_FACADE_CATALOG_CACHE.set(cacheKey, pending);
    pending.catch(() => {
      if (UNO_FACADE_CATALOG_CACHE.get(cacheKey) === pending) {
        UNO_FACADE_CATALOG_CACHE.delete(cacheKey);
      }
    });
  }
  return pending;
}

export async function generateUnoProgramDocument(input: {
  sourceCode?: string;
  sourcePath?: string;
  fileName: string;
  documentType: OfficeDocumentKind;
  assetsPath?: string;
  requiredSourceAssetName?: string;
  abortSignal?: AbortSignal;
  outputPath?: string;
  previewPath?: string;
  onProgress?: (progress: { phase: string; message: string; current?: number; total?: number }) => void | Promise<void>;
}): Promise<UnoGeneratedDocument> {
  if (input.abortSignal?.aborted) throw abortReason(input.abortSignal);
  if (Boolean(input.sourceCode) === Boolean(input.sourcePath)) throw new Error('UNO generation requires exactly one of sourceCode or sourcePath.');
  const sourceCode = input.sourceCode ?? await readFile(input.sourcePath!, 'utf8');
  assertControlledUnoProgram(sourceCode);
  const expectedSourceDigest = createHash('sha256').update(sourceCode, 'utf8').digest('hex');
  const extension = path.extname(input.fileName).toLowerCase();
  if (!OUTPUT_EXTENSIONS.has(extension)) throw new Error(`UNO worker does not support ${extension || 'an extension'} as an Office artifact.`);
  const soffice = await resolveLibreOfficeExecutable();
  if (!soffice) throw new Error('UNO document generation requires LibreOffice, but no LibreOffice executable is available.');
  const python = await resolveLibreOfficePythonExecutable(soffice);
  if (!python) throw new Error('UNO document generation requires a Python interpreter with PyUNO support. Set LIBREOFFICE_PYTHON_PATH when it is not bundled with LibreOffice.');
  const worker = await resolveUnoProgramWorker();
  if (!worker) throw new Error('LibreOffice UNO program worker is missing from the application runtime.');

  const directory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-uno-program-'));
  try {
    const outputPath = input.outputPath || path.join(directory, `output${extension}`);
    const previewPath = input.previewPath || path.join(directory, 'preview.pdf');
    const programPath = input.sourcePath || path.join(directory, 'draft.py');
    if (!input.sourcePath) await writeFile(programPath, sourceCode, 'utf8');
    const report = await withPersistentUnoHost(soffice, async (initialHost) => {
      let host = initialHost;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          return await runWorker({
            executable: python,
            args: [
              worker,
              '--program', programPath,
              '--output', outputPath,
              '--preview', previewPath,
              '--assets', input.assetsPath || directory,
              '--document-type', input.documentType,
              '--profile', path.join(directory, `worker-profile-${attempt}`),
              '--soffice', soffice,
              '--uno-pipe', host.pipeName,
              '--expected-source-digest', expectedSourceDigest,
              ...(input.requiredSourceAssetName ? ['--required-source-asset', input.requiredSourceAssetName] : []),
            ],
            libreOfficeProgramDirectory: path.dirname(soffice),
            abortSignal: input.abortSignal,
            onProgress: input.onProgress,
          });
        } catch (error) {
          // A failed worker may have left a document handle in the shared
          // Desktop. Recycle the host before propagating or retrying so the
          // next edit starts from a clean office process.
          await stopPersistentUnoHost(host);
          if (attempt >= 2 || input.abortSignal?.aborted || !isTransientUnoBridgeError(error)) throw error;
          await Promise.all([
            rm(outputPath, { force: true }).catch(() => undefined),
            rm(previewPath, { force: true }).catch(() => undefined),
          ]);
          await input.onProgress?.({
            phase: 'bridge-retry',
            message: 'The persistent LibreOffice UNO bridge disconnected; rebuilding the host and retrying once.',
            current: attempt,
            total: 2,
          });
          host = await ensurePersistentUnoHost(soffice);
        }
      }
      throw new Error('LibreOffice UNO program worker completed without a report.');
    });
    if (!report) throw new Error('LibreOffice UNO program worker completed without a report.');
    return {
      buffer: input.outputPath ? Buffer.alloc(0) : await readFile(outputPath),
      outputPath,
      previewPdf: input.previewPath ? undefined : await readFile(previewPath),
      previewPath,
      report,
    };
  } finally {
    await rm(directory, { force: true, recursive: true, maxRetries: 3, retryDelay: 150 }).catch(() => undefined);
  }
}
