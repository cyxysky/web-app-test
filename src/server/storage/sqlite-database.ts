import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { appDataRoot } from '@/server/storage/paths';

const databaseFileName = 'webpilot.db';

type DatabaseRuntimeState = {
  database?: DatabaseSync;
  databasePath?: string;
  schemaVersion?: number;
};

const currentSchemaVersion = 24;
const defaultApplicationUserId = '1';
const obsoleteRuntimeEnvKeys = new Set([
  'AI_PROMPT_INCLUDE_FULL_TIMELINE',
  'RUN_MEMORY_TIMELINE_LIMIT',
  'RUN_MEMORY_SUMMARY_MAX_CHARS',
  'DATABASE_URL',
  'AI_TARGET_MODE_CUSTOM_PROMPT',
  'AI_TARGET_MODE_CUSTOM_PROMPT_ENABLED',
]);

const runtimeState = ((globalThis as typeof globalThis & {
  __webPilotDatabaseRuntimeState?: DatabaseRuntimeState;
}).__webPilotDatabaseRuntimeState ??= {});

function normalizedMigratedUserId(value: unknown) {
  const userId = typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';
  return !userId || userId === 'default' ? defaultApplicationUserId : userId;
}

function jsonRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {} as Record<string, unknown>;
  return value as Record<string, unknown>;
}

function textValue(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

type PersonalMemoryMigrationRow = {
  id: string;
  user_id: string;
  scope: string;
  domain: string;
  type: string;
  memory_key: string;
  status: string;
  record_json: string;
  created_at: string;
  updated_at: string;
};

function normalizePersonalMemoryMigrationItem(value: unknown, fallback: Partial<PersonalMemoryMigrationRow> = {}) {
  const record = jsonRecord(value);
  const id = textValue(record.id) || textValue(fallback.id);
  const key = textValue(record.key) || textValue(fallback.memory_key);
  if (!id || !key) return undefined;
  const timestamp = new Date().toISOString();
  const normalizedRecord = {
    ...record,
    id,
    userId: normalizedMigratedUserId(record.userId ?? fallback.user_id),
  };
  return {
    id,
    user_id: normalizedRecord.userId,
    scope: textValue(record.scope) || textValue(fallback.scope) || 'global',
    domain: textValue(record.domain) || textValue(fallback.domain),
    type: textValue(record.type) || textValue(fallback.type) || 'domain_fact',
    memory_key: key,
    status: textValue(record.status) || textValue(fallback.status) || 'active',
    record_json: JSON.stringify(normalizedRecord),
    created_at: textValue(record.createdAt) || textValue(fallback.created_at) || timestamp,
    updated_at: textValue(record.updatedAt) || textValue(fallback.updated_at) || timestamp,
  } satisfies PersonalMemoryMigrationRow;
}

function migratePersonalMemory(database: DatabaseSync) {
  const byIdentity = new Map<string, PersonalMemoryMigrationRow>();
  const remember = (item: PersonalMemoryMigrationRow | undefined) => {
    if (!item) return;
    const identity = [item.user_id, item.scope, item.domain, item.type, item.memory_key.toLowerCase()].join('\u0001');
    const previous = byIdentity.get(identity);
    if (!previous || item.updated_at >= previous.updated_at) byIdentity.set(identity, item);
  };

  const rows = database.prepare(`
    SELECT id, user_id, scope, domain, type, memory_key, status, record_json, created_at, updated_at
    FROM personal_memory_item
  `).all() as PersonalMemoryMigrationRow[];
  for (const row of rows) {
    let record: unknown;
    try {
      record = JSON.parse(row.record_json);
    } catch {
      record = {};
    }
    remember(normalizePersonalMemoryMigrationItem(record, row));
  }

  const legacyPath = path.join(appDataRoot(), '.data', 'personal-memory', 'items.json');
  if (existsSync(legacyPath)) {
    try {
      const parsed = JSON.parse(readFileSync(legacyPath, 'utf8')) as { items?: unknown[] };
      for (const item of Array.isArray(parsed.items) ? parsed.items : []) {
        remember(normalizePersonalMemoryMigrationItem(item));
      }
    } catch {
      // Leave an unreadable legacy file in place for manual recovery.
      return false;
    }
  }

  database.exec('DELETE FROM personal_memory_item');
  const insert = database.prepare(`
    INSERT INTO personal_memory_item (
      id, user_id, scope, domain, type, memory_key, status, record_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of byIdentity.values()) {
    insert.run(
      item.id,
      item.user_id,
      item.scope,
      item.domain,
      item.type,
      item.memory_key,
      item.status,
      item.record_json,
      item.created_at,
      item.updated_at,
    );
  }
  return legacyPath;
}

function migrateBrowserChatUsers(database: DatabaseSync) {
  const rows = database.prepare(`
    SELECT id, user_id, snapshot_json, summary_json
    FROM browser_chat_session
    WHERE user_id IS NULL OR TRIM(user_id) = '' OR user_id = 'default'
  `).all() as Array<{ id: string; user_id?: string | null; snapshot_json: string; summary_json: string }>;
  const update = database.prepare(`
    UPDATE browser_chat_session
    SET user_id = ?, snapshot_json = ?, summary_json = ?
    WHERE id = ?
  `);
  for (const row of rows) {
    const updateJson = (raw: string) => {
      try {
        return JSON.stringify({ ...jsonRecord(JSON.parse(raw)), userId: defaultApplicationUserId });
      } catch {
        return raw;
      }
    };
    update.run(defaultApplicationUserId, updateJson(row.snapshot_json), updateJson(row.summary_json), row.id);
  }
}

function removeObsoleteRuntimeSettings(database: DatabaseSync) {
  const row = database.prepare('SELECT runtime_env_json FROM app_config WHERE id = 1').get() as { runtime_env_json?: string } | undefined;
  if (!row?.runtime_env_json) return;
  try {
    const items = JSON.parse(row.runtime_env_json) as Array<{ key?: unknown }>;
    if (!Array.isArray(items)) return;
    const filtered = items.filter((item) => !obsoleteRuntimeEnvKeys.has(textValue(item?.key)));
    if (filtered.length === items.length) return;
    database.prepare('UPDATE app_config SET runtime_env_json = ?, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(filtered), new Date().toISOString());
  } catch {
    // Preserve malformed settings for explicit recovery instead of overwriting them.
  }
}

function applyVersionThreeMigration(database: DatabaseSync) {
  const applied = database.prepare('SELECT 1 FROM schema_migration WHERE version = 3').get();
  const cleanupLegacyFiles = () => {
    const legacyMemoryPath = path.join(appDataRoot(), '.data', 'personal-memory', 'items.json');
    if (existsSync(legacyMemoryPath)) unlinkSync(legacyMemoryPath);
    const legacyConfigPath = path.join(appDataRoot(), '.data', 'app-config.json');
    if (existsSync(legacyConfigPath)) unlinkSync(legacyConfigPath);
  };
  if (applied) {
    cleanupLegacyFiles();
    return;
  }
  let legacyMemoryPath: string | false | undefined;
  database.exec('BEGIN IMMEDIATE');
  try {
    legacyMemoryPath = migratePersonalMemory(database);
    if (legacyMemoryPath === false) throw new Error('Legacy personal memory file is not valid JSON.');
    migrateBrowserChatUsers(database);
    removeObsoleteRuntimeSettings(database);
    database.prepare(`
      INSERT INTO schema_migration (version, name, applied_at)
      VALUES (3, 'default-user-and-settings-cleanup', ?)
    `).run(new Date().toISOString());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  cleanupLegacyFiles();
}

function applyVersionFourMigration(database: DatabaseSync) {
  const applied = database.prepare('SELECT 1 FROM schema_migration WHERE version = 4').get();
  if (applied) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    const rows = database.prepare(`
      SELECT id, snapshot_json, summary_json FROM browser_chat_session
    `).all() as Array<{ id: string; snapshot_json: string; summary_json: string }>;
    const stripTargetRun = (raw: string) => {
      try {
        const record = jsonRecord(JSON.parse(raw));
        delete record.targetRun;
        return JSON.stringify(record);
      } catch {
        return raw;
      }
    };
    const update = database.prepare(`
      UPDATE browser_chat_session SET snapshot_json = ?, summary_json = ? WHERE id = ?
    `);
    for (const row of rows) {
      update.run(stripTargetRun(row.snapshot_json), stripTargetRun(row.summary_json), row.id);
    }
    removeObsoleteRuntimeSettings(database);
    database.prepare(`
      INSERT INTO schema_migration (version, name, applied_at)
      VALUES (4, 'remove-target-workflow-state', ?)
    `).run(new Date().toISOString());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function applyVersionFiveMigration(database: DatabaseSync) {
  const applied = database.prepare('SELECT 1 FROM schema_migration WHERE version = 5').get();
  if (applied) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    const columns = database.prepare('PRAGMA table_info(skill)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'user_id')) {
      database.exec("ALTER TABLE skill ADD COLUMN user_id TEXT NOT NULL DEFAULT '0'");
    }
    database.exec("UPDATE skill SET user_id = '0' WHERE user_id IS NULL OR TRIM(user_id) = ''");
    database.exec('CREATE INDEX IF NOT EXISTS skill_user_updated_at_idx ON skill(user_id, updated_at DESC)');
    database.prepare(`
      INSERT INTO schema_migration (version, name, applied_at)
      VALUES (5, 'skills-per-user', ?)
    `).run(new Date().toISOString());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function applyVersionSixMigration(database: DatabaseSync) {
  const applied = database.prepare('SELECT 1 FROM schema_migration WHERE version = 6').get();
  if (applied) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    const columns = database.prepare('PRAGMA table_info(browser_chat_session)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'revision')) {
      database.exec('ALTER TABLE browser_chat_session ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
    }
    database.prepare(`
      INSERT INTO schema_migration (version, name, applied_at)
      VALUES (6, 'browser-chat-incremental-storage', ?)
    `).run(new Date().toISOString());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function applyVersionSevenMigration(database: DatabaseSync) {
  const applied = database.prepare('SELECT 1 FROM schema_migration WHERE version = 7').get();
  if (applied) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`
      DROP TABLE IF EXISTS test_run;
      DROP TABLE IF EXISTS run_schedule;
      DROP TABLE IF EXISTS test_case;
      DROP TABLE IF EXISTS test_group;
    `);
    database.prepare(`
      INSERT INTO schema_migration (version, name, applied_at)
      VALUES (7, 'remove-test-case-runtime', ?)
    `).run(new Date().toISOString());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function applyVersionEightMigration(database: DatabaseSync) {
  const applied = database.prepare('SELECT 1 FROM schema_migration WHERE version = 8').get();
  if (applied) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const table of ['skill', 'personal_memory_item', 'login_account']) {
      const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'shared')) {
        database.exec(`ALTER TABLE ${table} ADD COLUMN shared INTEGER NOT NULL DEFAULT 0`);
      }
    }
    database.exec('CREATE INDEX IF NOT EXISTS skill_shared_updated_at_idx ON skill(shared, updated_at DESC)');
    database.exec('CREATE INDEX IF NOT EXISTS personal_memory_shared_updated_at_idx ON personal_memory_item(shared, updated_at DESC)');
    database.exec('CREATE INDEX IF NOT EXISTS login_account_shared_domain_idx ON login_account(shared, domain, updated_at DESC)');
    database.prepare(`
      INSERT INTO schema_migration (version, name, applied_at)
      VALUES (8, 'cross-user-shared-resources', ?)
    `).run(new Date().toISOString());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function applyVersionNineMigration(database: DatabaseSync) {
  const applied = database.prepare('SELECT 1 FROM schema_migration WHERE version = 9').get();
  if (applied) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS automation_case (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        target_url TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS automation_case_user_updated_at_idx
        ON automation_case(user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS automation_case_source_session_idx
        ON automation_case(source_session_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS automation_schedule (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        title TEXT NOT NULL,
        recurrence TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run_at TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (case_id) REFERENCES automation_case(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS automation_schedule_user_updated_at_idx
        ON automation_schedule(user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS automation_schedule_case_idx
        ON automation_schedule(case_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS automation_schedule_due_idx
        ON automation_schedule(enabled, next_run_at ASC);

      CREATE TABLE IF NOT EXISTS automation_run (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        schedule_id TEXT,
        occurrence_key TEXT,
        trigger TEXT NOT NULL,
        status TEXT NOT NULL,
        lease_expires_at TEXT,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (case_id) REFERENCES automation_case(id) ON DELETE CASCADE,
        FOREIGN KEY (schedule_id) REFERENCES automation_schedule(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS automation_run_user_created_at_idx
        ON automation_run(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS automation_run_case_created_at_idx
        ON automation_run(case_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS automation_run_schedule_created_at_idx
        ON automation_run(schedule_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS automation_run_status_created_at_idx
        ON automation_run(status, created_at ASC);
      CREATE INDEX IF NOT EXISTS automation_run_lease_idx
        ON automation_run(status, lease_expires_at ASC);
      CREATE UNIQUE INDEX IF NOT EXISTS automation_run_occurrence_idx
        ON automation_run(schedule_id, occurrence_key)
        WHERE schedule_id IS NOT NULL AND occurrence_key IS NOT NULL;
    `);
    database.prepare(`
      INSERT INTO schema_migration (version, name, applied_at)
      VALUES (9, 'automation-cases-runs-and-schedules', ?)
    `).run(new Date().toISOString());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function applyVersionThirteenMigration(database: DatabaseSync) {
  const applied = database.prepare('SELECT 1 FROM schema_migration WHERE version = 13').get();
  if (applied) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`
      CREATE INDEX IF NOT EXISTS browser_chat_session_user_updated_id_idx
        ON browser_chat_session(user_id, updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS browser_chat_message_session_time_id_idx
        ON browser_chat_message(session_id, time DESC, id DESC);
      CREATE INDEX IF NOT EXISTS browser_chat_log_session_time_id_idx
        ON browser_chat_log(session_id, time DESC, id DESC);
      CREATE INDEX IF NOT EXISTS personal_memory_user_status_updated_idx
        ON personal_memory_item(user_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS personal_memory_user_domain_updated_idx
        ON personal_memory_item(user_id, domain, updated_at DESC);
    `);
    database.prepare(`
      INSERT INTO schema_migration (version, name, applied_at)
      VALUES (13, 'scalable-resource-queries', ?)
    `).run(new Date().toISOString());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function applyVersionFourteenMigration(database: DatabaseSync) {
  const applied = database.prepare('SELECT 1 FROM schema_migration WHERE version = 14').get();
  if (applied) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`
      CREATE INDEX IF NOT EXISTS personal_memory_identity_idx
        ON personal_memory_item(user_id, scope, domain, type, memory_key COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS skill_user_updated_idx
        ON skill(user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS skill_shared_updated_idx
        ON skill(shared, updated_at DESC);
    `);
    database.prepare(`
      INSERT INTO schema_migration (version, name, applied_at)
      VALUES (14, 'resource-identity-lookups', ?)
    `).run(new Date().toISOString());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function applyVersionFifteenMigration(database: DatabaseSync) {
  const applied = database.prepare('SELECT 1 FROM schema_migration WHERE version = 15').get();
  if (applied) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS api_idempotency (
        user_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        status_code INTEGER,
        response_json TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, scope, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS api_idempotency_expires_idx
        ON api_idempotency(expires_at);
    `);
    database.prepare(`
      INSERT INTO schema_migration (version, name, applied_at)
      VALUES (15, 'api-idempotency', ?)
    `).run(new Date().toISOString());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function applyVersionSixteenMigration(database: DatabaseSync) {
  const applied = database.prepare('SELECT 1 FROM schema_migration WHERE version = 16').get();
  if (applied) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    const columns = database.prepare('PRAGMA table_info(browser_chat_log)').all() as Array<{ name?: string }>;
    if (!columns.some((column) => column.name === 'message_id')) {
      database.exec('ALTER TABLE browser_chat_log ADD COLUMN message_id TEXT');
    }
    database.exec(`
      UPDATE browser_chat_log
      SET message_id = json_extract(record_json, '$.messageId')
      WHERE message_id IS NULL AND json_extract(record_json, '$.messageId') IS NOT NULL;
      CREATE INDEX IF NOT EXISTS browser_chat_log_session_message_time_idx
        ON browser_chat_log(session_id, message_id, time DESC, id DESC);
      CREATE INDEX IF NOT EXISTS skill_user_updated_id_idx
        ON skill(user_id, updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS skill_shared_updated_id_idx
        ON skill(shared, updated_at DESC, id DESC);
    `);
    database.prepare(`
      INSERT INTO schema_migration (version, name, applied_at)
      VALUES (16, 'indexed-chat-logs-and-skill-pagination', ?)
    `).run(new Date().toISOString());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function applyVersionSeventeenMigration(database: DatabaseSync) {
  const applied = database.prepare('SELECT 1 FROM schema_migration WHERE version = 17').get();
  if (applied) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`
      DELETE FROM api_idempotency
      WHERE scope = 'browser-chat.message';
      UPDATE browser_chat_log
      SET record_json = json_remove(record_json, '$.details')
      WHERE json_extract(record_json, '$.phase') = 'ai:runtime:request'
        AND json_extract(record_json, '$.details') IS NOT NULL;
    `);
    database.prepare(`
      INSERT INTO schema_migration (version, name, applied_at)
      VALUES (17, 'compact-browser-chat-runtime-storage', ?)
    `).run(new Date().toISOString());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function applyVersionEighteenMigration(database: DatabaseSync) {
  const applied = database.prepare('SELECT 1 FROM schema_migration WHERE version = 18').get();
  if (applied) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS browser_domain_cookie (
        user_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        cookie_envelope TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, domain)
      );
      CREATE INDEX IF NOT EXISTS browser_domain_cookie_updated_idx
        ON browser_domain_cookie(updated_at DESC);
    `);
    database.prepare(`
      INSERT INTO schema_migration (version, name, applied_at)
      VALUES (18, 'browser-domain-cookie-vault', ?)
    `).run(new Date().toISOString());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function applyVersionNineteenMigration(database: DatabaseSync) {
  const applied = database.prepare('SELECT 1 FROM schema_migration WHERE version = 19').get();
  if (applied) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`
      DROP TABLE IF EXISTS browser_chat_realtime_outbox;
      UPDATE browser_chat_log
      SET record_json = json_remove(record_json, '$.details')
      WHERE json_valid(record_json)
        AND json_extract(record_json, '$.phase') IN (
        'ai:runtime:request',
        'ai:runtime:response',
        'ai:runtime:object'
      )
        AND json_extract(record_json, '$.details') IS NOT NULL;
    `);
    database.prepare(`
      INSERT INTO schema_migration (version, name, applied_at)
      VALUES (19, 'remove-browser-chat-realtime-outbox-and-unbounded-ai-logs', ?)
    `).run(new Date().toISOString());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function applyVersionTwentyMigration(database: DatabaseSync) {
  const applied = database.prepare('SELECT 1 FROM schema_migration WHERE version = 20').get();
  if (applied) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS user_onboarding_state (
        user_id TEXT PRIMARY KEY,
        tutorial_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        completed_steps_json TEXT NOT NULL DEFAULT '[]',
        dismissed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    database.prepare(`
      INSERT INTO schema_migration (version, name, applied_at)
      VALUES (20, 'user-onboarding-state', ?)
    `).run(new Date().toISOString());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function applyVersionTwentyOneMigration(database: DatabaseSync) {
  const applied = database.prepare('SELECT 1 FROM schema_migration WHERE version = 21').get();
  if (applied) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS ai_operations_chat_archive (
        session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        record_json TEXT NOT NULL,
        first_event_at TEXT NOT NULL,
        last_event_at TEXT NOT NULL,
        archived_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ai_operations_chat_archive_user_last_event_idx
        ON ai_operations_chat_archive(user_id, last_event_at DESC);
      CREATE INDEX IF NOT EXISTS ai_operations_chat_archive_last_event_idx
        ON ai_operations_chat_archive(last_event_at DESC);
    `);
    database.prepare(`
      INSERT INTO schema_migration (version, name, applied_at)
      VALUES (21, 'durable-ai-operations-chat-archive', ?)
    `).run(new Date().toISOString());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function applyVersionTwentyTwoMigration(database: DatabaseSync) {
  const applied = database.prepare('SELECT 1 FROM schema_migration WHERE version = 22').get();
  if (applied) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`
      UPDATE automation_case
      SET record_json = json_remove(record_json, '$.mode')
      WHERE json_type(record_json, '$.mode') IS NOT NULL;
      UPDATE browser_chat_session
      SET snapshot_json = json_remove(snapshot_json, '$.mode'),
          summary_json = json_remove(summary_json, '$.mode')
      WHERE json_type(snapshot_json, '$.mode') IS NOT NULL
         OR json_type(summary_json, '$.mode') IS NOT NULL;
    `);
    const columns = database.prepare('PRAGMA table_info(automation_case)').all() as Array<{ name?: string }>;
    if (columns.some((column) => column.name === 'mode')) {
      database.exec('ALTER TABLE automation_case DROP COLUMN mode');
    }
    database.prepare(`
      INSERT INTO schema_migration (version, name, applied_at)
      VALUES (22, 'remove-browser-operation-mode', ?)
    `).run(new Date().toISOString());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function applyVersionTwentyThreeMigration(database: DatabaseSync) {
  const applied = database.prepare('SELECT 1 FROM schema_migration WHERE version = 23').get();
  if (applied) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS browser_code_runtime_state (
        session_id TEXT NOT NULL,
        namespace TEXT NOT NULL DEFAULT 'conversation',
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        PRIMARY KEY (session_id, namespace, key)
      );
      CREATE INDEX IF NOT EXISTS browser_code_runtime_state_expiry_idx
        ON browser_code_runtime_state(expires_at)
        WHERE expires_at IS NOT NULL;
    `);
    database.prepare(`
      INSERT INTO schema_migration (version, name, applied_at)
      VALUES (23, 'browser-code-runtime-state', ?)
    `).run(new Date().toISOString());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function applyVersionTwentyFourMigration(database: DatabaseSync) {
  const applied = database.prepare('SELECT 1 FROM schema_migration WHERE version = 24').get();
  if (applied) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS browser_chat_defect (
        session_id TEXT NOT NULL,
        id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        record_json TEXT NOT NULL,
        PRIMARY KEY (session_id, id),
        FOREIGN KEY (session_id) REFERENCES browser_chat_session(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS browser_chat_defect_session_created_idx
        ON browser_chat_defect(session_id, created_at DESC);
    `);
    database.prepare(`
      INSERT INTO schema_migration (version, name, applied_at)
      VALUES (24, 'browser-chat-defect-report', ?)
    `).run(new Date().toISOString());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function sqliteDatabasePath() {
  return path.join(appDataRoot(), '.data', databaseFileName);
}

function initializeSchema(database: DatabaseSync) {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 1000;
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

    CREATE TABLE IF NOT EXISTS skill (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      shared INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      record_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS skill_updated_at_idx ON skill(updated_at DESC);

    CREATE TABLE IF NOT EXISTS browser_chat_session (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      snapshot_json TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS browser_chat_session_user_id_idx ON browser_chat_session(user_id);
    CREATE INDEX IF NOT EXISTS browser_chat_session_updated_at_idx ON browser_chat_session(updated_at DESC);

    CREATE TABLE IF NOT EXISTS browser_chat_message (
      session_id TEXT NOT NULL,
      id TEXT NOT NULL,
      time TEXT NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (session_id, id),
      FOREIGN KEY (session_id) REFERENCES browser_chat_session(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS browser_chat_message_session_time_idx ON browser_chat_message(session_id, time);

    CREATE TABLE IF NOT EXISTS browser_chat_step (
      session_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (session_id, step_index),
      FOREIGN KEY (session_id) REFERENCES browser_chat_session(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS browser_chat_log (
      session_id TEXT NOT NULL,
      id TEXT NOT NULL,
      time TEXT NOT NULL,
      message_id TEXT,
      record_json TEXT NOT NULL,
      PRIMARY KEY (session_id, id),
      FOREIGN KEY (session_id) REFERENCES browser_chat_session(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS browser_chat_log_session_time_idx ON browser_chat_log(session_id, time);

    CREATE TABLE IF NOT EXISTS ai_operations_chat_archive (
      session_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      first_event_at TEXT NOT NULL,
      last_event_at TEXT NOT NULL,
      archived_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ai_operations_chat_archive_user_last_event_idx
      ON ai_operations_chat_archive(user_id, last_event_at DESC);
    CREATE INDEX IF NOT EXISTS ai_operations_chat_archive_last_event_idx
      ON ai_operations_chat_archive(last_event_at DESC);

    CREATE TABLE IF NOT EXISTS personal_memory_item (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      shared INTEGER NOT NULL DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS user_onboarding_state (
      user_id TEXT PRIMARY KEY,
      tutorial_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      completed_steps_json TEXT NOT NULL DEFAULT '[]',
      dismissed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS login_account (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      shared INTEGER NOT NULL DEFAULT 0,
      domain TEXT NOT NULL,
      username TEXT NOT NULL,
      label TEXT NOT NULL,
      login_url TEXT NOT NULL,
      status TEXT NOT NULL,
      password_envelope TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT,
      use_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(user_id, domain, username)
    );
    CREATE INDEX IF NOT EXISTS login_account_user_domain_idx
      ON login_account(user_id, domain);
    CREATE INDEX IF NOT EXISTS login_account_updated_at_idx
      ON login_account(updated_at DESC);

    CREATE TABLE IF NOT EXISTS electron_state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS websocket_ticket (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      session_id TEXT,
      scope TEXT NOT NULL,
      origin TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      consumed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS websocket_ticket_token_idx
      ON websocket_ticket(token_hash, expires_at);

    CREATE TABLE IF NOT EXISTS browser_code_runtime_state (
      session_id TEXT NOT NULL,
      namespace TEXT NOT NULL DEFAULT 'conversation',
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      PRIMARY KEY (session_id, namespace, key)
    );
    CREATE INDEX IF NOT EXISTS browser_code_runtime_state_expiry_idx
      ON browser_code_runtime_state(expires_at)
      WHERE expires_at IS NOT NULL;

    CREATE TABLE IF NOT EXISTS browser_chat_defect (
      session_id TEXT NOT NULL,
      id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (session_id, id),
      FOREIGN KEY (session_id) REFERENCES browser_chat_session(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS browser_chat_defect_session_created_idx
      ON browser_chat_defect(session_id, created_at DESC);
  `);

  database.prepare(`
    DELETE FROM websocket_ticket
    WHERE expires_at <= ? OR consumed_at IS NOT NULL
  `).run(new Date().toISOString());

  database.prepare(`
    INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
    VALUES (1, 'sqlite-runtime', ?)
  `).run(new Date().toISOString());
  database.prepare(`
    INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
    VALUES (2, 'login-account-vault', ?)
  `).run(new Date().toISOString());
  applyVersionThreeMigration(database);
  applyVersionFourMigration(database);
  applyVersionFiveMigration(database);
  applyVersionSixMigration(database);
  applyVersionSevenMigration(database);
  applyVersionEightMigration(database);
  applyVersionNineMigration(database);
  database.prepare('DELETE FROM schema_migration WHERE version = 11').run();
  database.prepare(`
    INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
    VALUES (12, 'mounted-identity-and-websocket-tickets', ?)
  `).run(new Date().toISOString());
  applyVersionThirteenMigration(database);
  applyVersionFourteenMigration(database);
  applyVersionFifteenMigration(database);
  applyVersionSixteenMigration(database);
  applyVersionSeventeenMigration(database);
  applyVersionEighteenMigration(database);
  applyVersionNineteenMigration(database);
  applyVersionTwentyMigration(database);
  applyVersionTwentyOneMigration(database);
  applyVersionTwentyTwoMigration(database);
  applyVersionTwentyThreeMigration(database);
  applyVersionTwentyFourMigration(database);
}

export function getSqliteDatabase() {
  const databasePath = sqliteDatabasePath();
  if (runtimeState.database && runtimeState.databasePath === databasePath) {
    if ((runtimeState.schemaVersion ?? 0) < currentSchemaVersion) {
      initializeSchema(runtimeState.database);
      runtimeState.schemaVersion = Math.max(runtimeState.schemaVersion ?? 0, currentSchemaVersion);
    }
    return runtimeState.database;
  }
  runtimeState.database?.close();
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
  });
  initializeSchema(database);
  runtimeState.database = database;
  runtimeState.databasePath = databasePath;
  runtimeState.schemaVersion = currentSchemaVersion;
  return database;
}

export function closeSqliteDatabase() {
  runtimeState.database?.close();
  runtimeState.database = undefined;
  runtimeState.databasePath = undefined;
  runtimeState.schemaVersion = undefined;
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
