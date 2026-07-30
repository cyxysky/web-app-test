import type { DatabaseSync } from 'node:sqlite';
import type { SkillRecord } from '@/server/ai/schemas/runtime.schema';
import { getSqliteDatabase, parseSqliteJson, runSqliteTransaction } from '@/server/storage/sqlite-database';

type ConfigRecord = {
  runtimeEnv: unknown[];
  modelConfig?: unknown;
};

type JsonRow = { record_json: string };

type SkillJsonRow = JsonRow & { user_id: string; shared: number };

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

function readJsonRows<T>(sql: string) {
  return (getSqliteDatabase().prepare(sql).all() as JsonRow[])
    .map((row) => parseSqliteJson<T | undefined>(row.record_json, undefined))
    .filter((item): item is T => Boolean(item));
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

export function readSkills(userId?: string) {
  const statement = userId === undefined
    ? getSqliteDatabase().prepare('SELECT user_id, shared, record_json FROM skill ORDER BY updated_at DESC')
    : getSqliteDatabase().prepare('SELECT user_id, shared, record_json FROM skill WHERE user_id = ? OR shared = 1 ORDER BY updated_at DESC');
  const rows = (userId === undefined ? statement.all() : statement.all(userId)) as SkillJsonRow[];
  return rows
    .map((row) => {
      const record = parseSqliteJson<SkillRecord | undefined>(row.record_json, undefined);
      return record ? { ...record, userId: row.user_id, shared: Boolean(row.shared) } : undefined;
    })
    .filter((item): item is SkillRecord => Boolean(item));
}

export function writeSkillRecord(skill: SkillRecord, userId: string) {
  getSqliteDatabase().prepare(`
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

export function deleteSkillRecord(skillId: string, userId: string) {
  const result = getSqliteDatabase().prepare('DELETE FROM skill WHERE id = ? AND user_id = ?').run(skillId, userId);
  return Number(result.changes) > 0;
}

export function readPersonalMemoryRecords<T>() {
  return readJsonRows<T>('SELECT record_json FROM personal_memory_item ORDER BY updated_at DESC');
}

export function replacePersonalMemoryRecords(items: Array<{
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
}>) {
  runSqliteTransaction((database) => {
    database.exec('DELETE FROM personal_memory_item');
    const insert = database.prepare(`
      INSERT INTO personal_memory_item (
        id, user_id, shared, scope, domain, type, memory_key, status, record_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of items) {
      insert.run(
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

export function readBrowserChatSessionSummaries<T>() {
  const rows = getSqliteDatabase().prepare(`
    SELECT summary_json FROM browser_chat_session ORDER BY updated_at DESC
  `).all() as Array<{ summary_json?: string }>;
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
    database.prepare(`
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

    const upsertMessage = database.prepare(`
      INSERT INTO browser_chat_message (session_id, id, time, record_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, id) DO UPDATE SET time = excluded.time, record_json = excluded.record_json
    `);
    for (const message of messages) {
      upsertMessage.run(snapshot.id, message.id, message.updatedAt || message.createdAt, JSON.stringify(message));
    }
    pruneBrowserChatRows(database, 'browser_chat_message', 'id', snapshot.id, messages.map((message) => message.id));

    const upsertStep = database.prepare(`
      INSERT INTO browser_chat_step (session_id, step_index, record_json) VALUES (?, ?, ?)
      ON CONFLICT(session_id, step_index) DO UPDATE SET record_json = excluded.record_json
    `);
    for (const step of steps) upsertStep.run(snapshot.id, step.index, JSON.stringify(step));
    pruneBrowserChatRows(database, 'browser_chat_step', 'step_index', snapshot.id, steps.map((step) => step.index));

    const insertLog = database.prepare(`
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
) {
  runSqliteTransaction((database) => {
    database.prepare(`
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

    const upsertMessage = database.prepare(`
      INSERT INTO browser_chat_message (session_id, id, time, record_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, id) DO UPDATE SET time = excluded.time, record_json = excluded.record_json
    `);
    for (const message of delta.messages || []) {
      upsertMessage.run(snapshot.id, message.id, message.updatedAt || message.createdAt, JSON.stringify(message));
    }

    const upsertStep = database.prepare(`
      INSERT INTO browser_chat_step (session_id, step_index, record_json) VALUES (?, ?, ?)
      ON CONFLICT(session_id, step_index) DO UPDATE SET record_json = excluded.record_json
    `);
    for (const step of delta.steps || []) upsertStep.run(snapshot.id, step.index, JSON.stringify(step));

    const upsertLog = database.prepare(`
      INSERT INTO browser_chat_log (session_id, id, time, record_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, id) DO UPDATE SET time = excluded.time, record_json = excluded.record_json
    `);
    for (const log of delta.logs || []) upsertLog.run(snapshot.id, log.id, log.time, JSON.stringify(log));

    const deleteMessage = database.prepare('DELETE FROM browser_chat_message WHERE session_id = ? AND id = ?');
    for (const messageId of delta.removedMessageIds || []) deleteMessage.run(snapshot.id, messageId);
    const deleteStep = database.prepare('DELETE FROM browser_chat_step WHERE session_id = ? AND step_index = ?');
    for (const stepIndex of delta.removedStepIndexes || []) deleteStep.run(snapshot.id, stepIndex);
    const deleteLog = database.prepare('DELETE FROM browser_chat_log WHERE session_id = ? AND id = ?');
    for (const logId of delta.removedLogIds || []) deleteLog.run(snapshot.id, logId);
  });
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

export function deleteBrowserChatSessionRecord(sessionId: string) {
  getSqliteDatabase().prepare('DELETE FROM browser_chat_session WHERE id = ?').run(sessionId);
}
