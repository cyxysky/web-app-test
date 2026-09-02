import 'reflect-metadata';

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  DataSource,
  type DataSourceOptions,
  type EntityManager,
  type QueryRunner,
} from 'typeorm';
import { appDataRoot } from '@/server/storage/paths';
import { InitialBackendSchema1788307200000 } from './migrations/1788307200000-initial-backend-schema';

export type DatabaseDriver = 'postgres' | 'sqlite';
export type DatabaseExecutor = DataSource | EntityManager | QueryRunner;

type DatabaseRuntimeState = {
  dataSource?: DataSource;
  initialization?: Promise<DataSource>;
  identity?: string;
  sqliteTransactionQueue?: Promise<void>;
};

const databaseFileName = 'webpilot.db';
const runtimeState = ((globalThis as typeof globalThis & {
  __webPilotTypeOrmRuntimeState?: DatabaseRuntimeState;
}).__webPilotTypeOrmRuntimeState ??= {});

function configuredDriver(): DatabaseDriver {
  const configured = String(process.env.DATABASE_DRIVER || '').trim().toLowerCase();
  if (!configured) return /^postgres(?:ql)?:\/\//i.test(String(process.env.DATABASE_URL || '').trim())
    ? 'postgres'
    : 'sqlite';
  if (configured === 'postgres' || configured === 'postgresql' || configured === 'pg') return 'postgres';
  if (configured === 'sqlite') return 'sqlite';
  throw new Error(`Unsupported DATABASE_DRIVER: ${configured}. Use sqlite or postgres.`);
}

export function databaseDriver(): DatabaseDriver {
  return configuredDriver();
}

export function sqliteDatabasePath() {
  return path.resolve(
    String(process.env.SQLITE_DATABASE_PATH || '').trim()
      || path.join(appDataRoot(), '.data', databaseFileName),
  );
}

function booleanEnv(name: string, fallback = false) {
  const value = String(process.env[name] || '').trim().toLowerCase();
  if (!value) return fallback;
  return value === '1' || value === 'true' || value === 'yes' || value === 'on' || value === 'require';
}

function positiveInteger(value: unknown, fallback: number, maximum: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(maximum, Math.floor(parsed)) : fallback;
}

function dataSourceIdentity() {
  const driver = configuredDriver();
  if (driver === 'sqlite') return `sqlite:${sqliteDatabasePath()}`;
  const url = String(process.env.DATABASE_URL || '').trim();
  if (!url) throw new Error('DATABASE_URL is required when DATABASE_DRIVER=postgres.');
  return `postgres:${url}`;
}

function dataSourceOptions(): DataSourceOptions {
  const driver = configuredDriver();
  const common = {
    synchronize: false,
    migrationsRun: true,
    migrationsTableName: 'typeorm_migration',
    migrations: [InitialBackendSchema1788307200000],
    logging: booleanEnv('DATABASE_LOGGING'),
  };
  if (driver === 'postgres') {
    const url = String(process.env.DATABASE_URL || '').trim();
    if (!url) throw new Error('DATABASE_URL is required when DATABASE_DRIVER=postgres.');
    return {
      ...common,
      type: 'postgres',
      url,
      poolSize: positiveInteger(process.env.DATABASE_POOL_SIZE, 10, 100),
      ssl: booleanEnv('DATABASE_SSL') ? { rejectUnauthorized: booleanEnv('DATABASE_SSL_REJECT_UNAUTHORIZED', true) } : false,
      applicationName: 'webpilot',
    };
  }
  return {
    ...common,
    type: 'better-sqlite3',
    database: sqliteDatabasePath(),
    enableWAL: true,
    timeout: positiveInteger(process.env.DATABASE_BUSY_TIMEOUT_MS, 5_000, 120_000),
    prepareDatabase(database) {
      database.pragma('foreign_keys = ON');
      database.pragma('journal_mode = WAL');
      database.pragma('synchronous = NORMAL');
      database.pragma('wal_autocheckpoint = 1000');
    },
  };
}

export async function getDatabase() {
  const identity = dataSourceIdentity();
  if (runtimeState.dataSource?.isInitialized && runtimeState.identity === identity) return runtimeState.dataSource;
  if (runtimeState.initialization && runtimeState.identity === identity) return runtimeState.initialization;

  if (runtimeState.dataSource?.isInitialized) await runtimeState.dataSource.destroy();
  runtimeState.dataSource = undefined;
  runtimeState.identity = identity;
  if (configuredDriver() === 'sqlite') await mkdir(path.dirname(sqliteDatabasePath()), { recursive: true });

  const dataSource = new DataSource(dataSourceOptions());
  runtimeState.initialization = dataSource.initialize().then(async (initialized) => {
    runtimeState.dataSource = initialized;
    await deleteExpiredWebSocketTickets(initialized);
    return initialized;
  }).finally(() => {
    runtimeState.initialization = undefined;
  });
  return runtimeState.initialization;
}

async function deleteExpiredWebSocketTickets(executor: DatabaseExecutor) {
  await executeDatabase(
    'DELETE FROM websocket_ticket WHERE expires_at <= ? OR consumed_at IS NOT NULL',
    [new Date().toISOString()],
    executor,
  );
}

export async function closeDatabase() {
  const dataSource = runtimeState.dataSource;
  runtimeState.dataSource = undefined;
  runtimeState.initialization = undefined;
  runtimeState.identity = undefined;
  runtimeState.sqliteTransactionQueue = undefined;
  if (dataSource?.isInitialized) await dataSource.destroy();
}

function postgresSql(sql: string) {
  let parameterIndex = 0;
  let quoted: 'single' | 'double' | undefined;
  let output = '';
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (character === "'" && quoted !== 'double') {
      if (quoted === 'single' && sql[index + 1] === "'") {
        output += "''";
        index += 1;
        continue;
      }
      quoted = quoted === 'single' ? undefined : 'single';
    } else if (character === '"' && quoted !== 'single') {
      quoted = quoted === 'double' ? undefined : 'double';
    }
    if (character === '?' && !quoted) output += `$${++parameterIndex}`;
    else output += character;
  }
  return output;
}

function sqlForDriver(sql: string) {
  return configuredDriver() === 'postgres' ? postgresSql(sql) : sql;
}

async function resolveExecutor(executor?: DatabaseExecutor) {
  return executor || await getDatabase();
}

export async function queryDatabase<T = Record<string, unknown>>(
  sql: string,
  parameters: unknown[] = [],
  executor?: DatabaseExecutor,
): Promise<T[]> {
  const target = await resolveExecutor(executor);
  return target.query(sqlForDriver(sql), parameters) as Promise<T[]>;
}

export async function queryDatabaseOne<T = Record<string, unknown>>(
  sql: string,
  parameters: unknown[] = [],
  executor?: DatabaseExecutor,
): Promise<T | undefined> {
  return (await queryDatabase<T>(sql, parameters, executor))[0];
}

export async function executeDatabase(
  sql: string,
  parameters: unknown[] = [],
  executor?: DatabaseExecutor,
) {
  const target = await resolveExecutor(executor);
  return target.query(sqlForDriver(sql), parameters);
}

export async function runDatabaseTransaction<T>(
  operation: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const database = await getDatabase();
  if (configuredDriver() !== 'sqlite') return database.transaction(operation);

  // better-sqlite3 exposes one synchronous connection. TypeORM otherwise lets
  // concurrent requests issue BEGIN on that same connection, which produces
  // "cannot start a transaction within a transaction" and can also make the
  // losing request roll back the winning request. Serialize SQLite
  // transactions while preserving normal pooled concurrency for PostgreSQL.
  const previous = runtimeState.sqliteTransactionQueue || Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  runtimeState.sqliteTransactionQueue = previous.then(() => current, () => current);
  await previous.catch(() => undefined);
  try {
    return await database.transaction(operation);
  } finally {
    releaseCurrent();
  }
}

export function parseDatabaseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
