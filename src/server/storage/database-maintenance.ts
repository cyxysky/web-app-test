import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { databaseDriver, getDatabase, queryDatabase } from '@/server/db/database';
import { structuredLog } from '@/server/observability/runtime-observability';
import { appDataRoot } from './paths';

const runtimeState = ((globalThis as typeof globalThis & {
  __databaseMaintenanceState?: { running?: Promise<void>; timer?: ReturnType<typeof setInterval> };
}).__databaseMaintenanceState ??= {});

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

async function pragmaNumber(name: 'freelist_count' | 'page_count' | 'page_size') {
  const rows = await queryDatabase<Record<string, number>>(`PRAGMA ${name}`);
  return Number(rows[0]?.[name] || 0);
}

export async function compactDatabaseIfNeeded() {
  if (databaseDriver() !== 'sqlite') return { compacted: false, driver: 'postgres' as const };
  await queryDatabase('PRAGMA wal_checkpoint(TRUNCATE)');
  const pageCountBefore = await pragmaNumber('page_count');
  const freePagesBefore = await pragmaNumber('freelist_count');
  const pageSize = await pragmaNumber('page_size');
  const freeRatioBefore = pageCountBefore ? freePagesBefore / pageCountBefore : 0;
  const shouldCompact = process.env.SQLITE_AUTO_COMPACT_ENABLED !== 'false'
    && freePagesBefore >= sqliteCompactionMinimumFreePages()
    && freeRatioBefore >= sqliteCompactionFreeRatio();
  if (shouldCompact) await queryDatabase('VACUUM');
  await queryDatabase('PRAGMA optimize');
  const pageCountAfter = await pragmaNumber('page_count');
  return {
    compacted: shouldCompact,
    driver: 'sqlite' as const,
    freePagesBefore,
    freeRatioBefore,
    pageCountAfter,
    pageCountBefore,
    reclaimedBytes: Math.max(0, pageCountBefore - pageCountAfter) * pageSize,
  };
}

export async function verifyDatabaseIntegrity() {
  if (databaseDriver() === 'postgres') {
    await queryDatabase('SELECT 1 AS ok');
    return true;
  }
  const rows = await queryDatabase<{ quick_check?: string }>('PRAGMA quick_check');
  const results = rows.map((row) => row.quick_check || '').filter(Boolean);
  if (results.length !== 1 || results[0].toLowerCase() !== 'ok') {
    throw new Error(`SQLite quick_check failed: ${results.join('; ') || 'unknown result'}`);
  }
  return true;
}

export async function createDatabaseBackup() {
  if (databaseDriver() !== 'sqlite') return undefined;
  await verifyDatabaseIntegrity();
  const directory = path.join(appDataRoot(), '.data', 'backups');
  await mkdir(directory, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const target = path.join(directory, `webpilot-${timestamp}-${process.pid}.db`);
  const dataSource = await getDatabase();
  const connection = (dataSource.driver as unknown as { databaseConnection?: { backup?: (target: string) => Promise<void> } }).databaseConnection;
  if (!connection?.backup) throw new Error('The active SQLite driver does not expose backup().');
  await connection.backup(target);
  const backups = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^webpilot-.*\.db$/i.test(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name));
  await Promise.all(backups.slice(backupRetentionCount()).map((entry) => rm(path.join(directory, entry.name), { force: true })));
  return target;
}

export function scheduleDatabaseMaintenance() {
  if (databaseDriver() !== 'sqlite' || process.env.SQLITE_MAINTENANCE_ENABLED === 'false' || runtimeState.timer) return;
  const run = () => {
    if (runtimeState.running) return;
    runtimeState.running = compactDatabaseIfNeeded()
      .then(() => createDatabaseBackup())
      .then(() => undefined)
      .catch((error) => structuredLog({ event: 'database.backup.failed', level: 'warn', error }))
      .finally(() => { runtimeState.running = undefined; });
  };
  const first = setTimeout(run, 5 * 60_000);
  first.unref?.();
  runtimeState.timer = setInterval(run, 24 * 60 * 60 * 1000);
  runtimeState.timer.unref?.();
}
