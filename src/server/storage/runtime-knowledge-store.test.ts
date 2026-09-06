import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { closeDatabase } from '@/server/db/database';
import { store } from '@/server/db/store';
import { getPersonalMemoryItem, markPersonalMemoryItemsUsed, savePersonalMemoryItem, updatePersonalMemoryItem } from '@/server/ai/personal-memory';
import { readRuntimeKnowledgeRevisions, readRuntimeSkillCatalog } from './runtime-knowledge-store';
import { readBrowserChatSessionRecord, writeBrowserChatSessionDelta } from './database-record-store';
import { normalizeBrowserChatModelContext } from '@/server/ai/agents/browser-chat-model-context';
import { knowledgeDigest } from '@/server/ai/agents/runtime-knowledge-context';

test('database catalog and invalidation preserve isolation, content timestamps, full rules/resources and persisted Skill state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'webpilot-knowledge-'));
  const databasePath = join(directory, 'knowledge.db');
  const previous = { driver: process.env.DATABASE_DRIVER, path: process.env.SQLITE_DATABASE_PATH };
  process.env.DATABASE_DRIVER = 'sqlite';
  process.env.SQLITE_DATABASE_PATH = databasePath;
  try {
    const skill = await store.upsertSkill({ userId: 'owner', title: 'Invoice approval', description: 'Validate invoices',
      triggerPhrases: ['approve invoice'], status: 'ready', content: { details: 'critical-rule\n'.repeat(4000),
        resources: [{ name: 'Examples', content: 'original reference\n'.repeat(100) }] } });
    await store.upsertSkill({ userId: 'other', title: 'Private rule', description: '', triggerPhrases: [], status: 'ready', content: { details: 'private' } });
    const catalog = await readRuntimeSkillCatalog('owner');
    assert.deepEqual(catalog.map((entry) => entry.id), [skill.id]);
    assert.equal(catalog[0].content.details, '');
    assert.deepEqual(catalog[0].triggerPhrases, ['approve invoice']);
    assert.deepEqual((await store.getSkill(skill.id, 'owner'))?.content, skill.content);
    assert.ok(skill.content.details.length > 30000);
    const memory = await savePersonalMemoryItem({ userId: 'owner', scope: 'global', type: 'preference', key: 'report format',
      value: 'XLSX', recall: 'always', evidence: ['From now on use XLSX'], durability: 'explicit_preference' });
    const revision = await readRuntimeKnowledgeRevisions('owner', 'example.com');
    await markPersonalMemoryItemsUsed([memory.id]);
    const used = await getPersonalMemoryItem(memory.id, 'owner');
    assert.equal(used?.updatedAt, memory.updatedAt);
    assert.equal(used?.useCount, 1);
    assert.deepEqual(used?.evidence, ['From now on use XLSX']);
    assert.equal((await readRuntimeKnowledgeRevisions('owner', 'example.com')).memories, revision.memories);
    await updatePersonalMemoryItem(memory.id, { status: 'disabled' }, 'owner');
    assert.notEqual((await readRuntimeKnowledgeRevisions('owner', 'example.com')).memories, revision.memories);
    await store.upsertSkill({ ...skill, status: 'disabled' });
    assert.notEqual((await readRuntimeKnowledgeRevisions('owner', 'example.com')).skills, revision.skills);
    const timestamp = new Date().toISOString();
    const modelContext = normalizeBrowserChatModelContext({ version: 2, records: {}, history: [], active: [],
      knowledge: { version: 1, scopeId: 'session', skills: [{ id: skill.id, version: skill.version, digest: knowledgeDigest(skill.content), loadedAt: timestamp }] },
      branches: { child: { recordIds: [], active: [], history: [], knowledge: { version: 1, scopeId: 'session:child', skills: [] } } } });
    await writeBrowserChatSessionDelta({ id: 'session', userId: 'owner', title: 'test', status: 'idle', createdAt: timestamp,
      updatedAt: timestamp, messages: [], steps: [], logs: [], modelContext }, { id: 'session' }, {});
    await closeDatabase();
    const restored = await readBrowserChatSessionRecord<{ modelContext: typeof modelContext; messages: unknown[] }>('session');
    assert.deepEqual(restored?.modelContext.knowledge, modelContext.knowledge);
    assert.deepEqual(restored?.modelContext.branches?.child.knowledge, modelContext.branches?.child.knowledge);
  } finally {
    await closeDatabase();
    if (previous.driver === undefined) delete process.env.DATABASE_DRIVER; else process.env.DATABASE_DRIVER = previous.driver;
    if (previous.path === undefined) delete process.env.SQLITE_DATABASE_PATH; else process.env.SQLITE_DATABASE_PATH = previous.path;
    for (const suffix of ['', '-wal', '-shm']) rmSync(databasePath + suffix, { force: true });
    rmdirSync(directory);
  }
});
