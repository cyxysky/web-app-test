import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('browser chat history uses stable cursors and returns oldest-to-newest chunks', async () => {
  const previousDataRoot = process.env.APP_DATA_DIR;
  const dataRoot = mkdtempSync(join(tmpdir(), 'webpilot-history-'));
  process.env.APP_DATA_DIR = dataRoot;
  const databaseModule = await import('./sqlite-database');
  const records = await import('./sqlite-record-store');
  const history = await import('./browser-chat-history-store');
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  const at = (index: number) => new Date(base + index * 1000).toISOString();
  const snapshot = { id: 'chat_history', title: 'history', status: 'idle', createdAt: at(0), updatedAt: at(9) };
  try {
    records.writeBrowserChatSessionRecord(
      snapshot,
      snapshot,
      Array.from({ length: 6 }, (_, index) => ({ id: `m${index + 1}`, createdAt: at(index + 1), content: `${index + 1}` })),
      Array.from({ length: 6 }, (_, index) => ({ index: index + 1 })),
      Array.from({ length: 6 }, (_, index) => ({ id: `l${index + 1}`, time: at(index + 1), messageId: index < 3 ? 'a' : 'b' })),
    );
    const first = history.readBrowserChatMessagesPage<{ id: string }>(snapshot.id, { limit: 2 });
    const second = history.readBrowserChatMessagesPage<{ id: string }>(snapshot.id, { limit: 2, cursor: first.cursor });
    const third = history.readBrowserChatMessagesPage<{ id: string }>(snapshot.id, { limit: 2, cursor: second.cursor });
    assert.deepEqual(first.items.map((item) => item.id), ['m5', 'm6']);
    assert.deepEqual(second.items.map((item) => item.id), ['m3', 'm4']);
    assert.deepEqual(third.items.map((item) => item.id), ['m1', 'm2']);
    assert.equal(third.hasMore, false);
    const messageLogs = history.readBrowserChatLogsPage<{ id: string }>(snapshot.id, { messageId: 'b', limit: 10 });
    assert.deepEqual(messageLogs.items.map((item) => item.id), ['l4', 'l5', 'l6']);
    const database = databaseModule.getSqliteDatabase();
    const columns = database.prepare('PRAGMA table_info(browser_chat_log)').all() as Array<{ name?: string }>;
    assert.equal(columns.some((column) => column.name === 'message_id'), true);
    const plan = database.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id FROM browser_chat_log
      WHERE session_id = ? AND message_id = ?
      ORDER BY time DESC, id DESC
      LIMIT ?
    `).all(snapshot.id, 'b', 10) as Array<{ detail?: string }>;
    assert.match(plan.map((item) => item.detail || '').join('\n'), /browser_chat_log_session_message_time_idx/);
  } finally {
    databaseModule.getSqliteDatabase().close();
    if (previousDataRoot === undefined) delete process.env.APP_DATA_DIR;
    else process.env.APP_DATA_DIR = previousDataRoot;
    rmSync(dataRoot, { force: true, recursive: true });
  }
});
