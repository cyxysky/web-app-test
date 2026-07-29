import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('browser conversation rows hydrate incrementally and removed rows are pruned', async () => {
  const previousDataRoot = process.env.APP_DATA_DIR;
  const dataRoot = mkdtempSync(join(tmpdir(), 'webpilot-persistence-'));
  process.env.APP_DATA_DIR = dataRoot;

  const databaseModule = await import('./sqlite-database');
  const recordStore = await import('./sqlite-record-store');
  const time = new Date().toISOString();
  const snapshot = {
    id: 'session-smoke',
    userId: '17',
    title: 'smoke',
    status: 'idle',
    createdAt: time,
    updatedAt: time,
    messages: [],
    steps: [],
    logs: [],
  };

  try {
    recordStore.writeBrowserChatSessionRecord(
      snapshot,
      { id: snapshot.id },
      [
        { id: 'm1', createdAt: time, content: 'one' },
        { id: 'm2', createdAt: time, content: 'two' },
      ],
      [{ index: 1, value: 'one' }, { index: 2, value: 'two' }],
      [{ id: 'l1', time, value: 'one' }, { id: 'l2', time, value: 'two' }],
    );
    const first = recordStore.readBrowserChatSessionRecord<{
      messages: Array<{ content: string }>;
      steps: Array<{ value: string }>;
      logs: Array<{ value: string }>;
    }>(snapshot.id);
    assert.equal(first?.messages.length, 2);
    assert.equal(first?.steps.length, 2);
    assert.equal(first?.logs.length, 2);

    recordStore.writeBrowserChatSessionRecord(
      { ...snapshot, updatedAt: new Date().toISOString() },
      { id: snapshot.id },
      [{ id: 'm2', createdAt: time, content: 'updated' }],
      [{ index: 2, value: 'updated' }],
      [{ id: 'l2', time, value: 'updated' }],
    );
    const second = recordStore.readBrowserChatSessionRecord<{
      messages: Array<{ content: string }>;
      steps: Array<{ value: string }>;
      logs: Array<{ value: string }>;
    }>(snapshot.id);
    assert.deepEqual(second?.messages.map((item) => item.content), ['updated']);
    assert.deepEqual(second?.steps.map((item) => item.value), ['updated']);
    assert.deepEqual(second?.logs.map((item) => item.value), ['updated']);

    recordStore.writeBrowserChatSessionDelta(
      { ...snapshot, updatedAt: new Date().toISOString() },
      { id: snapshot.id },
      {
        messages: [{ id: 'm3', createdAt: time, content: 'delta' }],
        steps: [{ index: 3, value: 'delta' }],
        logs: [{ id: 'l3', time, value: 'delta' }],
      },
    );
    const deltaAdded = recordStore.readBrowserChatSessionRecord<{
      messages: Array<{ content: string }>;
      steps: Array<{ value: string }>;
      logs: Array<{ value: string }>;
    }>(snapshot.id);
    assert.deepEqual(deltaAdded?.messages.map((item) => item.content), ['updated', 'delta']);
    assert.deepEqual(deltaAdded?.steps.map((item) => item.value), ['updated', 'delta']);
    assert.deepEqual(deltaAdded?.logs.map((item) => item.value), ['updated', 'delta']);

    recordStore.writeBrowserChatSessionDelta(
      { ...snapshot, updatedAt: new Date().toISOString() },
      { id: snapshot.id },
      { removedMessageIds: ['m2'], removedStepIndexes: [2], removedLogIds: ['l2'] },
    );
    const deltaRemoved = recordStore.readBrowserChatSessionRecord<{
      messages: Array<{ content: string }>;
      steps: Array<{ value: string }>;
      logs: Array<{ value: string }>;
    }>(snapshot.id);
    assert.deepEqual(deltaRemoved?.messages.map((item) => item.content), ['delta']);
    assert.deepEqual(deltaRemoved?.steps.map((item) => item.value), ['delta']);
    assert.deepEqual(deltaRemoved?.logs.map((item) => item.value), ['delta']);

    const retiredTables = databaseModule.getSqliteDatabase().prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('test_group', 'test_case', 'run_schedule', 'test_run')
    `).all();
    assert.deepEqual(retiredTables, []);
  } finally {
    databaseModule.getSqliteDatabase().close();
    if (previousDataRoot === undefined) delete process.env.APP_DATA_DIR;
    else process.env.APP_DATA_DIR = previousDataRoot;
    rmSync(dataRoot, { force: true, recursive: true });
  }
});
