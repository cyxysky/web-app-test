import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveLibreOfficeExecutable } from '@webpilot/capability-file/node';

test('finds LibreOffice bundled beside a packaged server', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-packaged-libreoffice-'));
  const previousRoot = process.env.WEBPILOT_SERVER_ROOT;
  const previousExecutable = process.env.LIBREOFFICE_PATH;
  const executable = path.join(
    root,
    'libreoffice',
    'program',
    process.platform === 'win32' ? 'soffice.exe' : 'soffice',
  );
  try {
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, 'packaged LibreOffice executable');
    await chmod(executable, 0o755);
    process.env.WEBPILOT_SERVER_ROOT = root;
    process.env.LIBREOFFICE_PATH = '';

    assert.equal(await resolveLibreOfficeExecutable(), executable);
  } finally {
    if (previousRoot === undefined) delete process.env.WEBPILOT_SERVER_ROOT;
    else process.env.WEBPILOT_SERVER_ROOT = previousRoot;
    if (previousExecutable === undefined) delete process.env.LIBREOFFICE_PATH;
    else process.env.LIBREOFFICE_PATH = previousExecutable;
    await rm(root, { force: true, recursive: true });
  }
});
