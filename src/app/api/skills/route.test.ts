import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';

test('skills API provides stable cursor pagination and server-side search', async () => {
  const previousDataRoot = process.env.APP_DATA_DIR;
  const previousIdentitySecret = process.env.WEBPILOT_IDENTITY_HEADER_SECRET;
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'webpilot-skills-page-'));
  process.env.APP_DATA_DIR = dataRoot;
  process.env.WEBPILOT_IDENTITY_HEADER_SECRET = 'skills-page-test-secret';
  let closeDatabase: () => void = () => undefined;
  try {
    const { store } = await import('@/server/db/store');
    closeDatabase = (await import('@/server/storage/sqlite-database')).closeSqliteDatabase;
    const userId = 'skills-page-user';
    for (let index = 0; index < 7; index += 1) {
      store.upsertSkill({
        content: { details: `Instructions ${index}` },
        description: index === 3 ? 'unique server query' : `Description ${index}`,
        status: 'ready',
        title: `Skill ${index}`,
        userId,
      });
    }
    const headers = {
      'x-webpilot-identity-proof': 'skills-page-test-secret',
      'x-webpilot-identity-user-id': userId,
      'x-webpilot-identity-username': 'Skills Tester',
    };
    const { GET } = await import('./route');
    const firstResponse = await GET(new NextRequest('http://localhost/api/skills?limit=3', { headers }));
    const first = await firstResponse.json() as {
      page?: { hasMore?: boolean; next?: { beforeId?: string; beforeUpdatedAt?: string } };
      skills?: Array<{ id: string }>;
    };
    assert.equal(first.skills?.length, 3);
    assert.equal(first.page?.hasMore, true);
    assert.ok(first.page?.next?.beforeId);
    const cursor = new URLSearchParams({
      limit: '3',
      beforeId: first.page?.next?.beforeId || '',
      beforeUpdatedAt: first.page?.next?.beforeUpdatedAt || '',
    });
    const secondResponse = await GET(new NextRequest(`http://localhost/api/skills?${cursor}`, { headers }));
    const second = await secondResponse.json() as { skills?: Array<{ id: string }> };
    assert.equal(second.skills?.length, 3);
    assert.equal(second.skills?.some((skill) => first.skills?.some((item) => item.id === skill.id)), false);
    const searchResponse = await GET(new NextRequest('http://localhost/api/skills?limit=10&q=unique%20server%20query', { headers }));
    const search = await searchResponse.json() as { skills?: Array<{ description?: string }> };
    assert.equal(search.skills?.length, 1);
    assert.equal(search.skills?.[0]?.description, 'unique server query');
  } finally {
    closeDatabase();
    if (previousDataRoot === undefined) delete process.env.APP_DATA_DIR;
    else process.env.APP_DATA_DIR = previousDataRoot;
    if (previousIdentitySecret === undefined) delete process.env.WEBPILOT_IDENTITY_HEADER_SECRET;
    else process.env.WEBPILOT_IDENTITY_HEADER_SECRET = previousIdentitySecret;
    rmSync(dataRoot, { force: true, recursive: true });
  }
});
