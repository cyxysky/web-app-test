import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { backup } from 'node:sqlite';
import { appDataRoot } from './paths';
import { getSqliteDatabase } from './sqlite-database';
import { structuredLog } from '@/server/observability/runtime-observability';

const runtimeState = ((globalThis as typeof globalThis & {
  __sqliteMaintenanceState?: { running?: Promise<void>; timer?: ReturnType<typeof setInterval> };
}).__sqliteMaintenanceState ??= {});

function backupRetentionCount() {
  const value = Number(process.env.SQLITE_BACKUP_RETENTION_COUNT || 7);
  return Number.isFinite(value) ? Math.max(1, Math.min(30, Math.floor(value))) : 7;
}

function sqliteCompactionFreeRatio() {
  const value = Number(process.env.SQLITE_COMPACTION_FREE_RATIO || 0.3);
  return Number.isFinite(value) ? Math.max(0.1, Math.min(0.9, value)) : 0.3;
}

function sqliteCompactionMinimumFreePages() {
  const value = Number(process.env.SQLITE_COMPACTION_MIN_FREE_PAGES || 1024);
  return Number.isFinite(value) ? Math.max(128, Math.floor(value)) : 1024;
}

function pragmaNumber(name: 'freelist_count' | 'page_count' | 'page_size') {
  const row = getSqliteDatabase().prepare(`PRAGMA ${name}`).get() as Record<string, number> | undefined;
  return Number(row?.[name] || 0);
}

export function compactSqliteDatabaseIfNeeded() {
  const database = getSqliteDatabase();
  database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all();
  const pageCountBefore = pragmaNumber('page_count');
  const freePagesBefore = pragmaNumber('freelist_count');
  const pageSize = pragmaNumber('page_size');
  const freeRatioBefore = pageCountBefore ? freePagesBefore / pageCountBefore : 0;
  const shouldCompact = process.env.SQLITE_AUTO_COMPACT_ENABLED !== 'false'
    && freePagesBefore >= sqliteCompactionMinimumFreePages()
    && freeRatioBefore >= sqliteCompactionFreeRatio();
  if (shouldCompact) database.exec('VACUUM');
  database.exec('PRAGMA optimize');
  const pageCountAfter = pragmaNumber('page_count');
  return {
    compacted: shouldCompact,
    freePagesBefore,
    freeRatioBefore,
    pageCountAfter,
    pageCountBefore,
    reclaimedBytes: Math.max(0, pageCountBefore - pageCountAfter) * pageSize,
  };
}

export function verifySqliteIntegrity() {
  const rows = getSqliteDatabase().prepare('PRAGMA quick_check').all() as Array<{ quick_check?: string }>;
  const results = rows.map((row) => row.quick_check || '').filter(Boolean);
  if (results.length !== 1 || results[0].toLowerCase() !== 'ok') {
    throw new Error(`SQLite quick_check failed: ${results.join('; ') || 'unknown result'}`);
  }
  return true;
}

export async function createSqliteBackup() {
  verifySqliteIntegrity();
  const directory = path.join(appDataRoot(), '.data', 'backups');
  await mkdir(directory, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const target = path.join(directory, `webpilot-${timestamp}-${process.pid}.db`);
  await backup(getSqliteDatabase(), target);
  const backups = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^webpilot-.*\.db$/i.test(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name));
  await Promise.all(backups.slice(backupRetentionCount()).map((entry) => rm(path.join(directory, entry.name), { force: true })));
  return target;
}

export function scheduleSqliteMaintenance() {
  if (process.env.SQLITE_MAINTENANCE_ENABLED === 'false' || runtimeState.timer) return;
  const run = () => {
    if (runtimeState.running) return;
    runtimeState.running = Promise.resolve()
      .then(() => compactSqliteDatabaseIfNeeded())
      .then(() => createSqliteBackup())
      .then(() => undefined)
      .catch((error) => structuredLog({ event: 'sqlite.backup.failed', level: 'warn', error }))
      .finally(() => { runtimeState.running = undefined; });
  };
  const first = setTimeout(run, 5 * 60_000);
  first.unref?.();
  runtimeState.timer = setInterval(run, 24 * 60 * 60 * 1000);
  runtimeState.timer.unref?.();
}
