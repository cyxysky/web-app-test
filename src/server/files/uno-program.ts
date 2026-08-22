import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { OfficeDocumentKind } from './office-document-spec';
import { resolveLibreOfficeExecutable, resolveLibreOfficePythonExecutable } from './libreoffice';

const WORKER_TIMEOUT_MS = 120_000;
const PROGRAM_ENTRYPOINT = /^\s*def\s+create_document\s*\(\s*job\s*\)\s*:/m;
const OUTPUT_EXTENSIONS = new Set(['.doc', '.docx', '.odt', '.xls', '.xlsx', '.ods', '.ppt', '.pptx', '.odp', '.pdf']);

export type UnoGeneratedDocument = {
  buffer: Buffer;
  previewPdf?: Buffer;
  report: Record<string, unknown>;
};

export type UnoApiTarget = 'all' | 'document' | 'page' | 'text' | 'sheet' | 'cell' | 'shape';

/**
 * This intentionally validates only the public program contract. It does not
 * translate, rewrite, or infer UNO calls. Security is supplied by the Worker
 * process/container boundary, not by a brittle source-code blacklist.
 */
export function assertControlledUnoProgram(sourceCode: string) {
  if (!PROGRAM_ENTRYPOINT.test(sourceCode)) {
    throw new Error('UNO source must define def create_document(job): with exactly one job parameter.');
  }
  if (sourceCode.length > 180_000) throw new Error('UNO source exceeds the 180000 character limit.');
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
}) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    if (input.abortSignal?.aborted) {
      reject(abortReason(input.abortSignal));
      return;
    }
    const existingPythonPath = String(process.env.PYTHONPATH || '').trim();
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
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
    child.stderr?.on('data', (chunk: Buffer) => collect(stderrChunks, chunk));
    child.once('error', (error) => failAndTerminate(error));
    child.once('close', (code, signal) => {
      if (settled) return;
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
    timeout = setTimeout(() => {
      failAndTerminate(new Error(`LibreOffice UNO program worker timed out after ${WORKER_TIMEOUT_MS}ms. The draft may be stuck in a loop or blocking UNO call; edit the saved program before rendering the same source again.`));
    }, WORKER_TIMEOUT_MS);
    timeout.unref?.();
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
  abortSignal?: AbortSignal;
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
    const outputPath = path.join(directory, `output${extension}`);
    const previewPath = path.join(directory, 'preview.pdf');
    const programPath = input.sourcePath || path.join(directory, 'draft.py');
    const profilePath = path.join(directory, 'profile');
    if (!input.sourcePath) await writeFile(programPath, sourceCode, 'utf8');
    const report = await runWorker({
      executable: python,
      args: [worker, '--program', programPath, '--output', outputPath, '--preview', previewPath, '--assets', input.assetsPath || directory, '--document-type', input.documentType, '--profile', profilePath, '--soffice', soffice, '--expected-source-digest', expectedSourceDigest],
      libreOfficeProgramDirectory: path.dirname(soffice),
      abortSignal: input.abortSignal,
    });
    return {
      buffer: await readFile(outputPath),
      previewPdf: await readFile(previewPath),
      report,
    };
  } finally {
    await rm(directory, { force: true, recursive: true, maxRetries: 3, retryDelay: 150 }).catch(() => undefined);
  }
}
