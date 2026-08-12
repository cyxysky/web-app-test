import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

export async function convertOfficeBuffer(input: {
  buffer: Buffer;
  sourceExtension: string;
  targetExtension: string;
}) {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-office-generate-'));
  try {
    const sourcePath = path.join(temporaryDirectory, `source${input.sourceExtension}`);
    await writeFile(sourcePath, input.buffer);
    return await convertStagedOfficeFile({
      sourcePath,
      targetExtension: input.targetExtension,
      temporaryDirectory,
    });
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}
