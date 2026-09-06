import { CapabilityTaskQueue } from '@webpilot/capability-sdk';
import { runCapabilityProcess } from '@webpilot/capability-sdk/node';
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

const officeJsQueue = new CapabilityTaskQueue({ concurrency: 2, maxQueued: 32, queueTimeoutMs: 120_000 });

function runWorker(
  worker: string,
  args: string[],
  abortSignal?: AbortSignal,
  onProgress?: (progress: { phase: string; message: string; current?: number; total?: number }) => void | Promise<void>,
) {
  return officeJsQueue.run(async (signal) => {
    const idle = new AbortController();
    const combined = AbortSignal.any([signal, idle.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = '';
    const reset = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => idle.abort(new Error(`JavaScript Office worker made no progress for ${WORKER_IDLE_TIMEOUT_MS}ms.`)), WORKER_IDLE_TIMEOUT_MS);
    };
    reset();
    try {
      const result = await runCapabilityProcess({ executable: process.execPath, args: [worker, ...args],
        signal: combined, timeoutMs: WORKER_HARD_TIMEOUT_MS, maxOutputChars: 10 * 1024 * 1024,
        onStderr: (chunk) => {
          pending += chunk;
          const lines = pending.split(/\r?\n/);
          pending = lines.pop() || '';
          for (const line of lines) if (line.startsWith(PROGRESS_PREFIX)) {
            reset();
            try { void Promise.resolve(onProgress?.(JSON.parse(line.slice(PROGRESS_PREFIX.length)))).catch(() => undefined); } catch { /* Ignore malformed progress. */ }
          }
        },
      });
      return JSON.parse(result.stdout) as Record<string, unknown>;
    } finally { if (timer) clearTimeout(timer); }
  }, { abortSignal });
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
