import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';

test('automation case history defaults to stable pages of ten', async () => {
  const previousDataRoot = process.env.APP_DATA_DIR;
  const previousIdentitySecret = process.env.WEBPILOT_IDENTITY_HEADER_SECRET;
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'webpilot-automation-history-'));
  let closeDatabase: () => void = () => undefined;
  process.env.APP_DATA_DIR = dataRoot;
  process.env.WEBPILOT_IDENTITY_HEADER_SECRET = 'automation-history-test-secret';

  try {
    const store = await import('@/server/storage/automation-store');
    closeDatabase = (await import('@/server/storage/sqlite-database')).closeSqliteDatabase;
    const userId = 'automation-history-user';
    for (let index = 0; index < 15; index += 1) {
      store.createAutomationCase({
        userId,
        title: `Case ${index}`,
        sourceSessionId: 'test',
        sourceMessageIds: [],
        targetUrl: 'https://example.com',
        instruction: `Run case ${index}`,
        operations: [],
      });
    }

    const { GET } = await import('./route');
    const headers = {
      'x-webpilot-identity-proof': 'automation-history-test-secret',
      'x-webpilot-identity-user-id': userId,
      'x-webpilot-identity-username': 'Automation History Tester',
    };
    const firstResponse = await GET(new NextRequest('http://localhost/api/automation/cases', { headers }));
    const first = await firstResponse.json() as {
      cases?: Array<{ id: string }>;
      page?: { hasMore?: boolean; next?: { beforeId?: string; beforeUpdatedAt?: string } };
    };
    assert.equal(firstResponse.status, 200);
    assert.equal(first.cases?.length, 10);
    assert.equal(first.page?.hasMore, true);
    assert.ok(first.page?.next?.beforeId);
    assert.ok(first.page?.next?.beforeUpdatedAt);

    const params = new URLSearchParams({
      beforeId: first.page!.next!.beforeId!,
      beforeUpdatedAt: first.page!.next!.beforeUpdatedAt!,
    });
    const secondResponse = await GET(new NextRequest(`http://localhost/api/automation/cases?${params}`, { headers }));
    const second = await secondResponse.json() as {
      cases?: Array<{ id: string }>;
      page?: { hasMore?: boolean };
    };
    assert.equal(second.cases?.length, 5);
    assert.equal(second.page?.hasMore, false);
    assert.equal(new Set([...(first.cases || []), ...(second.cases || [])].map((item) => item.id)).size, 15);
  } finally {
    closeDatabase();
    if (previousDataRoot === undefined) delete process.env.APP_DATA_DIR;
    else process.env.APP_DATA_DIR = previousDataRoot;
    if (previousIdentitySecret === undefined) delete process.env.WEBPILOT_IDENTITY_HEADER_SECRET;
    else process.env.WEBPILOT_IDENTITY_HEADER_SECRET = previousIdentitySecret;
    rmSync(dataRoot, { force: true, recursive: true });
  }
});
