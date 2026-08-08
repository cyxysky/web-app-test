import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { GET } from './[...path]/route';

test('streams byte ranges and hides another user upload', async () => {
  const previousDataRoot = process.env.APP_DATA_DIR;
  const previousIdentitySecret = process.env.WEBPILOT_IDENTITY_HEADER_SECRET;
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'webpilot-artifact-'));
  process.env.APP_DATA_DIR = dataRoot;
  process.env.WEBPILOT_IDENTITY_HEADER_SECRET = 'artifact-test-secret';
  const fileDirectory = path.join(dataRoot, 'artifacts', 'uploads', 'user-a');
  mkdirSync(fileDirectory, { recursive: true });
  writeFileSync(path.join(fileDirectory, 'note.txt'), 'abcdef');

  const requestFor = (userId: string, extraHeaders: Record<string, string> = {}) => new NextRequest(
    'http://localhost/api/artifacts/uploads/user-a/note.txt',
    {
      headers: {
        'x-webpilot-identity-proof': 'artifact-test-secret',
        'x-webpilot-identity-user-id': userId,
        'x-webpilot-identity-username': 'Artifact Tester',
        ...extraHeaders,
      },
    },
  );
  const context = { params: Promise.resolve({ path: ['uploads', 'user-a', 'note.txt'] }) };
  try {
    const partial = await GET(requestFor('user-a', { range: 'bytes=1-3' }), context);
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), 'bytes 1-3/6');
    assert.equal(await partial.text(), 'bcd');
    assert.ok(partial.headers.get('x-request-id'));

    const hidden = await GET(requestFor('user-b'), context);
    assert.equal(hidden.status, 404);
    assert.equal((await hidden.json() as { code: string }).code, 'not_found');
  } finally {
    if (previousDataRoot === undefined) delete process.env.APP_DATA_DIR;
    else process.env.APP_DATA_DIR = previousDataRoot;
    if (previousIdentitySecret === undefined) delete process.env.WEBPILOT_IDENTITY_HEADER_SECRET;
    else process.env.WEBPILOT_IDENTITY_HEADER_SECRET = previousIdentitySecret;
    rmSync(dataRoot, { force: true, recursive: true });
  }
});
