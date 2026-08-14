import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appDataRoot } from '@/server/storage/paths';
import type { OfficeDocumentSpec } from './office-document-spec';

const OFFICE_WORKER_TIMEOUT_MS = 120_000;
const OFFICE_SPEC_MAX_BYTES = 8 * 1024 * 1024;
let officeGenerationQueue = Promise.resolve();
const pythonUnoProbeCache = new Map<string, Promise<boolean>>();

function enqueueOfficeGeneration<T>(operation: () => Promise<T>) {
  const result = officeGenerationQueue.then(operation, operation);
  officeGenerationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export async function resolveLibreOfficeExecutable() {
  const configured = String(process.env.LIBREOFFICE_PATH || '').trim();
  const candidates = [
    configured,
    process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'LibreOffice', 'program', 'soffice.exe') : '',
    process.platform === 'win32' ? path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'LibreOffice', 'program', 'soffice.exe') : '',
    ...String(process.env.PATH || '').split(path.delimiter).flatMap((directory) => {
      const clean = directory.replace(/^"|"$/g, '').trim();
      if (!clean) return [];
      return process.platform === 'win32'
        ? [path.join(clean, 'soffice.exe'), path.join(clean, 'libreoffice.exe')]
        : [path.join(clean, 'soffice'), path.join(clean, 'libreoffice')];
    }),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching configured and PATH candidates.
    }
  }
  return undefined;
}

function runLibreOffice(executable: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    execFile(executable, args, { maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function pythonSupportsUno(executable: string, libreOfficeProgramDirectory: string) {
  const cacheKey = `${executable}\n${libreOfficeProgramDirectory}`;
  const cached = pythonUnoProbeCache.get(cacheKey);
  if (cached) return cached;
  const probe = new Promise<boolean>((resolve) => {
    const existingPythonPath = String(process.env.PYTHONPATH || '').trim();
    execFile(executable, ['-c', 'import uno'], {
      cwd: libreOfficeProgramDirectory,
      env: {
        ...process.env,
        PATH: [libreOfficeProgramDirectory, process.env.PATH].filter(Boolean).join(path.delimiter),
        PYTHONPATH: [libreOfficeProgramDirectory, existingPythonPath].filter(Boolean).join(path.delimiter),
      },
      timeout: 5_000,
      windowsHide: true,
    }, (error) => resolve(!error));
  });
  pythonUnoProbeCache.set(cacheKey, probe);
  return probe;
}

export async function resolveLibreOfficePythonExecutable(libreOfficeExecutable?: string) {
  const soffice = libreOfficeExecutable || await resolveLibreOfficeExecutable();
  const programDirectory = soffice ? path.dirname(soffice) : '';
  const configured = String(process.env.LIBREOFFICE_PYTHON_PATH || '').trim();
  const pathCandidates = String(process.env.PATH || '').split(path.delimiter).flatMap((directory) => {
    const clean = directory.replace(/^"|"$/g, '').trim();
    if (!clean) return [];
    return process.platform === 'win32'
      ? [path.join(clean, 'python.exe'), path.join(clean, 'python3.exe')]
      : [path.join(clean, 'python3'), path.join(clean, 'python')];
  });
  const candidates = [
    configured,
    programDirectory ? path.join(programDirectory, process.platform === 'win32' ? 'python.exe' : 'python') : '',
    programDirectory ? path.join(programDirectory, 'python3') : '',
    ...pathCandidates,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if (await pythonSupportsUno(candidate, programDirectory || path.dirname(candidate))) return candidate;
    } catch {
      // Keep searching explicit, bundled, and PATH candidates.
    }
  }
  return undefined;
}

export async function resolveLibreOfficeOfficeWorker() {
  const configured = String(process.env.LIBREOFFICE_UNO_WORKER_PATH || '').trim();
  const candidates = [
    configured,
    path.join(process.cwd(), 'src', 'server', 'files', 'libreoffice-office-worker.py'),
    path.join(process.cwd(), 'server', 'src', 'server', 'files', 'libreoffice-office-worker.py'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      // Keep searching source and packaged runtime locations.
    }
  }
  return undefined;
}

function runOfficeWorker(input: {
  args: string[];
  libreOfficeProgramDirectory: string;
  pythonExecutable: string;
}) {
  return new Promise<void>((resolve, reject) => {
    const existingPythonPath = String(process.env.PYTHONPATH || '').trim();
    const pythonPath = [input.libreOfficeProgramDirectory, existingPythonPath].filter(Boolean).join(path.delimiter);
    execFile(input.pythonExecutable, input.args, {
      cwd: input.libreOfficeProgramDirectory,
      env: {
        ...process.env,
        PATH: [input.libreOfficeProgramDirectory, process.env.PATH].filter(Boolean).join(path.delimiter),
        PYTHONPATH: pythonPath,
      },
      maxBuffer: 2 * 1024 * 1024,
      timeout: OFFICE_WORKER_TIMEOUT_MS,
      windowsHide: true,
    }, (error, _stdout, stderr) => {
      if (!error) {
        resolve();
        return;
      }
      const detail = String(stderr || '').trim();
      reject(new Error(detail || error.message));
    });
  });
}

export async function generateOfficeDocument(spec: OfficeDocumentSpec) {
  const libreOfficeExecutable = await resolveLibreOfficeExecutable();
  if (!libreOfficeExecutable) {
    throw new Error('Office document generation requires LibreOffice, but no LibreOffice executable is available.');
  }
  const pythonExecutable = await resolveLibreOfficePythonExecutable(libreOfficeExecutable);
  if (!pythonExecutable) {
    throw new Error('LibreOffice UNO generation requires a Python interpreter with PyUNO support. Set LIBREOFFICE_PYTHON_PATH when it is not bundled with LibreOffice.');
  }
  const worker = await resolveLibreOfficeOfficeWorker();
  if (!worker) {
    throw new Error('LibreOffice UNO worker is missing from the application runtime.');
  }
  const extension = path.extname(spec.fileName).toLowerCase();
  const serialized = JSON.stringify(spec);
  if (Buffer.byteLength(serialized, 'utf8') > OFFICE_SPEC_MAX_BYTES) {
    throw new Error(`Office document specification exceeds ${OFFICE_SPEC_MAX_BYTES} bytes.`);
  }

  return enqueueOfficeGeneration(async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-office-uno-'));
    try {
      const inputPath = path.join(temporaryDirectory, 'office-spec.json');
      const outputPath = path.join(temporaryDirectory, `output${extension}`);
      const profilePath = path.join(appDataRoot(), 'libreoffice', 'uno-profile');
      await writeFile(inputPath, serialized, 'utf8');
      await runOfficeWorker({
        args: [
          worker,
          '--input', inputPath,
          '--output', outputPath,
          '--profile', profilePath,
          '--soffice', libreOfficeExecutable,
        ],
        libreOfficeProgramDirectory: path.dirname(libreOfficeExecutable),
        pythonExecutable,
      });
      return await readFile(outputPath);
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
}

async function convertStagedOfficeFile(input: {
  sourcePath: string;
  targetExtension: string;
  temporaryDirectory: string;
}) {
  const executable = await resolveLibreOfficeExecutable();
  if (!executable) return undefined;
  const outputDirectory = path.join(input.temporaryDirectory, 'output');
  const profileDirectory = path.join(input.temporaryDirectory, 'profile');
  await Promise.all([
    mkdir(outputDirectory, { recursive: true }),
    mkdir(profileDirectory, { recursive: true }),
  ]);
  await runLibreOffice(executable, [
    '--headless',
    '--nologo',
    '--nodefault',
    '--nolockcheck',
    `-env:UserInstallation=${pathToFileURL(profileDirectory).href}`,
    '--convert-to',
    input.targetExtension.replace(/^\./, ''),
    '--outdir',
    outputDirectory,
    input.sourcePath,
  ]);
  const outputName = (await readdir(outputDirectory))
    .find((name) => path.extname(name).toLowerCase() === input.targetExtension.toLowerCase());
  if (!outputName) throw new Error(`LibreOffice did not produce a ${input.targetExtension} file.`);
  return readFile(path.join(outputDirectory, outputName));
}

export async function convertOfficeFile(input: {
  absolutePath: string;
  sourceExtension: string;
  targetExtension: string;
}) {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-office-convert-'));
  try {
    const sourcePath = path.join(temporaryDirectory, `source${input.sourceExtension}`);
    await copyFile(input.absolutePath, sourcePath);
    return await convertStagedOfficeFile({
      sourcePath,
      targetExtension: input.targetExtension,
      temporaryDirectory,
    });
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}
