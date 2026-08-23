import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { convertOfficeFile } from './libreoffice';
import type { OfficeDocumentKind } from './office-document-spec';

const WORKER_TIMEOUT_MS = 120_000;
const PROGRAM_ENTRYPOINT = /export\s+(?:async\s+)?function\s+createDocument\s*\(\s*job\s*\)/m;

export function assertControlledOfficeJsProgram(sourceCode: string) {
  if (!PROGRAM_ENTRYPOINT.test(sourceCode)) throw new Error('JavaScript Office source must export function createDocument(job).');
  if (sourceCode.length > 180_000) throw new Error('JavaScript Office source exceeds the 180000 character limit.');
}

async function resolveWorker() {
  const candidates = [
    path.join(process.cwd(), 'src', 'server', 'files', 'office-js-program-worker.mjs'),
    path.join(process.cwd(), 'server', 'src', 'server', 'files', 'office-js-program-worker.mjs'),
  ];
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

function runWorker(worker: string, args: string[], abortSignal?: AbortSignal) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(abortSignal.reason instanceof Error ? abortSignal.reason : new Error('JavaScript Office generation was aborted.'));
      return;
    }
    const child = spawn(process.execPath, [worker, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      abortSignal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => {
      terminate(child);
      reject(abortSignal?.reason instanceof Error ? abortSignal.reason : new Error('JavaScript Office generation was aborted.'));
    });
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => finish(() => reject(error)));
    child.once('close', (code) => finish(() => {
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString('utf8') || `JavaScript Office worker exited with code ${code}.`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')) as Record<string, unknown>);
      } catch (error) {
        reject(new Error(`JavaScript Office worker returned invalid diagnostics: ${error instanceof Error ? error.message : String(error)}`));
      }
    }));
    const timeout = setTimeout(() => finish(() => {
      terminate(child);
      reject(new Error(`JavaScript Office worker timed out after ${WORKER_TIMEOUT_MS}ms.`));
    }), WORKER_TIMEOUT_MS);
    timeout.unref?.();
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
    const outputPath = path.join(temporaryDirectory, `output${outputExtension}`);
    if (!input.sourcePath) await writeFile(programPath, sourceCode, 'utf8');
    const report = await runWorker(await resolveWorker(), [
      '--program', programPath,
      '--output', outputPath,
      '--assets', input.assetsPath || temporaryDirectory,
      '--expected-source-digest', createHash('sha256').update(sourceCode, 'utf8').digest('hex'),
    ], input.abortSignal);
    const previewPdf = await convertOfficeFile({ absolutePath: outputPath, sourceExtension: outputExtension, targetExtension: '.pdf' });
    if (!previewPdf) throw new Error('LibreOffice is required to reopen and preview JavaScript-generated Office files.');
    return {
      buffer: requestedExtension === '.pdf' ? previewPdf : await readFile(outputPath),
      previewPdf,
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
