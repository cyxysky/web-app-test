import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('browserCode conversation state persists across database reopen and isolates sessions', async () => {
  const previousDataRoot = process.env.APP_DATA_DIR;
  const dataRoot = mkdtempSync(join(tmpdir(), 'webpilot-browser-code-state-'));
  process.env.APP_DATA_DIR = dataRoot;
  const databaseModule = await import('./sqlite-database');
  const stateStore = await import('./browser-code-runtime-state');

  try {
    const created = stateStore.executeBrowserCodeRuntimeStateOperation('chat-state-a', {
      action: 'set',
      input: { key: 'task.progress', value: { issueId: '30789', step: 2 }, expectedRevision: 0 },
    }) as { revision: number };
    assert.equal(created.revision, 1);

    databaseModule.closeSqliteDatabase();
    const restored = stateStore.executeBrowserCodeRuntimeStateOperation('chat-state-a', {
      action: 'get',
      input: { key: 'task.progress' },
    }) as { found: boolean; revision: number; value: unknown };
    assert.equal(restored.found, true);
    assert.equal(restored.revision, 1);
    assert.deepEqual(restored.value, { issueId: '30789', step: 2 });

    const isolated = stateStore.executeBrowserCodeRuntimeStateOperation('chat-state-b', {
      action: 'get',
      input: { key: 'task.progress' },
    }) as { found: boolean };
    assert.equal(isolated.found, false);

    assert.throws(() => stateStore.executeBrowserCodeRuntimeStateOperation('chat-state-a', {
      action: 'set',
      input: { key: 'task.progress', value: { step: 3 }, expectedRevision: 0 },
    }), /revision conflict.*expected 0, current 1/i);

    const updated = stateStore.executeBrowserCodeRuntimeStateOperation('chat-state-a', {
      action: 'set',
      input: { key: 'task.progress', value: { issueId: '30789', step: 3 }, expectedRevision: 1 },
    }) as { revision: number };
    assert.equal(updated.revision, 2);

    stateStore.executeBrowserCodeRuntimeStateOperation('chat-state-a', {
      action: 'set',
      input: { key: 'task.note', value: 'ready' },
    });
    const listed = stateStore.executeBrowserCodeRuntimeStateOperation('chat-state-a', {
      action: 'list',
      input: { prefix: 'task.' },
    }) as { count: number; items: Array<{ key: string }> };
    assert.equal(listed.count, 2);
    assert.deepEqual(listed.items.map((item) => item.key), ['task.note', 'task.progress']);

    const cleared = stateStore.executeBrowserCodeRuntimeStateOperation('chat-state-a', {
      action: 'clear',
      input: { prefix: 'task.' },
    }) as { deleted: number };
    assert.equal(cleared.deleted, 2);
  } finally {
    databaseModule.closeSqliteDatabase();
    if (previousDataRoot === undefined) delete process.env.APP_DATA_DIR;
    else process.env.APP_DATA_DIR = previousDataRoot;
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

