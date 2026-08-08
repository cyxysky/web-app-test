import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { enforceUserUploadQuota, maintainUserUploads, userUploadUsage } from './upload-artifact-lifecycle';

test('upload lifecycle preserves referenced files and removes disposable files first', async () => {
  const previousRoot = process.env.ARTIFACTS_DIR;
  const previousBytes = process.env.UPLOAD_MAX_BYTES_PER_USER;
  const previousRetention = process.env.UPLOAD_RETENTION_DAYS;
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-uploads-'));
  const userId = 'upload-user';
  const directory = path.join(root, 'uploads', userId);
  const referenced = path.join(directory, 'referenced.bin');
  const disposable = path.join(directory, 'disposable.bin');
  const newest = path.join(directory, 'newest.bin');
  process.env.ARTIFACTS_DIR = root;
  process.env.UPLOAD_MAX_BYTES_PER_USER = '8';
  process.env.UPLOAD_RETENTION_DAYS = '1';

  try {
    await mkdir(directory, { recursive: true });
    await writeFile(referenced, Buffer.alloc(4));
    await writeFile(disposable, Buffer.alloc(4));
    await writeFile(newest, Buffer.alloc(4));
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(referenced, old, old);
    await utimes(disposable, old, old);
    const retained = new Set([`uploads/${userId}/referenced.bin`]);

    const quota = await enforceUserUploadQuota(userId, retained, { protectedPath: newest });
    assert.equal(quota.overQuota, false);
    assert.equal(quota.removed, 1);
    await access(referenced);
    await access(newest);
    await assert.rejects(access(disposable));

    await maintainUserUploads(retained);
    await access(referenced);
    const usage = await userUploadUsage(userId);
    assert.equal(usage.files, 2);
    assert.equal(usage.bytes, 8);
  } finally {
    if (previousRoot === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previousRoot;
    if (previousBytes === undefined) delete process.env.UPLOAD_MAX_BYTES_PER_USER;
    else process.env.UPLOAD_MAX_BYTES_PER_USER = previousBytes;
    if (previousRetention === undefined) delete process.env.UPLOAD_RETENTION_DAYS;
    else process.env.UPLOAD_RETENTION_DAYS = previousRetention;
    await rm(root, { force: true, recursive: true });
  }
});
