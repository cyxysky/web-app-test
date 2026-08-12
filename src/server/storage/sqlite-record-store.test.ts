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
  const writeQueue = await import('./sqlite-write-queue');
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
      { id: snapshot.id, userId: snapshot.userId },
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
      { id: snapshot.id, userId: snapshot.userId },
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
      { id: snapshot.id, userId: snapshot.userId },
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
      { id: snapshot.id, userId: snapshot.userId },
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

    const outboxTable = databaseModule.getSqliteDatabase().prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'browser_chat_realtime_outbox'
    `).get();
    assert.equal(outboxTable, undefined);

    const memoryBase = {
      shared: false,
      scope: 'global',
      domain: '',
      type: 'preference',
      status: 'active',
      createdAt: time,
      updatedAt: time,
    };
    recordStore.writePersonalMemoryRecords([{
      ...memoryBase,
      id: 'memory-owner',
      userId: 'owner',
      key: 'theme',
      value: 'dark',
    }, {
      ...memoryBase,
      id: 'memory-other',
      userId: 'other',
      key: 'language',
      value: 'Chinese',
    }]);
    recordStore.writePersonalMemoryRecord({
      ...memoryBase,
      id: 'memory-owner',
      userId: 'owner',
      key: 'theme',
      value: 'light',
      updatedAt: new Date(Date.parse(time) + 1_000).toISOString(),
    });
    const ownerMemories = recordStore.readPersonalMemoryRecords<{ id: string; value: string }>({
      userId: 'owner',
      includeShared: false,
    });
    assert.deepEqual(ownerMemories.map((item) => item.id), ['memory-owner']);
    assert.equal(ownerMemories[0]?.value, 'light');
    assert.equal(
      recordStore.readPersonalMemoryRecords<{ id: string; value: string }>({ ids: ['memory-other'] })[0]?.value,
      'Chinese',
    );

    for (const [id, userId, updatedAt] of [
      ['session-page-a', '17', '2026-08-08T00:00:01.000Z'],
      ['session-page-b', '17', '2026-08-08T00:00:02.000Z'],
      ['session-page-other', '18', '2026-08-08T00:00:03.000Z'],
    ] as const) {
      recordStore.writeBrowserChatSessionRecord(
        { ...snapshot, id, userId, updatedAt },
        { id, userId, updatedAt },
        [],
        [],
        [],
      );
    }
    const userPage = recordStore.readBrowserChatSessionSummaries<{ id: string; userId: string }>({ userId: '17', limit: 2 });
    assert.equal(userPage.length, 2);
    assert.equal(userPage.every((item) => item.userId === '17'), true);
    assert.equal(userPage.some((item) => item.id === 'session-page-other'), false);

    await recordStore.writeBrowserChatSessionDeltaQueued(
      { ...snapshot, id: 'session-worker', updatedAt: new Date().toISOString() },
      { id: 'session-worker', userId: snapshot.userId },
      {
        messages: [{ id: 'worker-message', createdAt: time, content: 'written off the request thread' }],
        steps: [{ index: 1, value: 'worker-step' }],
        logs: [{ id: 'worker-log', time, value: 'worker-log' }],
      },
    );
    const workerWritten = recordStore.readBrowserChatSessionRecord<{
      messages: Array<{ content: string }>;
      steps: Array<{ value: string }>;
      logs: Array<{ value: string }>;
    }>('session-worker');
    assert.equal(workerWritten?.messages[0]?.content, 'written off the request thread');
    assert.equal(workerWritten?.steps[0]?.value, 'worker-step');
    assert.equal(workerWritten?.logs[0]?.value, 'worker-log');

    const retiredTables = databaseModule.getSqliteDatabase().prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('test_group', 'test_case', 'run_schedule', 'test_run')
    `).all();
    assert.deepEqual(retiredTables, []);
  } finally {
    await writeQueue.closeSqliteWriteQueue();
    databaseModule.closeSqliteDatabase();
    if (previousDataRoot === undefined) delete process.env.APP_DATA_DIR;
    else process.env.APP_DATA_DIR = previousDataRoot;
    rmSync(dataRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  }
});
