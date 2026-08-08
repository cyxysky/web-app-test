import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { POST } from './route';
import { getSqliteDatabase } from '@/server/storage/sqlite-database';

test('streams a raw upload into the authenticated user artifact directory', async () => {
  const previousDataRoot = process.env.APP_DATA_DIR;
  const previousIdentitySecret = process.env.WEBPILOT_IDENTITY_HEADER_SECRET;
  const previousMaxBytes = process.env.WEBPILOT_UPLOAD_MAX_BYTES;
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'webpilot-upload-'));
  process.env.APP_DATA_DIR = dataRoot;
  process.env.WEBPILOT_IDENTITY_HEADER_SECRET = 'upload-test-secret';
  process.env.WEBPILOT_UPLOAD_MAX_BYTES = '1024';

  const identityHeaders = {
    'x-webpilot-identity-proof': 'upload-test-secret',
    'x-webpilot-identity-user-id': 'upload-user',
    'x-webpilot-identity-username': 'Upload Tester',
  };
  try {
    const content = Buffer.from('streamed upload');
    const response = await POST(new NextRequest('http://localhost/api/uploads', {
      method: 'POST',
      headers: {
        ...identityHeaders,
        'content-length': String(content.length),
        'content-type': 'text/plain',
        'x-webpilot-file-name': encodeURIComponent('notes.txt'),
        'x-webpilot-upload': 'raw',
      },
      body: content,
    }));
    assert.equal(response.status, 200);
    const payload = await response.json() as { fileId: string; filePath?: string; path: string; size: number };
    assert.equal(payload.path.startsWith('uploads/upload-user/'), true);
    assert.equal(payload.filePath, undefined);
    assert.equal(payload.size, content.length);
    assert.equal(
      readFileSync(path.join(dataRoot, 'artifacts', 'uploads', 'upload-user', payload.fileId), 'utf8'),
      'streamed upload',
    );

    const oversized = await POST(new NextRequest('http://localhost/api/uploads', {
      method: 'POST',
      headers: {
        ...identityHeaders,
        'content-length': '1025',
        'content-type': 'application/octet-stream',
        'x-webpilot-file-name': encodeURIComponent('too-large.bin'),
        'x-webpilot-upload': 'raw',
      },
      body: Buffer.alloc(1025),
    }));
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json() as { code: string }).code, 'payload_too_large');
  } finally {
    getSqliteDatabase().close();
    if (previousDataRoot === undefined) delete process.env.APP_DATA_DIR;
    else process.env.APP_DATA_DIR = previousDataRoot;
    if (previousIdentitySecret === undefined) delete process.env.WEBPILOT_IDENTITY_HEADER_SECRET;
    else process.env.WEBPILOT_IDENTITY_HEADER_SECRET = previousIdentitySecret;
    if (previousMaxBytes === undefined) delete process.env.WEBPILOT_UPLOAD_MAX_BYTES;
    else process.env.WEBPILOT_UPLOAD_MAX_BYTES = previousMaxBytes;
    rmSync(dataRoot, { force: true, recursive: true });
  }
});
