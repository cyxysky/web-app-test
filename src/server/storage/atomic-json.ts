import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function writeTextFileAtomic(filePath: string, content: string) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tempPath, content, 'utf8');

  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      renameSync(tempPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(code || '')) {
        rmSync(tempPath, { force: true });
        throw error;
      }
      sleepSync(25 * (attempt + 1));
    }
  }

  try {
    copyFileSync(tempPath, filePath);
  } finally {
    rmSync(tempPath, { force: true });
  }
  if (!existsSync(filePath) && lastError) throw lastError;
}

export function writeJsonFileAtomic(filePath: string, value: unknown, space = 2) {
  writeTextFileAtomic(filePath, JSON.stringify(value, null, space));
}
