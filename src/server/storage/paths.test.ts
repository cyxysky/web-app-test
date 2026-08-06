import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appDataRoot, artifactsRoot } from './paths';

test('runtime storage defaults to a dedicated runtime directory', () => {
  const originalCwd = process.cwd();
  const originalAppDataDir = process.env.APP_DATA_DIR;
  const originalArtifactsDir = process.env.ARTIFACTS_DIR;
  const root = mkdtempSync(path.join(os.tmpdir(), 'webpilot-storage-paths-'));

  try {
    process.chdir(root);
    delete process.env.APP_DATA_DIR;
    delete process.env.ARTIFACTS_DIR;
    assert.equal(appDataRoot(), path.join(root, 'runtime'));
    assert.equal(artifactsRoot(), path.join(root, 'runtime', 'artifacts'));
  } finally {
    process.chdir(originalCwd);
    if (originalAppDataDir === undefined) delete process.env.APP_DATA_DIR;
    else process.env.APP_DATA_DIR = originalAppDataDir;
    if (originalArtifactsDir === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = originalArtifactsDir;
    rmSync(root, { recursive: true, force: true });
  }
});
