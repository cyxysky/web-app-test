import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { SkillRecord } from '@/server/ai/schemas/runtime.schema';
import { getSqliteDatabase, parseSqliteJson, runSqliteTransaction } from '@/server/storage/sqlite-database';
import { queueSqliteWrite, type SqliteWriteStatement } from '@/server/storage/sqlite-write-queue';

type ConfigRecord = {
  runtimeEnv: unknown[];
  modelConfig?: unknown;
};

type JsonRow = { record_json: string };

type SkillJsonRow = JsonRow & { user_id: string; shared: number };

const preparedStatements = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

function prepared(database: DatabaseSync, sql: string) {
  let statements = preparedStatements.get(database);
  if (!statements) {
    statements = new Map();
    preparedStatements.set(database, statements);
  }
  const existing = statements.get(sql);
  if (existing) return existing;
  const statement = database.prepare(sql);
  statements.set(sql, statement);
  return statement;
}

function now() {
  return new Date().toISOString();
}

export function readRuntimeMeta(key: string) {
  const row = getSqliteDatabase().prepare('SELECT value FROM runtime_meta WHERE key = ?').get(key) as { value?: string } | undefined;
  return row?.value;
}

export function writeRuntimeMeta(key: string, value: string) {
  getSqliteDatabase().prepare(`
    INSERT INTO runtime_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, now());
}

export function readConfigRecord(): ConfigRecord {
  const row = getSqliteDatabase().prepare(`
    SELECT runtime_env_json, model_config_json FROM app_config WHERE id = 1
  `).get() as { runtime_env_json?: string; model_config_json?: string | null } | undefined;
  if (!row) return { runtimeEnv: [] };
  return {
    runtimeEnv: parseSqliteJson<unknown[]>(row.runtime_env_json, []),
    modelConfig: parseSqliteJson<unknown>(row.model_config_json, undefined),
  };
}

export function writeConfigRecord(data: ConfigRecord) {
  getSqliteDatabase().prepare(`
    INSERT INTO app_config (id, runtime_env_json, model_config_json, updated_at)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      runtime_env_json = excluded.runtime_env_json,
      model_config_json = excluded.model_config_json,
      updated_at = excluded.updated_at
  `).run(JSON.stringify(data.runtimeEnv || []), data.modelConfig === undefined ? null : JSON.stringify(data.modelConfig), now());
}

export function readSkills(userId?: string, input: { limit?: number; query?: string } = {}) {
  const clauses: string[] = [];
  const values: Array<number | string> = [];
  if (userId !== undefined) {
    clauses.push('(user_id = ? OR shared = 1)');
    values.push(userId);
  }
  const query = input.query?.trim().toLowerCase();
  if (query) {
    clauses.push('LOWER(record_json) LIKE ?');
    values.push(`%${query}%`);
  }
  const limit = Number.isFinite(input.limit)
    ? Math.max(1, Math.min(500, Math.floor(Number(input.limit))))
    : undefined;
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const sql = `
    SELECT user_id, shared, record_json FROM skill
    ${where}
    ORDER BY updated_at DESC
    ${limit ? 'LIMIT ?' : ''}
  `;
  if (limit) values.push(limit);
  const rows = getSqliteDatabase().prepare(sql).all(...values) as SkillJsonRow[];
  return rows
    .map((row) => {
      const record = parseSqliteJson<SkillRecord | undefined>(row.record_json, undefined);
      return record ? { ...record, userId: row.user_id, shared: Boolean(row.shared) } : undefined;
    })
    .filter((item): item is SkillRecord => Boolean(item));
}

export function readSkillById(skillId: string, userId?: string) {
  const row = (userId === undefined
    ? getSqliteDatabase().prepare(`
        SELECT user_id, shared, record_json FROM skill WHERE id = ?
      `).get(skillId)
    : getSqliteDatabase().prepare(`
        SELECT user_id, shared, record_json FROM skill
        WHERE id = ? AND (user_id = ? OR shared = 1)
      `).get(skillId, userId)) as SkillJsonRow | undefined;
  if (!row) return undefined;
  const record = parseSqliteJson<SkillRecord | undefined>(row.record_json, undefined);
  return record ? { ...record, userId: row.user_id, shared: Boolean(row.shared) } : undefined;
}

export function readSkillsByIds(skillIds: string[], userId: string) {
  const ids = Array.from(new Set(skillIds.map((id) => id.trim()).filter(Boolean))).slice(0, 200);
  if (!ids.length) return [];
  const rows = getSqliteDatabase().prepare(`
    SELECT user_id, shared, record_json FROM skill
    WHERE id IN (${ids.map(() => '?').join(', ')}) AND (user_id = ? OR shared = 1)
  `).all(...ids, userId) as SkillJsonRow[];
  return rows
    .map((row) => {
      const record = parseSqliteJson<SkillRecord | undefined>(row.record_json, undefined);
      return record ? { ...record, userId: row.user_id, shared: Boolean(row.shared) } : undefined;
    })
    .filter((item): item is SkillRecord => Boolean(item));
}

function upsertSkillRecord(database: DatabaseSync, skill: SkillRecord, userId: string) {
  prepared(database, `
    INSERT INTO skill (id, user_id, shared, title, status, record_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      shared = excluded.shared,
      title = excluded.title,
      status = excluded.status,
      record_json = excluded.record_json,
      updated_at = excluded.updated_at
  `).run(skill.id, userId, skill.shared ? 1 : 0, skill.title, skill.status, JSON.stringify(skill), skill.createdAt, skill.updatedAt);
}

export function writeSkillRecord(skill: SkillRecord, userId: string) {
  upsertSkillRecord(getSqliteDatabase(), skill, userId);
}

export function writeSkillRecords(items: Array<{ skill: SkillRecord; userId: string }>) {
  runSqliteTransaction((database) => {
    for (const item of items) upsertSkillRecord(database, item.skill, item.userId);
  });
}

export function writeSkillRecordsQueued(items: Array<{ skill: SkillRecord; userId: string }>) {
  return queueSqliteWrite(items.map(({ skill, userId }) => ({
    sql: `
      INSERT INTO skill (id, user_id, shared, title, status, record_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        shared = excluded.shared,
        title = excluded.title,
        status = excluded.status,
        record_json = excluded.record_json,
        updated_at = excluded.updated_at
      WHERE skill.user_id = excluded.user_id
    `,
    params: [skill.id, userId, skill.shared ? 1 : 0, skill.title, skill.status, JSON.stringify(skill), skill.createdAt, skill.updatedAt],
  })));
}

export function deleteSkillRecord(skillId: string, userId: string) {
  const result = getSqliteDatabase().prepare('DELETE FROM skill WHERE id = ? AND user_id = ?').run(skillId, userId);
  return Number(result.changes) > 0;
}

export type PersonalMemoryRecordFields = {
  id: string;
  userId: string;
  shared: boolean;
  scope: string;
  domain: string;
  type: string;
  key: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export function readPersonalMemoryRecords<T>(input: {
  domain?: string;
  ids?: string[];
  includeDisabled?: boolean;
  includeShared?: boolean;
  limit?: number;
  userId?: string;
} = {}) {
  const clauses: string[] = [];
  const values: Array<number | string> = [];
  if (input.userId) {
    clauses.push(input.includeShared === false ? 'user_id = ?' : '(user_id = ? OR shared = 1)');
    values.push(input.userId);
  }
  if (input.includeDisabled === false) clauses.push("status = 'active'");
  if (input.domain) {
    clauses.push("(scope = 'global' OR domain = ? OR ? LIKE '%.' || domain)");
    values.push(input.domain, input.domain);
  }
  const ids = Array.from(new Set((input.ids || []).map((id) => id.trim()).filter(Boolean))).slice(0, 500);
  if (ids.length) {
    clauses.push(`id IN (${ids.map(() => '?').join(', ')})`);
    values.push(...ids);
  } else if (input.ids) {
    return [];
  }
  const limit = Number.isFinite(input.limit)
    ? Math.max(1, Math.min(2_000, Math.floor(Number(input.limit))))
    : undefined;
  if (limit) values.push(limit);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return (getSqliteDatabase().prepare(`
    SELECT record_json FROM personal_memory_item
    ${where}
    ORDER BY updated_at DESC
    ${limit ? 'LIMIT ?' : ''}
  `).all(...values) as JsonRow[])
    .map((row) => parseSqliteJson<T | undefined>(row.record_json, undefined))
    .filter((item): item is T => Boolean(item));
}

export function readPersonalMemoryRecordByIdentity<T>(input: {
  domain: string;
  key: string;
  scope: string;
  type: string;
  userId: string;
}) {
  const row = getSqliteDatabase().prepare(`
    SELECT record_json FROM personal_memory_item
    WHERE user_id = ? AND scope = ? AND domain = ? AND type = ? AND LOWER(memory_key) = LOWER(?)
    LIMIT 1
  `).get(input.userId, input.scope, input.domain, input.type, input.key) as JsonRow | undefined;
  return parseSqliteJson<T | undefined>(row?.record_json, undefined);
}

function upsertPersonalMemoryRecord<T extends PersonalMemoryRecordFields>(database: DatabaseSync, item: T) {
  prepared(database, `
    INSERT INTO personal_memory_item (
      id, user_id, shared, scope, domain, type, memory_key, status, record_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      shared = excluded.shared,
      scope = excluded.scope,
      domain = excluded.domain,
      type = excluded.type,
      memory_key = excluded.memory_key,
      status = excluded.status,
      record_json = excluded.record_json,
      updated_at = excluded.updated_at
    WHERE personal_memory_item.user_id = excluded.user_id
  `).run(
    item.id,
    item.userId,
    item.shared ? 1 : 0,
    item.scope,
    item.domain,
    item.type,
    item.key,
    item.status,
    JSON.stringify(item),
    item.createdAt,
    item.updatedAt,
  );
}

export function writePersonalMemoryRecord<T extends PersonalMemoryRecordFields>(item: T) {
  return runSqliteTransaction((database) => upsertPersonalMemoryRecord(database, item));
}

export function writePersonalMemoryRecords<T extends PersonalMemoryRecordFields>(items: T[]) {
  runSqliteTransaction((database) => {
    for (const item of items) upsertPersonalMemoryRecord(database, item);
  });
}

export function writePersonalMemoryRecordsQueued<T extends PersonalMemoryRecordFields>(items: T[]) {
  return queueSqliteWrite(items.map((item) => ({
    sql: `
      INSERT INTO personal_memory_item (
        id, user_id, shared, scope, domain, type, memory_key, status, record_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        shared = excluded.shared,
        scope = excluded.scope,
        domain = excluded.domain,
        type = excluded.type,
        memory_key = excluded.memory_key,
        status = excluded.status,
        record_json = excluded.record_json,
        updated_at = excluded.updated_at
      WHERE personal_memory_item.user_id = excluded.user_id
    `,
    params: [
      item.id, item.userId, item.shared ? 1 : 0, item.scope, item.domain, item.type,
      item.key, item.status, JSON.stringify(item), item.createdAt, item.updatedAt,
    ],
  })));
}

export function deletePersonalMemoryRecord(id: string, userId: string) {
  const result = getSqliteDatabase().prepare(`
    DELETE FROM personal_memory_item WHERE id = ? AND user_id = ?
  `).run(id, userId);
  return Number(result.changes) > 0;
}

export function markPersonalMemoryRecordsUsed<T extends PersonalMemoryRecordFields & {
  lastUsedAt?: string;
  useCount: number;
}>(ids: string[], timestamp: string) {
  const normalizedIds = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean))).slice(0, 500);
  if (!normalizedIds.length) return [];
  return runSqliteTransaction((database) => {
    const rows = database.prepare(`
      SELECT record_json FROM personal_memory_item
      WHERE id IN (${normalizedIds.map(() => '?').join(', ')})
    `).all(...normalizedIds) as JsonRow[];
    const items = rows
      .map((row) => parseSqliteJson<T | undefined>(row.record_json, undefined))
      .filter((item): item is T => Boolean(item))
      .map((item) => ({
        ...item,
        lastUsedAt: timestamp,
        updatedAt: timestamp,
        useCount: Math.max(0, Number(item.useCount) || 0) + 1,
      }));
    for (const item of items) upsertPersonalMemoryRecord(database, item);
    return items;
  });
}

type BrowserChatSessionFields = {
  id: string;
  userId?: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type BrowserChatRealtimeOutboxEvent = {
  entityType: 'browserChatSession';
  id: string;
  updatedAt: string;
  userId: string;
  deleted?: boolean;
  patch?: unknown;
};

export type BrowserChatRealtimeOutboxRecord = {
  id: number;
  sessionId: string;
  userId: string;
  eventType: 'browserChatSession';
  payload: BrowserChatRealtimeOutboxEvent;
  createdAt: string;
  attempts: number;
};

function insertBrowserChatRealtimeOutboxEvent(
  database: DatabaseSync,
  event: BrowserChatRealtimeOutboxEvent,
) {
  const result = prepared(database, `
    INSERT INTO browser_chat_realtime_outbox (
      session_id, user_id, event_type, payload_json, created_at
    ) VALUES (?, ?, 'browserChatSession', ?, ?)
  `).run(event.id, event.userId, JSON.stringify(event), now());
  return Number(result.lastInsertRowid);
}

export function readBrowserChatLogs<T>(sessionId: string) {
  const rows = getSqliteDatabase().prepare(`
    SELECT record_json FROM browser_chat_log WHERE session_id = ? ORDER BY time ASC
  `).all(sessionId) as JsonRow[];
  return rows
    .map((row) => parseSqliteJson<T | undefined>(row.record_json, undefined))
    .filter((item): item is T => Boolean(item));
}

function readBrowserChatMessages<T>(sessionId: string) {
  const rows = getSqliteDatabase().prepare(`
    SELECT record_json FROM browser_chat_message WHERE session_id = ? ORDER BY time ASC
  `).all(sessionId) as JsonRow[];
  return rows
    .map((row) => parseSqliteJson<T | undefined>(row.record_json, undefined))
    .filter((item): item is T => Boolean(item));
}

function readBrowserChatSteps<T>(sessionId: string) {
  const rows = getSqliteDatabase().prepare(`
    SELECT record_json FROM browser_chat_step WHERE session_id = ? ORDER BY step_index ASC
  `).all(sessionId) as JsonRow[];
  return rows
    .map((row) => parseSqliteJson<T | undefined>(row.record_json, undefined))
    .filter((item): item is T => Boolean(item));
}

export function readBrowserChatSessionRecord<T extends { logs?: unknown[]; messages?: unknown[]; steps?: unknown[] }>(sessionId: string) {
  const row = getSqliteDatabase().prepare(`
    SELECT snapshot_json FROM browser_chat_session WHERE id = ?
  `).get(sessionId) as { snapshot_json?: string } | undefined;
  const snapshot = parseSqliteJson<T | undefined>(row?.snapshot_json, undefined);
  return snapshot ? {
    ...snapshot,
    messages: readBrowserChatMessages(sessionId),
    steps: readBrowserChatSteps(sessionId),
    logs: readBrowserChatLogs(sessionId),
  } : undefined;
}

export function readBrowserChatSessionSummaries<T>(input: {
  beforeId?: string;
  beforeUpdatedAt?: string;
  limit?: number;
  userId?: string;
} = {}) {
  const clauses: string[] = [];
  const values: Array<number | string> = [];
  if (input.userId) {
    clauses.push('user_id = ?');
    values.push(input.userId);
  }
  if (input.beforeUpdatedAt && input.beforeId) {
    clauses.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
    values.push(input.beforeUpdatedAt, input.beforeUpdatedAt, input.beforeId);
  }
  const limit = Number.isFinite(input.limit)
    ? Math.max(1, Math.min(501, Math.floor(Number(input.limit))))
    : undefined;
  if (limit) values.push(limit);
  const rows = getSqliteDatabase().prepare(`
    SELECT summary_json FROM browser_chat_session
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY updated_at DESC, id DESC
    ${limit ? 'LIMIT ?' : ''}
  `).all(...values) as Array<{ summary_json?: string }>;
  return rows
    .map((row) => parseSqliteJson<T | undefined>(row.summary_json, undefined))
    .filter((item): item is T => Boolean(item));
}

export function writeBrowserChatSessionRecord<
  TSnapshot extends BrowserChatSessionFields,
  TMessage extends { id: string; createdAt: string; updatedAt?: string },
  TStep extends { index: number },
  TLog extends { id: string; time: string },
>(
  snapshot: TSnapshot,
  summary: unknown,
  messages: TMessage[],
  steps: TStep[],
  logs: TLog[],
) {
  runSqliteTransaction((database) => {
    prepared(database, `
      INSERT INTO browser_chat_session (
        id, user_id, title, status, revision, snapshot_json, summary_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        user_id = excluded.user_id,
        title = excluded.title,
        status = excluded.status,
        revision = browser_chat_session.revision + 1,
        snapshot_json = excluded.snapshot_json,
        summary_json = excluded.summary_json,
        updated_at = excluded.updated_at
    `).run(
      snapshot.id,
      snapshot.userId || null,
      snapshot.title,
      snapshot.status,
      JSON.stringify(snapshot),
      JSON.stringify(summary),
      snapshot.createdAt,
      snapshot.updatedAt,
    );

    const upsertMessage = prepared(database, `
      INSERT INTO browser_chat_message (session_id, id, time, record_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, id) DO UPDATE SET time = excluded.time, record_json = excluded.record_json
    `);
    for (const message of messages) {
      upsertMessage.run(snapshot.id, message.id, message.updatedAt || message.createdAt, JSON.stringify(message));
    }
    pruneBrowserChatRows(database, 'browser_chat_message', 'id', snapshot.id, messages.map((message) => message.id));

    const upsertStep = prepared(database, `
      INSERT INTO browser_chat_step (session_id, step_index, record_json) VALUES (?, ?, ?)
      ON CONFLICT(session_id, step_index) DO UPDATE SET record_json = excluded.record_json
    `);
    for (const step of steps) upsertStep.run(snapshot.id, step.index, JSON.stringify(step));
    pruneBrowserChatRows(database, 'browser_chat_step', 'step_index', snapshot.id, steps.map((step) => step.index));

    const insertLog = prepared(database, `
      INSERT INTO browser_chat_log (session_id, id, time, record_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, id) DO UPDATE SET time = excluded.time, record_json = excluded.record_json
    `);
    for (const log of logs) insertLog.run(snapshot.id, log.id, log.time, JSON.stringify(log));
    pruneBrowserChatRows(database, 'browser_chat_log', 'id', snapshot.id, logs.map((log) => log.id));
  });
}

export function writeBrowserChatSessionDelta<
  TSnapshot extends BrowserChatSessionFields,
  TMessage extends { id: string; createdAt: string; updatedAt?: string },
  TStep extends { index: number },
  TLog extends { id: string; time: string },
>(
  snapshot: TSnapshot,
  summary: unknown,
  delta: {
    messages?: TMessage[];
    steps?: TStep[];
    logs?: TLog[];
    removedMessageIds?: string[];
    removedStepIndexes?: number[];
    removedLogIds?: string[];
  },
  outboxEvent: BrowserChatRealtimeOutboxEvent,
) {
  return runSqliteTransaction((database) => {
    prepared(database, `
      INSERT INTO browser_chat_session (
        id, user_id, title, status, revision, snapshot_json, summary_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        user_id = excluded.user_id,
        title = excluded.title,
        status = excluded.status,
        revision = browser_chat_session.revision + 1,
        snapshot_json = excluded.snapshot_json,
        summary_json = excluded.summary_json,
        updated_at = excluded.updated_at
    `).run(
      snapshot.id,
      snapshot.userId || null,
      snapshot.title,
      snapshot.status,
      JSON.stringify(snapshot),
      JSON.stringify(summary),
      snapshot.createdAt,
      snapshot.updatedAt,
    );

    const upsertMessage = prepared(database, `
      INSERT INTO browser_chat_message (session_id, id, time, record_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, id) DO UPDATE SET time = excluded.time, record_json = excluded.record_json
    `);
    for (const message of delta.messages || []) {
      upsertMessage.run(snapshot.id, message.id, message.updatedAt || message.createdAt, JSON.stringify(message));
    }

    const upsertStep = prepared(database, `
      INSERT INTO browser_chat_step (session_id, step_index, record_json) VALUES (?, ?, ?)
      ON CONFLICT(session_id, step_index) DO UPDATE SET record_json = excluded.record_json
    `);
    for (const step of delta.steps || []) upsertStep.run(snapshot.id, step.index, JSON.stringify(step));

    const upsertLog = prepared(database, `
      INSERT INTO browser_chat_log (session_id, id, time, record_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, id) DO UPDATE SET time = excluded.time, record_json = excluded.record_json
    `);
    for (const log of delta.logs || []) upsertLog.run(snapshot.id, log.id, log.time, JSON.stringify(log));

    const deleteMessage = prepared(database, 'DELETE FROM browser_chat_message WHERE session_id = ? AND id = ?');
    for (const messageId of delta.removedMessageIds || []) deleteMessage.run(snapshot.id, messageId);
    const deleteStep = prepared(database, 'DELETE FROM browser_chat_step WHERE session_id = ? AND step_index = ?');
    for (const stepIndex of delta.removedStepIndexes || []) deleteStep.run(snapshot.id, stepIndex);
    const deleteLog = prepared(database, 'DELETE FROM browser_chat_log WHERE session_id = ? AND id = ?');
    for (const logId of delta.removedLogIds || []) deleteLog.run(snapshot.id, logId);
    return insertBrowserChatRealtimeOutboxEvent(database, outboxEvent);
  });
}

export function readReferencedUploadPaths(userId?: string) {
  const prefix = userId ? `uploads/${userId}/` : 'uploads/';
  const rows = getSqliteDatabase().prepare(`
    SELECT record_json FROM browser_chat_message
    WHERE record_json LIKE ?
  `).all(`%${prefix}%`) as JsonRow[];
  const paths = new Set<string>();
  for (const row of rows) {
    const message = parseSqliteJson<{ attachments?: Array<{ path?: unknown }> }>(row.record_json, {});
    for (const attachment of message.attachments || []) {
      const candidate = typeof attachment.path === 'string' ? attachment.path.replace(/\\/g, '/').trim() : '';
      if (candidate.startsWith(prefix) && !candidate.includes('..')) paths.add(candidate);
    }
  }
  return paths;
}

export function writeBrowserChatSessionDeltaQueued<
  TSnapshot extends BrowserChatSessionFields,
  TMessage extends { id: string; createdAt: string; updatedAt?: string },
  TStep extends { index: number },
  TLog extends { id: string; time: string },
>(
  snapshot: TSnapshot,
  summary: unknown,
  delta: {
    messages?: TMessage[];
    steps?: TStep[];
    logs?: TLog[];
    removedMessageIds?: string[];
    removedStepIndexes?: number[];
    removedLogIds?: string[];
  },
  outboxEvent: BrowserChatRealtimeOutboxEvent,
) {
  const statements: SqliteWriteStatement[] = [{
    sql: `
      INSERT INTO browser_chat_session (
        id, user_id, title, status, revision, snapshot_json, summary_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        user_id = excluded.user_id,
        title = excluded.title,
        status = excluded.status,
        revision = browser_chat_session.revision + 1,
        snapshot_json = excluded.snapshot_json,
        summary_json = excluded.summary_json,
        updated_at = excluded.updated_at
    `,
    params: [
      snapshot.id, snapshot.userId || null, snapshot.title, snapshot.status,
      JSON.stringify(snapshot), JSON.stringify(summary), snapshot.createdAt, snapshot.updatedAt,
    ],
  }];
  for (const message of delta.messages || []) statements.push({
    sql: `
      INSERT INTO browser_chat_message (session_id, id, time, record_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, id) DO UPDATE SET time = excluded.time, record_json = excluded.record_json
    `,
    params: [snapshot.id, message.id, message.updatedAt || message.createdAt, JSON.stringify(message)],
  });
  for (const step of delta.steps || []) statements.push({
    sql: `
      INSERT INTO browser_chat_step (session_id, step_index, record_json) VALUES (?, ?, ?)
      ON CONFLICT(session_id, step_index) DO UPDATE SET record_json = excluded.record_json
    `,
    params: [snapshot.id, step.index, JSON.stringify(step)],
  });
  for (const log of delta.logs || []) statements.push({
    sql: `
      INSERT INTO browser_chat_log (session_id, id, time, record_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, id) DO UPDATE SET time = excluded.time, record_json = excluded.record_json
    `,
    params: [snapshot.id, log.id, log.time, JSON.stringify(log)],
  });
  for (const id of delta.removedMessageIds || []) statements.push({
    sql: 'DELETE FROM browser_chat_message WHERE session_id = ? AND id = ?',
    params: [snapshot.id, id],
  });
  for (const index of delta.removedStepIndexes || []) statements.push({
    sql: 'DELETE FROM browser_chat_step WHERE session_id = ? AND step_index = ?',
    params: [snapshot.id, index],
  });
  for (const id of delta.removedLogIds || []) statements.push({
    sql: 'DELETE FROM browser_chat_log WHERE session_id = ? AND id = ?',
    params: [snapshot.id, id],
  });
  statements.push({
    sql: `
      INSERT INTO browser_chat_realtime_outbox (
        session_id, user_id, event_type, payload_json, created_at
      ) VALUES (?, ?, 'browserChatSession', ?, ?)
    `,
    params: [outboxEvent.id, outboxEvent.userId, JSON.stringify(outboxEvent), now()],
  });
  return queueSqliteWrite(statements);
}

function pruneBrowserChatRows(
  database: DatabaseSync,
  table: 'browser_chat_message' | 'browser_chat_step' | 'browser_chat_log',
  key: 'id' | 'step_index',
  sessionId: string,
  retainedKeys: Array<string | number>,
) {
  if (!retainedKeys.length) {
    database.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
    return;
  }
  const placeholders = retainedKeys.map(() => '?').join(', ');
  database.prepare(`DELETE FROM ${table} WHERE session_id = ? AND ${key} NOT IN (${placeholders})`)
    .run(sessionId, ...retainedKeys);
}

export function deleteBrowserChatSessionRecord(sessionId: string, outboxEvent: BrowserChatRealtimeOutboxEvent) {
  return runSqliteTransaction((database) => {
    database.prepare('DELETE FROM browser_chat_session WHERE id = ?').run(sessionId);
    return insertBrowserChatRealtimeOutboxEvent(database, outboxEvent);
  });
}

export function deleteBrowserChatSessionRecordQueued(sessionId: string, outboxEvent: BrowserChatRealtimeOutboxEvent) {
  return queueSqliteWrite([{
    sql: 'DELETE FROM browser_chat_session WHERE id = ?',
    params: [sessionId],
  }, {
    sql: `
      INSERT INTO browser_chat_realtime_outbox (
        session_id, user_id, event_type, payload_json, created_at
      ) VALUES (?, ?, 'browserChatSession', ?, ?)
    `,
    params: [outboxEvent.id, outboxEvent.userId, JSON.stringify(outboxEvent), now()],
  }]);
}

export function readPendingBrowserChatRealtimeOutbox(limit = 100): BrowserChatRealtimeOutboxRecord[] {
  const rows = getSqliteDatabase().prepare(`
    SELECT id, session_id, user_id, event_type, payload_json, created_at, attempts
    FROM browser_chat_realtime_outbox
    WHERE delivered_at IS NULL
    ORDER BY id ASC
    LIMIT ?
  `).all(Math.max(1, Math.min(500, Math.floor(limit)))) as Array<{
    id: number;
    session_id: string;
    user_id: string;
    event_type: 'browserChatSession';
    payload_json: string;
    created_at: string;
    attempts: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    eventType: row.event_type,
    payload: parseSqliteJson<BrowserChatRealtimeOutboxEvent>(row.payload_json, {
      entityType: 'browserChatSession',
      id: row.session_id,
      updatedAt: row.created_at,
      userId: row.user_id,
    }),
    createdAt: row.created_at,
    attempts: row.attempts,
  }));
}

export function markBrowserChatRealtimeOutboxDelivered(id: number) {
  getSqliteDatabase().prepare(`
    UPDATE browser_chat_realtime_outbox
    SET delivered_at = ?, attempts = attempts + 1, last_error = NULL
    WHERE id = ? AND delivered_at IS NULL
  `).run(now(), id);
}

export function markBrowserChatRealtimeOutboxFailed(id: number, error: string) {
  getSqliteDatabase().prepare(`
    UPDATE browser_chat_realtime_outbox
    SET attempts = attempts + 1, last_error = ?
    WHERE id = ? AND delivered_at IS NULL
  `).run(error.slice(0, 1000), id);
}

export function pruneDeliveredBrowserChatRealtimeOutbox(retain = 1_000) {
  getSqliteDatabase().prepare(`
    DELETE FROM browser_chat_realtime_outbox
    WHERE delivered_at IS NOT NULL
      AND id NOT IN (
        SELECT id FROM browser_chat_realtime_outbox
        WHERE delivered_at IS NOT NULL
        ORDER BY id DESC
        LIMIT ?
      )
  `).run(Math.max(100, Math.floor(retain)));
}
