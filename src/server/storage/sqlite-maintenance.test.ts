import assert from 'node:assert/strict';
import { access, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('sqlite maintenance verifies integrity and creates a consistent backup', async () => {
  const previousDataRoot = process.env.APP_DATA_DIR;
  const dataRoot = mkdtempSync(join(tmpdir(), 'webpilot-sqlite-backup-'));
  process.env.APP_DATA_DIR = dataRoot;
  const databaseModule = await import('./sqlite-database');
  const maintenance = await import('./sqlite-maintenance');
  try {
    databaseModule.getSqliteDatabase();
    assert.equal(maintenance.verifySqliteIntegrity(), true);
    const compaction = maintenance.compactSqliteDatabaseIfNeeded();
    assert.equal(typeof compaction.compacted, 'boolean');
    assert.ok(compaction.pageCountAfter > 0);
    const backup = await maintenance.createSqliteBackup();
    await new Promise<void>((resolve, reject) => access(backup, (error) => error ? reject(error) : resolve()));
  } finally {
    databaseModule.getSqliteDatabase().close();
    if (previousDataRoot === undefined) delete process.env.APP_DATA_DIR;
    else process.env.APP_DATA_DIR = previousDataRoot;
    rmSync(dataRoot, { force: true, recursive: true });
  }
});
