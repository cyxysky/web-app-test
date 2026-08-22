import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appDataRoot, artifactsRoot } from '@/server/storage/paths';
import type { OfficeBlock, OfficeDocumentSpec } from './office-document-spec';

const OFFICE_WORKER_TIMEOUT_MS = 120_000;
let officeGenerationQueue = Promise.resolve();
const pythonUnoProbeCache = new Map<string, Promise<boolean>>();

function isPathWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolveGraphicArtifactSource(source: unknown) {
  if (typeof source !== 'string' || !source.trim()) return source;
  const value = source.trim();
  if (/^(?:data:|file:|https?:)/i.test(value) || path.isAbsolute(value)) return value;
  const root = artifactsRoot();
  const candidate = path.resolve(root, value.replace(/\\/g, '/'));
  if (!isPathWithin(root, candidate)) return value;
  try {
    await access(candidate, constants.R_OK);
    return candidate;
  } catch {
    return value;
  }
}

async function resolveGraphicArtifactBlocks(blocks: OfficeBlock[]): Promise<OfficeBlock[]> {
  return Promise.all(blocks.map(async (block) => {
    const normalized: OfficeBlock = { ...block };
    if (typeof normalized.source === 'string') {
      normalized.source = await resolveGraphicArtifactSource(normalized.source) as string;
    } else if (typeof normalized.url === 'string') {
      normalized.url = await resolveGraphicArtifactSource(normalized.url);
    }
    if (Array.isArray(normalized.children)) {
      normalized.children = await resolveGraphicArtifactBlocks(normalized.children);
    }
    if (Array.isArray(normalized.columns)) {
      normalized.columns = await Promise.all(normalized.columns.map(async (column) => ({
        ...column,
        blocks: Array.isArray(column.blocks) ? await resolveGraphicArtifactBlocks(column.blocks) : column.blocks,
      })));
    }
    return normalized;
  }));
}

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
  return new Promise<Record<string, unknown>>((resolve, reject) => {
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
    }, (error, stdout, stderr) => {
      if (!error) {
        try {
          const report = JSON.parse(String(stdout || '').trim()) as Record<string, unknown>;
          if (!report || typeof report !== 'object' || !Number.isFinite(Number(report.bytes))) {
            reject(new Error('LibreOffice UNO worker returned an invalid generation report.'));
            return;
          }
          resolve(report);
        } catch (parseError) {
          reject(new Error(`LibreOffice UNO worker returned unreadable diagnostics: ${parseError instanceof Error ? parseError.message : String(parseError)}`));
        }
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
  const serialized = JSON.stringify({
    ...spec,
    blocks: await resolveGraphicArtifactBlocks(spec.blocks),
  });

  return enqueueOfficeGeneration(async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-office-uno-'));
    try {
      const inputPath = path.join(temporaryDirectory, 'office-spec.json');
      const outputPath = path.join(temporaryDirectory, `output${extension}`);
      const profilePath = path.join(appDataRoot(), 'libreoffice', 'uno-profile');
      await writeFile(inputPath, serialized, 'utf8');
      const report = await runOfficeWorker({
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
      return { buffer: await readFile(outputPath), report };
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
