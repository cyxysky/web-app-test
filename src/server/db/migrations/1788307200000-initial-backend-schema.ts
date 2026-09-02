import type { MigrationInterface, QueryRunner } from 'typeorm';

const statements = [
  `CREATE TABLE IF NOT EXISTS app_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    runtime_env_json TEXT NOT NULL DEFAULT '[]',
    model_config_json TEXT,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS runtime_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS skill (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    shared BOOLEAN NOT NULL DEFAULT FALSE,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    record_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS skill_updated_at_idx ON skill(updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS skill_user_updated_idx ON skill(user_id, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS skill_shared_updated_idx ON skill(shared, updated_at DESC)',
  `CREATE TABLE IF NOT EXISTS browser_chat_session (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    snapshot_json TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS browser_chat_session_user_id_idx ON browser_chat_session(user_id)',
  'CREATE INDEX IF NOT EXISTS browser_chat_session_updated_at_idx ON browser_chat_session(updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS browser_chat_session_user_updated_id_idx ON browser_chat_session(user_id, updated_at DESC, id DESC)',
  `CREATE TABLE IF NOT EXISTS browser_chat_message (
    session_id TEXT NOT NULL,
    id TEXT NOT NULL,
    time TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (session_id, id),
    FOREIGN KEY (session_id) REFERENCES browser_chat_session(id) ON DELETE CASCADE
  )`,
  'CREATE INDEX IF NOT EXISTS browser_chat_message_session_time_idx ON browser_chat_message(session_id, time)',
  'CREATE INDEX IF NOT EXISTS browser_chat_message_session_time_id_idx ON browser_chat_message(session_id, time DESC, id DESC)',
  `CREATE TABLE IF NOT EXISTS browser_chat_step (
    session_id TEXT NOT NULL,
    step_index INTEGER NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (session_id, step_index),
    FOREIGN KEY (session_id) REFERENCES browser_chat_session(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS browser_chat_log (
    session_id TEXT NOT NULL,
    id TEXT NOT NULL,
    time TEXT NOT NULL,
    message_id TEXT,
    record_json TEXT NOT NULL,
    PRIMARY KEY (session_id, id),
    FOREIGN KEY (session_id) REFERENCES browser_chat_session(id) ON DELETE CASCADE
  )`,
  'CREATE INDEX IF NOT EXISTS browser_chat_log_session_time_idx ON browser_chat_log(session_id, time)',
  'CREATE INDEX IF NOT EXISTS browser_chat_log_session_time_id_idx ON browser_chat_log(session_id, time DESC, id DESC)',
  'CREATE INDEX IF NOT EXISTS browser_chat_log_session_message_time_idx ON browser_chat_log(session_id, message_id, time DESC, id DESC)',
  `CREATE TABLE IF NOT EXISTS ai_operations_chat_archive (
    session_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    record_json TEXT NOT NULL,
    first_event_at TEXT NOT NULL,
    last_event_at TEXT NOT NULL,
    archived_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS ai_operations_chat_archive_user_last_event_idx ON ai_operations_chat_archive(user_id, last_event_at DESC)',
  'CREATE INDEX IF NOT EXISTS ai_operations_chat_archive_last_event_idx ON ai_operations_chat_archive(last_event_at DESC)',
  `CREATE TABLE IF NOT EXISTS personal_memory_item (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    shared BOOLEAN NOT NULL DEFAULT FALSE,
    scope TEXT NOT NULL,
    domain TEXT NOT NULL,
    type TEXT NOT NULL,
    memory_key TEXT NOT NULL,
    status TEXT NOT NULL,
    record_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS personal_memory_identity_idx ON personal_memory_item(user_id, scope, domain, type, memory_key)',
  'CREATE INDEX IF NOT EXISTS personal_memory_updated_at_idx ON personal_memory_item(updated_at DESC)',
  `CREATE TABLE IF NOT EXISTS user_onboarding_state (
    user_id TEXT PRIMARY KEY,
    tutorial_version INTEGER NOT NULL,
    status TEXT NOT NULL,
    completed_steps_json TEXT NOT NULL DEFAULT '[]',
    dismissed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS login_account (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    shared BOOLEAN NOT NULL DEFAULT FALSE,
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
  )`,
  'CREATE INDEX IF NOT EXISTS login_account_user_domain_idx ON login_account(user_id, domain)',
  'CREATE INDEX IF NOT EXISTS login_account_updated_at_idx ON login_account(updated_at DESC)',
  `CREATE TABLE IF NOT EXISTS websocket_ticket (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    session_id TEXT,
    scope TEXT NOT NULL,
    origin TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    consumed_at TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS websocket_ticket_token_idx ON websocket_ticket(token_hash, expires_at)',
  `CREATE TABLE IF NOT EXISTS browser_code_runtime_state (
    session_id TEXT NOT NULL,
    namespace TEXT NOT NULL DEFAULT 'conversation',
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT,
    PRIMARY KEY (session_id, namespace, key)
  )`,
  'CREATE INDEX IF NOT EXISTS browser_code_runtime_state_expiry_idx ON browser_code_runtime_state(expires_at) WHERE expires_at IS NOT NULL',
  `CREATE TABLE IF NOT EXISTS browser_chat_defect (
    session_id TEXT NOT NULL,
    id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (session_id, id),
    FOREIGN KEY (session_id) REFERENCES browser_chat_session(id) ON DELETE CASCADE
  )`,
  'CREATE INDEX IF NOT EXISTS browser_chat_defect_session_created_idx ON browser_chat_defect(session_id, created_at DESC)',
  `CREATE TABLE IF NOT EXISTS automation_case (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    source_session_id TEXT NOT NULL,
    title TEXT NOT NULL,
    target_url TEXT NOT NULL,
    record_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS automation_case_user_updated_at_idx ON automation_case(user_id, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS automation_case_source_session_idx ON automation_case(source_session_id, updated_at DESC)',
  `CREATE TABLE IF NOT EXISTS automation_schedule (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    case_id TEXT NOT NULL,
    title TEXT NOT NULL,
    recurrence TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    next_run_at TEXT NOT NULL,
    record_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (case_id) REFERENCES automation_case(id) ON DELETE CASCADE
  )`,
  'CREATE INDEX IF NOT EXISTS automation_schedule_user_updated_at_idx ON automation_schedule(user_id, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS automation_schedule_case_idx ON automation_schedule(case_id, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS automation_schedule_due_idx ON automation_schedule(enabled, next_run_at ASC)',
  `CREATE TABLE IF NOT EXISTS automation_run (
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
  )`,
  'CREATE INDEX IF NOT EXISTS automation_run_user_created_at_idx ON automation_run(user_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS automation_run_case_created_at_idx ON automation_run(case_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS automation_run_schedule_created_at_idx ON automation_run(schedule_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS automation_run_status_created_at_idx ON automation_run(status, created_at ASC)',
  'CREATE INDEX IF NOT EXISTS automation_run_lease_idx ON automation_run(status, lease_expires_at ASC)',
  'CREATE UNIQUE INDEX IF NOT EXISTS automation_run_occurrence_idx ON automation_run(schedule_id, occurrence_key) WHERE schedule_id IS NOT NULL AND occurrence_key IS NOT NULL',
  `CREATE TABLE IF NOT EXISTS api_idempotency (
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
  )`,
  'CREATE INDEX IF NOT EXISTS api_idempotency_expires_idx ON api_idempotency(expires_at)',
  `CREATE TABLE IF NOT EXISTS browser_domain_cookie (
    user_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    cookie_envelope TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, domain)
  )`,
  'CREATE INDEX IF NOT EXISTS browser_domain_cookie_updated_idx ON browser_domain_cookie(updated_at DESC)',
] as const;

export class InitialBackendSchema1788307200000 implements MigrationInterface {
  name = 'InitialBackendSchema1788307200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const statement of statements) await queryRunner.query(statement);
  }

  async down(): Promise<void> {
    throw new Error('The initial backend schema is irreversible.');
  }
}
