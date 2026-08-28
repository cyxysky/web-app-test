import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { OfficeDocumentKind } from './office-document-spec';
import { resolveLibreOfficeExecutable, resolveLibreOfficePythonExecutable } from './libreoffice';

const WORKER_IDLE_TIMEOUT_MS = Math.max(60_000, Number(process.env.OFFICE_WORKER_IDLE_TIMEOUT_MS) || 120_000);
const WORKER_HARD_TIMEOUT_MS = Math.max(WORKER_IDLE_TIMEOUT_MS, Number(process.env.OFFICE_WORKER_HARD_TIMEOUT_MS) || 30 * 60_000);
const PROGRESS_PREFIX = '__WEBPILOT_PROGRESS__';
const PROGRAM_ENTRYPOINT = /^\s*def\s+create_document\s*\(\s*job\s*\)\s*:/m;
const OUTPUT_EXTENSIONS = new Set(['.doc', '.docx', '.odt', '.xls', '.xlsx', '.ods', '.ppt', '.pptx', '.odp', '.pdf']);

export type UnoGeneratedDocument = {
  buffer: Buffer;
  outputPath: string;
  previewPdf?: Buffer;
  previewPath: string;
  report: Record<string, unknown>;
};

export type UnoApiTarget = 'all' | 'document' | 'page' | 'text' | 'cursor' | 'sheet' | 'cell' | 'shape' | 'table' | 'table-column' | 'table-row' | 'chart' | 'chart-data';

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

export async function resolveUnoProgramWorker() {
  const configured = String(process.env.LIBREOFFICE_UNO_PROGRAM_WORKER_PATH || '').trim();
  const candidates = [
    configured,
    path.join(process.cwd(), 'src', 'server', 'files', 'libreoffice-program-worker.py'),
    path.join(process.cwd(), 'server', 'src', 'server', 'files', 'libreoffice-program-worker.py'),
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

export async function inspectUnoApi(input: {
  documentType: OfficeDocumentKind;
  target: UnoApiTarget;
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
        '--inspect-target', input.target,
        '--document-type', input.documentType,
        '--profile', path.join(directory, 'profile'),
        '--soffice', soffice,
        '--api-offset', String(Math.max(0, input.offset || 0)),
        '--api-limit', String(input.target === 'all' ? 2_000 : Math.min(300, Math.max(1, input.limit || 120))),
        ...(input.query ? ['--api-query', input.query] : []),
      ],
      libreOfficeProgramDirectory: path.dirname(soffice),
      requireBytes: false,
    });
  } finally {
    await rm(directory, { force: true, recursive: true, maxRetries: 3, retryDelay: 150 }).catch(() => undefined);
  }
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
    const profilePath = path.join(directory, 'profile');
    if (!input.sourcePath) await writeFile(programPath, sourceCode, 'utf8');
    const report = await runWorker({
      executable: python,
      args: [
        worker,
        '--program', programPath,
        '--output', outputPath,
        '--preview', previewPath,
        '--assets', input.assetsPath || directory,
        '--document-type', input.documentType,
        '--profile', profilePath,
        '--soffice', soffice,
        '--expected-source-digest', expectedSourceDigest,
        ...(input.requiredSourceAssetName ? ['--required-source-asset', input.requiredSourceAssetName] : []),
      ],
      libreOfficeProgramDirectory: path.dirname(soffice),
      abortSignal: input.abortSignal,
      onProgress: input.onProgress,
    });
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
