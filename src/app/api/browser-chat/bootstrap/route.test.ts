import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';

test('bootstrap returns a bounded first page with a continuation cursor', async () => {
  const previousDataRoot = process.env.APP_DATA_DIR;
  const previousIdentitySecret = process.env.WEBPILOT_IDENTITY_HEADER_SECRET;
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'webpilot-bootstrap-'));
  let closeDatabase: () => void = () => undefined;
  process.env.APP_DATA_DIR = dataRoot;
  process.env.WEBPILOT_IDENTITY_HEADER_SECRET = 'bootstrap-test-secret';

  try {
    const records = await import('@/server/storage/sqlite-record-store');
    closeDatabase = (await import('@/server/storage/sqlite-database')).closeSqliteDatabase;
    const userId = 'bootstrap-user';
    for (let index = 0; index < 15; index += 1) {
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, 15 - index)).toISOString();
      const message = { id: `message-${index}`, role: 'user' as const, content: `message ${index}`, createdAt: timestamp };
      const session = {
        id: `session-${String(index).padStart(2, '0')}`,
        userId,
        title: `Session ${index}`,
        status: 'idle',
        busy: false,
        createdAt: timestamp,
        updatedAt: timestamp,
        messages: [message],
        steps: [],
        logs: [],
      };
      records.writeBrowserChatSessionRecord(session, session, [message], [], []);
    }

    const { GET } = await import('./route');
    const response = await GET(new NextRequest('http://localhost/api/browser-chat/bootstrap?sessionLimit=10&skillLimit=5', {
      headers: {
        'x-webpilot-identity-proof': 'bootstrap-test-secret',
        'x-webpilot-identity-user-id': userId,
        'x-webpilot-identity-username': 'Bootstrap Tester',
      },
    }));
    const body = await response.json() as {
      sessionPage?: { hasMore?: boolean; next?: { beforeId?: string; beforeUpdatedAt?: string } };
      sessions?: Array<{ id: string }>;
    };
    assert.equal(response.status, 200);
    assert.equal(body.sessions?.length, 10);
    assert.equal(body.sessionPage?.hasMore, true);
    assert.ok(body.sessionPage?.next?.beforeId);
    assert.ok(body.sessionPage?.next?.beforeUpdatedAt);
  } finally {
    closeDatabase();
    if (previousDataRoot === undefined) delete process.env.APP_DATA_DIR;
    else process.env.APP_DATA_DIR = previousDataRoot;
    if (previousIdentitySecret === undefined) delete process.env.WEBPILOT_IDENTITY_HEADER_SECRET;
    else process.env.WEBPILOT_IDENTITY_HEADER_SECRET = previousIdentitySecret;
    rmSync(dataRoot, { force: true, recursive: true });
  }
});
