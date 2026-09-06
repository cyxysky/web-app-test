import { hydrateBrowserChatContextSnapshot, splitBrowserChatContextSnapshot, markBrowserChatContextWritten } from './browser-chat-context-store';
import type { EntityManager } from 'typeorm';
import type { SkillRecord } from '@/server/ai/schemas/runtime.schema';
import {
  executeDatabase,
  getDatabase,
  parseDatabaseJson,
  queryDatabase,
  queryDatabaseOne,
  runDatabaseTransaction,
  type DatabaseExecutor,
} from '@/server/db/database';
import { queueDatabaseWrite, type DatabaseWriteStatement } from './database-write-queue';

type ConfigRecord = {
  runtimeEnv: unknown[];
  modelConfig?: unknown;
};

type JsonRow = { record_json: string };
type SkillJsonRow = JsonRow & { user_id: string; shared: boolean | number };

function now() {
  return new Date().toISOString();
}

export async function readRuntimeMeta(key: string) {
  return (await queryDatabaseOne<{ value?: string }>('SELECT value FROM runtime_meta WHERE key = ?', [key]))?.value;
}

export async function writeRuntimeMeta(key: string, value: string) {
  await executeDatabase(`
    INSERT INTO runtime_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `, [key, value, now()]);
}

export async function readConfigRecord(): Promise<ConfigRecord> {
  const row = await queryDatabaseOne<{ runtime_env_json?: string; model_config_json?: string | null }>(`
    SELECT runtime_env_json, model_config_json FROM app_config WHERE id = 1
  `);
  if (!row) return { runtimeEnv: [] };
  return {
    runtimeEnv: parseDatabaseJson<unknown[]>(row.runtime_env_json, []),
    modelConfig: parseDatabaseJson<unknown>(row.model_config_json, undefined),
  };
}

export async function writeConfigRecord(data: ConfigRecord) {
  await executeDatabase(`
    INSERT INTO app_config (id, runtime_env_json, model_config_json, updated_at)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      runtime_env_json = excluded.runtime_env_json,
      model_config_json = excluded.model_config_json,
      updated_at = excluded.updated_at
  `, [JSON.stringify(data.runtimeEnv || []), data.modelConfig === undefined ? null : JSON.stringify(data.modelConfig), now()]);
}

export async function readSkills(userId?: string, input: {
  beforeId?: string;
  beforeUpdatedAt?: string;
  limit?: number;
  query?: string;
} = {}) {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (userId !== undefined) {
    clauses.push('(user_id = ? OR shared = ?)');
    values.push(userId, true);
  }
  const search = input.query?.trim().toLowerCase();
  if (search) {
    clauses.push('LOWER(record_json) LIKE ?');
    values.push(`%${search}%`);
  }
  if (input.beforeId?.trim() && input.beforeUpdatedAt?.trim()) {
    clauses.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
    values.push(input.beforeUpdatedAt.trim(), input.beforeUpdatedAt.trim(), input.beforeId.trim());
  }
  const limit = Number.isFinite(input.limit)
    ? Math.max(1, Math.min(5_000, Math.floor(Number(input.limit))))
    : undefined;
  if (limit) values.push(limit);
  const rows = await queryDatabase<SkillJsonRow>(`
    SELECT id, user_id, shared, record_json FROM skill
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY updated_at DESC, id DESC
    ${limit ? 'LIMIT ?' : ''}
  `, values);
  return rows.map((row) => {
    const record = parseDatabaseJson<SkillRecord | undefined>(row.record_json, undefined);
    return record ? { ...record, userId: row.user_id, shared: Boolean(row.shared) } : undefined;
  }).filter((item): item is SkillRecord => Boolean(item));
}

export async function readSkillById(skillId: string, userId?: string) {
  const row = userId === undefined
    ? await queryDatabaseOne<SkillJsonRow>('SELECT user_id, shared, record_json FROM skill WHERE id = ?', [skillId])
    : await queryDatabaseOne<SkillJsonRow>(`
        SELECT user_id, shared, record_json FROM skill
        WHERE id = ? AND (user_id = ? OR shared = ?)
      `, [skillId, userId, true]);
  if (!row) return undefined;
  const record = parseDatabaseJson<SkillRecord | undefined>(row.record_json, undefined);
  return record ? { ...record, userId: row.user_id, shared: Boolean(row.shared) } : undefined;
}

export async function readSkillsByIds(skillIds: string[], userId: string) {
  const ids = Array.from(new Set(skillIds.map((id) => id.trim()).filter(Boolean))).slice(0, 200);
  if (!ids.length) return [];
  const rows = await queryDatabase<SkillJsonRow>(`
    SELECT user_id, shared, record_json FROM skill
    WHERE id IN (${ids.map(() => '?').join(', ')}) AND (user_id = ? OR shared = ?)
  `, [...ids, userId, true]);
  return rows.map((row) => {
    const record = parseDatabaseJson<SkillRecord | undefined>(row.record_json, undefined);
    return record ? { ...record, userId: row.user_id, shared: Boolean(row.shared) } : undefined;
  }).filter((item): item is SkillRecord => Boolean(item));
}

async function upsertSkillRecord(executor: DatabaseExecutor, skill: SkillRecord, userId: string) {
  await executeDatabase(`
    INSERT INTO skill (id, user_id, shared, title, status, record_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      shared = excluded.shared,
      title = excluded.title,
      status = excluded.status,
      record_json = excluded.record_json,
      updated_at = excluded.updated_at
    WHERE skill.user_id = excluded.user_id
  `, [skill.id, userId, skill.shared, skill.title, skill.status, JSON.stringify(skill), skill.createdAt, skill.updatedAt], executor);
}

export async function writeSkillRecord(skill: SkillRecord, userId: string) {
  await upsertSkillRecord(await getDatabase(), skill, userId);
}

export async function writeSkillRecords(items: Array<{ skill: SkillRecord; userId: string }>) {
  await runDatabaseTransaction(async (manager) => {
    for (const item of items) await upsertSkillRecord(manager, item.skill, item.userId);
  });
}

export function writeSkillRecordsQueued(items: Array<{ skill: SkillRecord; userId: string }>) {
  return queueDatabaseWrite(items.map(({ skill, userId }) => ({
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
    params: [skill.id, userId, skill.shared, skill.title, skill.status, JSON.stringify(skill), skill.createdAt, skill.updatedAt],
  })));
}

export async function deleteSkillRecord(skillId: string, userId: string) {
  const existing = await queryDatabaseOne('SELECT id FROM skill WHERE id = ? AND user_id = ?', [skillId, userId]);
  if (!existing) return false;
  await executeDatabase('DELETE FROM skill WHERE id = ? AND user_id = ?', [skillId, userId]);
  return true;
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

export async function readPersonalMemoryRecords<T>(input: {
  domain?: string;
  ids?: string[];
  includeDisabled?: boolean;
  includeShared?: boolean;
  limit?: number;
  userId?: string;
} = {}) {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (input.userId) {
    clauses.push(input.includeShared === false ? 'user_id = ?' : '(user_id = ? OR shared = ?)');
    values.push(input.userId);
    if (input.includeShared !== false) values.push(true);
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
  } else if (input.ids) return [];
  const limit = Number.isFinite(input.limit)
    ? Math.max(1, Math.min(2_000, Math.floor(Number(input.limit))))
    : undefined;
  if (limit) values.push(limit);
  const rows = await queryDatabase<JsonRow>(`
    SELECT record_json FROM personal_memory_item
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY updated_at DESC
    ${limit ? 'LIMIT ?' : ''}
  `, values);
  return rows.map((row) => parseDatabaseJson<T | undefined>(row.record_json, undefined))
    .filter((item): item is T => Boolean(item));
}

export async function readPersonalMemoryRecordByIdentity<T>(input: {
  domain: string;
  key: string;
  scope: string;
  type: string;
  userId: string;
}) {
  const row = await queryDatabaseOne<JsonRow>(`
    SELECT record_json FROM personal_memory_item
    WHERE user_id = ? AND scope = ? AND domain = ? AND type = ? AND LOWER(memory_key) = LOWER(?)
    LIMIT 1
  `, [input.userId, input.scope, input.domain, input.type, input.key]);
  return parseDatabaseJson<T | undefined>(row?.record_json, undefined);
}

async function upsertPersonalMemoryRecord<T extends PersonalMemoryRecordFields>(executor: DatabaseExecutor, item: T) {
  await executeDatabase(`
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
  `, [
    item.id, item.userId, item.shared, item.scope, item.domain, item.type,
    item.key, item.status, JSON.stringify(item), item.createdAt, item.updatedAt,
  ], executor);
}

export async function writePersonalMemoryRecord<T extends PersonalMemoryRecordFields>(item: T) {
  await runDatabaseTransaction((manager) => upsertPersonalMemoryRecord(manager, item));
}

export async function writePersonalMemoryRecords<T extends PersonalMemoryRecordFields>(items: T[]) {
  await runDatabaseTransaction(async (manager) => {
    for (const item of items) await upsertPersonalMemoryRecord(manager, item);
  });
}

export function writePersonalMemoryRecordsQueued<T extends PersonalMemoryRecordFields>(items: T[]) {
  return queueDatabaseWrite(items.map((item) => ({
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
      item.id, item.userId, item.shared, item.scope, item.domain, item.type,
      item.key, item.status, JSON.stringify(item), item.createdAt, item.updatedAt,
    ],
  })));
}

export async function deletePersonalMemoryRecord(id: string, userId: string) {
  const existing = await queryDatabaseOne('SELECT id FROM personal_memory_item WHERE id = ? AND user_id = ?', [id, userId]);
  if (!existing) return false;
  await executeDatabase('DELETE FROM personal_memory_item WHERE id = ? AND user_id = ?', [id, userId]);
  return true;
}

export async function markPersonalMemoryRecordsUsed<T extends PersonalMemoryRecordFields & {
  lastUsedAt?: string;
  useCount: number;
}>(ids: string[], timestamp: string) {
  const normalizedIds = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean))).slice(0, 500);
  if (!normalizedIds.length) return [];
  return runDatabaseTransaction(async (manager) => {
    const rows = await queryDatabase<JsonRow>(`
      SELECT record_json FROM personal_memory_item
      WHERE id IN (${normalizedIds.map(() => '?').join(', ')})
    `, normalizedIds, manager);
    const items = rows.map((row) => parseDatabaseJson<T | undefined>(row.record_json, undefined))
      .filter((item): item is T => Boolean(item))
      .map((item) => ({
        ...item,
        lastUsedAt: timestamp,
        useCount: Math.max(0, Number(item.useCount) || 0) + 1,
      }));
    for (const item of items) await upsertPersonalMemoryRecord(manager, item);
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

async function readJsonRows<T>(sql: string, parameters: unknown[] = [], executor?: DatabaseExecutor) {
  const rows = await queryDatabase<JsonRow>(sql, parameters, executor);
  return rows.map((row) => parseDatabaseJson<T | undefined>(row.record_json, undefined))
    .filter((item): item is T => Boolean(item));
}

export function readBrowserChatLogs<T>(sessionId: string) {
  return readJsonRows<T>('SELECT record_json FROM browser_chat_log WHERE session_id = ? ORDER BY time ASC', [sessionId]);
}

function readBrowserChatMessages<T>(sessionId: string) {
  return readJsonRows<T>('SELECT record_json FROM browser_chat_message WHERE session_id = ? ORDER BY time ASC', [sessionId]);
}

function readBrowserChatSteps<T>(sessionId: string) {
  return readJsonRows<T>('SELECT record_json FROM browser_chat_step WHERE session_id = ? ORDER BY step_index ASC', [sessionId]);
}

export async function readBrowserChatSessionRecord<T extends { logs?: unknown[]; messages?: unknown[]; steps?: unknown[] }>(sessionId: string) {
  const row = await queryDatabaseOne<{ snapshot_json?: string }>('SELECT snapshot_json FROM browser_chat_session WHERE id = ?', [sessionId]);
  const snapshot = parseDatabaseJson<T | undefined>(row?.snapshot_json, undefined);
  if (!snapshot) return undefined;
  const [messages, steps, logs] = await Promise.all([
    readBrowserChatMessages(sessionId),
    readBrowserChatSteps(sessionId),
    readBrowserChatLogs(sessionId),
  ]);
  return { ...await hydrateBrowserChatContextSnapshot(sessionId, snapshot), messages, steps, logs };
}

export async function readBrowserChatSessionSummaries<T>(input: {
  beforeId?: string;
  beforeUpdatedAt?: string;
  hasMessagesOnly?: boolean;
  limit?: number;
  userId?: string;
} = {}) {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (input.userId) {
    clauses.push('user_id = ?');
    values.push(input.userId);
  }
  if (input.hasMessagesOnly) clauses.push(`EXISTS (
    SELECT 1 FROM browser_chat_message WHERE browser_chat_message.session_id = browser_chat_session.id
  )`);
  if (input.beforeUpdatedAt && input.beforeId) {
    clauses.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
    values.push(input.beforeUpdatedAt, input.beforeUpdatedAt, input.beforeId);
  }
  const limit = Number.isFinite(input.limit)
    ? Math.max(1, Math.min(501, Math.floor(Number(input.limit))))
    : undefined;
  if (limit) values.push(limit);
  const rows = await queryDatabase<{ summary_json?: string }>(`
    SELECT summary_json FROM browser_chat_session
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY updated_at DESC, id DESC
    ${limit ? 'LIMIT ?' : ''}
  `, values);
  return rows.map((row) => parseDatabaseJson<T | undefined>(row.summary_json, undefined))
    .filter((item): item is T => Boolean(item));
}

const sessionUpsertSql = `
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
`;

async function upsertSessionRows<
  TSnapshot extends BrowserChatSessionFields,
  TMessage extends { id: string; createdAt: string; updatedAt?: string },
  TStep extends { index: number },
  TLog extends { id: string; messageId?: string; time: string },
>(manager: EntityManager, snapshot: TSnapshot, summary: unknown, delta: {
  messages?: TMessage[];
  steps?: TStep[];
  logs?: TLog[];
  removedMessageIds?: string[];
  removedStepIndexes?: number[];
  removedLogIds?: string[];
}) {
  const contextWrite = splitBrowserChatContextSnapshot(snapshot.id, snapshot);
  await executeDatabase(sessionUpsertSql, [
    snapshot.id, snapshot.userId || null, snapshot.title, snapshot.status,
    JSON.stringify(contextWrite.snapshot), JSON.stringify(summary), snapshot.createdAt, snapshot.updatedAt,
  ], manager);
  for (const statement of contextWrite.statements) await executeDatabase(statement.sql, statement.params, manager);
  for (const message of delta.messages || []) await executeDatabase(`
    INSERT INTO browser_chat_message (session_id, id, time, record_json) VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id, id) DO UPDATE SET time = excluded.time, record_json = excluded.record_json
  `, [snapshot.id, message.id, message.updatedAt || message.createdAt, JSON.stringify(message)], manager);
  for (const step of delta.steps || []) await executeDatabase(`
    INSERT INTO browser_chat_step (session_id, step_index, record_json) VALUES (?, ?, ?)
    ON CONFLICT(session_id, step_index) DO UPDATE SET record_json = excluded.record_json
  `, [snapshot.id, step.index, JSON.stringify(step)], manager);
  for (const log of delta.logs || []) await executeDatabase(`
    INSERT INTO browser_chat_log (session_id, id, time, message_id, record_json) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id, id) DO UPDATE SET
      time = excluded.time, message_id = excluded.message_id, record_json = excluded.record_json
  `, [snapshot.id, log.id, log.time, log.messageId || null, JSON.stringify(log)], manager);
  for (const id of delta.removedMessageIds || []) await executeDatabase('DELETE FROM browser_chat_message WHERE session_id = ? AND id = ?', [snapshot.id, id], manager);
  for (const index of delta.removedStepIndexes || []) await executeDatabase('DELETE FROM browser_chat_step WHERE session_id = ? AND step_index = ?', [snapshot.id, index], manager);
  for (const id of delta.removedLogIds || []) await executeDatabase('DELETE FROM browser_chat_log WHERE session_id = ? AND id = ?', [snapshot.id, id], manager);
}

export async function writeBrowserChatSessionRecord<
  TSnapshot extends BrowserChatSessionFields,
  TMessage extends { id: string; createdAt: string; updatedAt?: string },
  TStep extends { index: number },
  TLog extends { id: string; messageId?: string; time: string },
>(snapshot: TSnapshot, summary: unknown, messages: TMessage[], steps: TStep[], logs: TLog[]) {
  await runDatabaseTransaction(async (manager) => {
    await upsertSessionRows(manager, snapshot, summary, { messages, steps, logs });
    await pruneBrowserChatRows(manager, 'browser_chat_message', 'id', snapshot.id, messages.map((message) => message.id));
    await pruneBrowserChatRows(manager, 'browser_chat_step', 'step_index', snapshot.id, steps.map((step) => step.index));
    await pruneBrowserChatRows(manager, 'browser_chat_log', 'id', snapshot.id, logs.map((log) => log.id));
  });
  markBrowserChatContextWritten(snapshot.id, snapshot);
}

type BrowserChatSessionDelta<
  TMessage extends { id: string; createdAt: string; updatedAt?: string },
  TStep extends { index: number },
  TLog extends { id: string; messageId?: string; time: string },
> = {
  messages?: TMessage[];
  steps?: TStep[];
  logs?: TLog[];
  removedMessageIds?: string[];
  removedStepIndexes?: number[];
  removedLogIds?: string[];
};

export function writeBrowserChatSessionDelta<
  TSnapshot extends BrowserChatSessionFields,
  TMessage extends { id: string; createdAt: string; updatedAt?: string },
  TStep extends { index: number },
  TLog extends { id: string; messageId?: string; time: string },
>(snapshot: TSnapshot, summary: unknown, delta: BrowserChatSessionDelta<TMessage, TStep, TLog>) {
  return runDatabaseTransaction((manager) => upsertSessionRows(manager, snapshot, summary, delta))
    .then(() => markBrowserChatContextWritten(snapshot.id, snapshot));
}

export async function readReferencedUploadPaths(userId?: string) {
  const prefix = userId ? `uploads/${userId}/` : 'uploads/';
  const rows = await queryDatabase<JsonRow>('SELECT record_json FROM browser_chat_message WHERE record_json LIKE ?', [`%${prefix}%`]);
  const paths = new Set<string>();
  for (const row of rows) {
    const message = parseDatabaseJson<{ attachments?: Array<{ path?: unknown }> }>(row.record_json, {});
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
  TLog extends { id: string; messageId?: string; time: string },
>(snapshot: TSnapshot, summary: unknown, delta: BrowserChatSessionDelta<TMessage, TStep, TLog>) {
  const contextWrite = splitBrowserChatContextSnapshot(snapshot.id, snapshot);
  const statements: DatabaseWriteStatement[] = [{
    sql: sessionUpsertSql,
    params: [
      snapshot.id, snapshot.userId || null, snapshot.title, snapshot.status,
      JSON.stringify(contextWrite.snapshot), JSON.stringify(summary), snapshot.createdAt, snapshot.updatedAt,
    ],
  }];
  statements.push(...contextWrite.statements);
  for (const message of delta.messages || []) statements.push({
    sql: `INSERT INTO browser_chat_message (session_id, id, time, record_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, id) DO UPDATE SET time = excluded.time, record_json = excluded.record_json`,
    params: [snapshot.id, message.id, message.updatedAt || message.createdAt, JSON.stringify(message)],
  });
  for (const step of delta.steps || []) statements.push({
    sql: `INSERT INTO browser_chat_step (session_id, step_index, record_json) VALUES (?, ?, ?)
      ON CONFLICT(session_id, step_index) DO UPDATE SET record_json = excluded.record_json`,
    params: [snapshot.id, step.index, JSON.stringify(step)],
  });
  for (const log of delta.logs || []) statements.push({
    sql: `INSERT INTO browser_chat_log (session_id, id, time, message_id, record_json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, id) DO UPDATE SET time = excluded.time, message_id = excluded.message_id, record_json = excluded.record_json`,
    params: [snapshot.id, log.id, log.time, log.messageId || null, JSON.stringify(log)],
  });
  for (const id of delta.removedMessageIds || []) statements.push({ sql: 'DELETE FROM browser_chat_message WHERE session_id = ? AND id = ?', params: [snapshot.id, id] });
  for (const index of delta.removedStepIndexes || []) statements.push({ sql: 'DELETE FROM browser_chat_step WHERE session_id = ? AND step_index = ?', params: [snapshot.id, index] });
  for (const id of delta.removedLogIds || []) statements.push({ sql: 'DELETE FROM browser_chat_log WHERE session_id = ? AND id = ?', params: [snapshot.id, id] });
  return queueDatabaseWrite(statements).then(() => markBrowserChatContextWritten(snapshot.id, snapshot));
}

async function pruneBrowserChatRows(
  executor: DatabaseExecutor,
  table: 'browser_chat_message' | 'browser_chat_step' | 'browser_chat_log',
  key: 'id' | 'step_index',
  sessionId: string,
  retainedKeys: Array<string | number>,
) {
  if (!retainedKeys.length) {
    await executeDatabase(`DELETE FROM ${table} WHERE session_id = ?`, [sessionId], executor);
    return;
  }
  await executeDatabase(
    `DELETE FROM ${table} WHERE session_id = ? AND ${key} NOT IN (${retainedKeys.map(() => '?').join(', ')})`,
    [sessionId, ...retainedKeys],
    executor,
  );
}

export function deleteBrowserChatSessionRecordQueued(sessionId: string) {
  return queueDatabaseWrite([
    { sql: 'DELETE FROM browser_code_runtime_state WHERE session_id = ?', params: [sessionId] },
    { sql: 'DELETE FROM browser_chat_session WHERE id = ?', params: [sessionId] },
  ]);
}
