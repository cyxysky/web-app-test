import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pythonUnoProbeCache = new Map<string, Promise<boolean>>();

export type LibreOfficeRuntimeOptions = {
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  executablePath?: string;
  pythonPath?: string;
  serverRoot?: string;
};

export type OfficeFileConversionInput = {
  absolutePath: string;
  sourceExtension: string;
  targetExtension: string;
  abortSignal?: AbortSignal;
  runtime?: LibreOfficeRuntimeOptions;
  timeoutMs?: number;
};

function runtimeEnvironment(options: LibreOfficeRuntimeOptions) {
  return options.environment || process.env;
}

export async function resolveLibreOfficeExecutable(
  options: LibreOfficeRuntimeOptions = {},
) {
  const environment = runtimeEnvironment(options);
  const configured = String(options.executablePath || environment.LIBREOFFICE_PATH || '').trim();
  const packagedRoot = String(options.serverRoot || environment.WEBPILOT_SERVER_ROOT || '').trim();
  const cwd = options.cwd || process.cwd();
  const executableName = process.platform === 'win32' ? 'soffice.exe' : 'soffice';
  const candidates = [
    configured,
    packagedRoot ? path.join(packagedRoot, 'libreoffice', 'program', executableName) : '',
    path.join(cwd, 'libreoffice', 'program', executableName),
    path.join(cwd, '..', 'libreoffice', 'program', executableName),
    process.platform === 'win32'
      ? path.join(environment.ProgramFiles || 'C:\\Program Files', 'LibreOffice', 'program', 'soffice.exe')
      : '',
    process.platform === 'win32'
      ? path.join(environment['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'LibreOffice', 'program', 'soffice.exe')
      : '',
    ...String(environment.PATH || '').split(path.delimiter).flatMap((directory) => {
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
      // Keep searching configured, bundled, and PATH candidates.
    }
  }
  return undefined;
}

function runLibreOffice(
  executable: string,
  args: string[],
  options: { abortSignal?: AbortSignal; timeoutMs?: number } = {},
) {
  return new Promise<void>((resolve, reject) => {
    execFile(executable, args, {
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      ...(options.abortSignal ? { signal: options.abortSignal } : {}),
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
    }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function pythonSupportsUno(
  executable: string,
  libreOfficeProgramDirectory: string,
  environment: NodeJS.ProcessEnv,
) {
  const cacheKey = `${executable}\n${libreOfficeProgramDirectory}`;
  const cached = pythonUnoProbeCache.get(cacheKey);
  if (cached) return cached;
  const probe = new Promise<boolean>((resolve) => {
    const existingPythonPath = String(environment.PYTHONPATH || '').trim();
    execFile(executable, ['-c', 'import uno'], {
      cwd: libreOfficeProgramDirectory,
      env: {
        ...environment,
        PATH: [libreOfficeProgramDirectory, environment.PATH].filter(Boolean).join(path.delimiter),
        PYTHONPATH: [libreOfficeProgramDirectory, existingPythonPath].filter(Boolean).join(path.delimiter),
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
      timeout: 5_000,
      windowsHide: true,
    }, (error) => resolve(!error));
  });
  pythonUnoProbeCache.set(cacheKey, probe);
  return probe;
}

export async function resolveLibreOfficePythonExecutable(
  libreOfficeExecutable?: string,
  options: LibreOfficeRuntimeOptions = {},
) {
  const environment = runtimeEnvironment(options);
  const soffice = libreOfficeExecutable || await resolveLibreOfficeExecutable(options);
  const programDirectory = soffice ? path.dirname(soffice) : '';
  const configured = String(options.pythonPath || environment.LIBREOFFICE_PYTHON_PATH || '').trim();
  const pathCandidates = String(environment.PATH || '').split(path.delimiter).flatMap((directory) => {
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
      if (await pythonSupportsUno(candidate, programDirectory || path.dirname(candidate), environment)) {
        return candidate;
      }
    } catch {
      // Keep searching explicit, bundled, and PATH candidates.
    }
  }
  return undefined;
}

async function convertStagedOfficeFile(input: {
  sourcePath: string;
  targetExtension: string;
  temporaryDirectory: string;
  abortSignal?: AbortSignal;
  runtime?: LibreOfficeRuntimeOptions;
  timeoutMs?: number;
}) {
  input.abortSignal?.throwIfAborted();
  const executable = await resolveLibreOfficeExecutable(input.runtime);
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
  ], input);
  input.abortSignal?.throwIfAborted();
  const outputName = (await readdir(outputDirectory))
    .find((name) => path.extname(name).toLowerCase() === input.targetExtension.toLowerCase());
  if (!outputName) throw new Error(`LibreOffice did not produce a ${input.targetExtension} file.`);
  return path.join(outputDirectory, outputName);
}

async function withConvertedOfficeFile<T>(
  input: OfficeFileConversionInput,
  consume: (convertedPath: string) => Promise<T>,
) {
  input.abortSignal?.throwIfAborted();
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'capability-file-office-convert-'));
  try {
    const sourcePath = path.join(temporaryDirectory, `source${input.sourceExtension}`);
    await copyFile(input.absolutePath, sourcePath);
    const convertedPath = await convertStagedOfficeFile({
      sourcePath,
      targetExtension: input.targetExtension,
      temporaryDirectory,
      abortSignal: input.abortSignal,
      runtime: input.runtime,
      timeoutMs: input.timeoutMs,
    });
    return convertedPath ? consume(convertedPath) : undefined;
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

export async function convertOfficeFile(input: OfficeFileConversionInput) {
  return withConvertedOfficeFile(input, (convertedPath) => readFile(convertedPath));
}

export async function convertOfficeFileToPath(input: OfficeFileConversionInput & {
  targetPath: string;
}) {
  return (await withConvertedOfficeFile(input, async (convertedPath) => {
    input.abortSignal?.throwIfAborted();
    await copyFile(convertedPath, input.targetPath);
    return true;
  })) ?? false;
}
