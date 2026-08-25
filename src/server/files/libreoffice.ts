import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pythonUnoProbeCache = new Map<string, Promise<boolean>>();

export async function resolveLibreOfficeExecutable() {
  const configured = String(process.env.LIBREOFFICE_PATH || '').trim();
  const packagedRoot = String(process.env.WEBPILOT_SERVER_ROOT || '').trim();
  const executableName = process.platform === 'win32' ? 'soffice.exe' : 'soffice';
  const candidates = [
    configured,
    packagedRoot ? path.join(packagedRoot, 'libreoffice', 'program', executableName) : '',
    path.join(process.cwd(), 'libreoffice', 'program', executableName),
    path.join(process.cwd(), '..', 'libreoffice', 'program', executableName),
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
  return path.join(outputDirectory, outputName);
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
    const convertedPath = await convertStagedOfficeFile({
      sourcePath,
      targetExtension: input.targetExtension,
      temporaryDirectory,
    });
    return convertedPath ? await readFile(convertedPath) : undefined;
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

export async function convertOfficeFileToPath(input: {
  absolutePath: string;
  sourceExtension: string;
  targetExtension: string;
  targetPath: string;
}) {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-office-convert-'));
  try {
    const sourcePath = path.join(temporaryDirectory, `source${input.sourceExtension}`);
    await copyFile(input.absolutePath, sourcePath);
    const convertedPath = await convertStagedOfficeFile({ sourcePath, targetExtension: input.targetExtension, temporaryDirectory });
    if (!convertedPath) return false;
    await copyFile(convertedPath, input.targetPath);
    return true;
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}
