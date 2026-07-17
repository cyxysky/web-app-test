import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { appDataRoot } from '@/server/storage/paths';

const databaseFileName = 'webpilot.db';

type DatabaseRuntimeState = {
  database?: DatabaseSync;
  databasePath?: string;
};

const runtimeState = ((globalThis as typeof globalThis & {
  __webPilotDatabaseRuntimeState?: DatabaseRuntimeState;
}).__webPilotDatabaseRuntimeState ??= {});

export function sqliteDatabasePath() {
  return path.join(appDataRoot(), '.data', databaseFileName);
}

function initializeSchema(database: DatabaseSync) {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS schema_migration (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      runtime_env_json TEXT NOT NULL DEFAULT '[]',
      model_config_json TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runtime_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS test_group (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      name TEXT NOT NULL,
      record_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS test_group_parent_id_idx ON test_group(parent_id);

    CREATE TABLE IF NOT EXISTS test_case (
      id TEXT PRIMARY KEY,
      group_id TEXT,
      title TEXT NOT NULL,
      target_url TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      record_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS test_case_group_id_idx ON test_case(group_id);
    CREATE INDEX IF NOT EXISTS test_case_updated_at_idx ON test_case(updated_at DESC);

    CREATE TABLE IF NOT EXISTS skill (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      record_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS skill_updated_at_idx ON skill(updated_at DESC);

    CREATE TABLE IF NOT EXISTS run_schedule (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS run_schedule_enabled_idx ON run_schedule(enabled);

    CREATE TABLE IF NOT EXISTS test_run (
      id TEXT PRIMARY KEY,
      test_case_id TEXT NOT NULL,
      status TEXT NOT NULL,
      record_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT
    );
    CREATE INDEX IF NOT EXISTS test_run_test_case_id_idx ON test_run(test_case_id);
    CREATE INDEX IF NOT EXISTS test_run_status_idx ON test_run(status);
    CREATE INDEX IF NOT EXISTS test_run_created_at_idx ON test_run(created_at DESC);

    CREATE TABLE IF NOT EXISTS browser_chat_session (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS browser_chat_session_user_id_idx ON browser_chat_session(user_id);
    CREATE INDEX IF NOT EXISTS browser_chat_session_updated_at_idx ON browser_chat_session(updated_at DESC);

    CREATE TABLE IF NOT EXISTS browser_chat_log (
      session_id TEXT NOT NULL,
      id TEXT NOT NULL,
      time TEXT NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (session_id, id),
      FOREIGN KEY (session_id) REFERENCES browser_chat_session(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS browser_chat_log_session_time_idx ON browser_chat_log(session_id, time);

    CREATE TABLE IF NOT EXISTS personal_memory_item (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      domain TEXT NOT NULL,
      type TEXT NOT NULL,
      memory_key TEXT NOT NULL,
      status TEXT NOT NULL,
      record_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS personal_memory_identity_idx
      ON personal_memory_item(user_id, scope, domain, type, memory_key);
    CREATE INDEX IF NOT EXISTS personal_memory_updated_at_idx ON personal_memory_item(updated_at DESC);

    CREATE TABLE IF NOT EXISTS electron_state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  database.prepare(`
    INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
    VALUES (1, 'sqlite-runtime', ?)
  `).run(new Date().toISOString());
}

export function getSqliteDatabase() {
  const databasePath = sqliteDatabasePath();
  if (runtimeState.database && runtimeState.databasePath === databasePath) return runtimeState.database;
  runtimeState.database?.close();
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
  });
  initializeSchema(database);
  runtimeState.database = database;
  runtimeState.databasePath = databasePath;
  return database;
}

export function runSqliteTransaction<T>(operation: (database: DatabaseSync) => T): T {
  const database = getSqliteDatabase();
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation(database);
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function parseSqliteJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
