import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OfficeDocumentKind } from '../../office/types.js';
import {
  convertOfficeFile,
  convertOfficeFileToPath,
  type LibreOfficeRuntimeOptions,
} from '../libreoffice.js';

const WORKER_IDLE_TIMEOUT_MS = Math.max(60_000, Number(process.env.OFFICE_WORKER_IDLE_TIMEOUT_MS) || 120_000);
const WORKER_HARD_TIMEOUT_MS = Math.max(WORKER_IDLE_TIMEOUT_MS, Number(process.env.OFFICE_WORKER_HARD_TIMEOUT_MS) || 30 * 60_000);
const PROGRESS_PREFIX = '__WEBPILOT_PROGRESS__';
const PROGRAM_ENTRYPOINT = /export\s+(?:async\s+)?function\s+createDocument\s*\(\s*job\s*\)/m;

export function assertControlledOfficeJsProgram(sourceCode: string) {
  if (!PROGRAM_ENTRYPOINT.test(sourceCode)) throw new Error('JavaScript Office source must export function createDocument(job).');
}

export type OfficeJsRuntimeOptions = {
  libreOffice?: LibreOfficeRuntimeOptions;
  runtimeRoot?: string;
  workerPath?: string;
};

export async function resolveOfficeJsProgramWorker(
  options: OfficeJsRuntimeOptions = {},
) {
  const configured = String(options.workerPath || process.env.OFFICE_JS_PROGRAM_WORKER_PATH || '').trim();
  const runtimeRoot = String(options.runtimeRoot || process.env.CAPABILITY_FILE_RUNTIME_DIR || '').trim();
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const bundled = path.resolve(moduleDirectory, '..', '..', '..', 'runtime', 'javascript', 'office-js-program-worker.mjs');
  const candidates = [
    configured,
    runtimeRoot ? path.join(runtimeRoot, 'javascript', 'office-js-program-worker.mjs') : '',
    bundled,
    path.join(process.cwd(), 'capability-runtime', 'file', 'javascript', 'office-js-program-worker.mjs'),
    path.join(process.cwd(), 'packages', 'capability-file', 'runtime', 'javascript', 'office-js-program-worker.mjs'),
    path.join(process.cwd(), 'node_modules', '@webpilot', 'capability-file', 'runtime', 'javascript', 'office-js-program-worker.mjs'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      // Continue through source and packaged locations.
    }
  }
  throw new Error('JavaScript Office worker is missing from the application runtime.');
}

function terminate(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform !== 'win32') {
    child.kill('SIGKILL');
    return;
  }
  spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
}

function runWorker(
  worker: string,
  args: string[],
  abortSignal?: AbortSignal,
  onProgress?: (progress: { phase: string; message: string; current?: number; total?: number }) => void | Promise<void>,
) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(abortSignal.reason instanceof Error ? abortSignal.reason : new Error('JavaScript Office generation was aborted.'));
      return;
    }
    const child = spawn(process.execPath, [worker, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let idleTimeout: ReturnType<typeof setTimeout> | undefined;
    const hardTimeout = setTimeout(() => finish(() => {
      terminate(child);
      reject(new Error(`JavaScript Office worker exceeded the ${WORKER_HARD_TIMEOUT_MS}ms hard limit.`));
    }), WORKER_HARD_TIMEOUT_MS);
    const resetIdleTimeout = () => {
      if (idleTimeout) clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => finish(() => {
        terminate(child);
        reject(new Error(`JavaScript Office worker made no progress for ${WORKER_IDLE_TIMEOUT_MS}ms.`));
      }), WORKER_IDLE_TIMEOUT_MS);
      idleTimeout.unref?.();
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (idleTimeout) clearTimeout(idleTimeout);
      clearTimeout(hardTimeout);
      abortSignal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => {
      terminate(child);
      reject(abortSignal?.reason instanceof Error ? abortSignal.reason : new Error('JavaScript Office generation was aborted.'));
    });
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    let stderrPending = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrPending += chunk.toString('utf8');
      const lines = stderrPending.split(/\r?\n/);
      stderrPending = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith(PROGRESS_PREFIX)) {
          resetIdleTimeout();
          try { void Promise.resolve(onProgress?.(JSON.parse(line.slice(PROGRESS_PREFIX.length)))).catch(() => undefined); } catch { /* Ignore malformed progress only. */ }
        } else stderr.push(Buffer.from(`${line}\n`, 'utf8'));
      }
    });
    child.once('error', (error) => finish(() => reject(error)));
    child.once('close', (code) => finish(() => {
      if (code !== 0) {
        reject(new Error(`${Buffer.concat(stderr).toString('utf8')}${stderrPending}` || `JavaScript Office worker exited with code ${code}.`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')) as Record<string, unknown>);
      } catch (error) {
        reject(new Error(`JavaScript Office worker returned invalid diagnostics: ${error instanceof Error ? error.message : String(error)}`));
      }
    }));
    resetIdleTimeout();
    hardTimeout.unref?.();
    abortSignal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function generateOfficeJsProgramDocument(input: {
  sourceCode?: string;
  sourcePath?: string;
  fileName: string;
  documentType: OfficeDocumentKind;
  assetsPath?: string;
  abortSignal?: AbortSignal;
  outputPath?: string;
  previewPath?: string;
  runtime?: OfficeJsRuntimeOptions;
  onProgress?: (progress: { phase: string; message: string; current?: number; total?: number }) => void | Promise<void>;
}) {
  if (Boolean(input.sourceCode) === Boolean(input.sourcePath)) throw new Error('JavaScript Office generation requires exactly one sourceCode or sourcePath.');
  const sourceCode = input.sourceCode ?? await readFile(input.sourcePath!, 'utf8');
  assertControlledOfficeJsProgram(sourceCode);
  const requestedExtension = path.extname(input.fileName).toLowerCase();
  const officeExtension = { presentation: '.pptx', word: '.docx', spreadsheet: '.xlsx' }[input.documentType];
  if (requestedExtension !== officeExtension && requestedExtension !== '.pdf') {
    throw new Error(`JavaScript ${input.documentType} generation requires ${officeExtension} or .pdf output.`);
  }
  // The JavaScript libraries author an editable Office source. PDF delivery is
  // a two-stage pipeline: author the matching Office format, then let the local
  // LibreOffice installation render that exact file to PDF.
  const outputExtension = requestedExtension === '.pdf' ? officeExtension : requestedExtension;
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-office-js-'));
  try {
    const programPath = input.sourcePath || path.join(temporaryDirectory, 'draft.mjs');
    const authoredPath = requestedExtension === '.pdf' || !input.outputPath
      ? path.join(temporaryDirectory, `output${outputExtension}`)
      : input.outputPath;
    if (!input.sourcePath) await writeFile(programPath, sourceCode, 'utf8');
    const report = await runWorker(await resolveOfficeJsProgramWorker(input.runtime), [
      '--program', programPath,
      '--output', authoredPath,
      '--assets', input.assetsPath || temporaryDirectory,
      '--expected-source-digest', createHash('sha256').update(sourceCode, 'utf8').digest('hex'),
    ], input.abortSignal, input.onProgress);
    await input.onProgress?.({ phase: 'reopen', message: '正在使用 LibreOffice 重新打开并验证文档' });
    const previewPath = input.previewPath || path.join(temporaryDirectory, 'preview.pdf');
    const wrotePreview = input.previewPath
      ? await convertOfficeFileToPath({
          absolutePath: authoredPath,
          sourceExtension: outputExtension,
          targetExtension: '.pdf',
          targetPath: previewPath,
          abortSignal: input.abortSignal,
          runtime: input.runtime?.libreOffice,
        })
      : false;
    const previewPdf = input.previewPath ? undefined : await convertOfficeFile({
      absolutePath: authoredPath,
      sourceExtension: outputExtension,
      targetExtension: '.pdf',
      abortSignal: input.abortSignal,
      runtime: input.runtime?.libreOffice,
    });
    if (!wrotePreview && !previewPdf) throw new Error('LibreOffice is required to reopen and preview JavaScript-generated Office files.');
    await input.onProgress?.({ phase: 'visual', message: '文档验证完成，预览已生成' });
    if (requestedExtension === '.pdf' && input.outputPath) await copyFile(previewPath, input.outputPath);
    const deliveredPath = input.outputPath || (requestedExtension === '.pdf' ? previewPath : authoredPath);
    return {
      buffer: input.outputPath ? undefined : requestedExtension === '.pdf' ? previewPdf : await readFile(authoredPath),
      outputPath: deliveredPath,
      previewPdf,
      previewPath,
      report: {
        ...report,
        requestedExtension,
        authoredExtension: outputExtension,
        convertedToPdf: requestedExtension === '.pdf',
      },
    };
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true, maxRetries: 3, retryDelay: 150 }).catch(() => undefined);
  }
}
