import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  automationCaseRecordSchema,
  automationRunRecordSchema,
  automationScheduleRecordSchema,
  type AutomationCaseRecord,
  type AutomationRunLogEntry,
  type AutomationRunRecord,
  type AutomationRunStatus,
  type AutomationScheduleRecord,
  type CreateAutomationCaseInput,
  type CreateAutomationRunInput,
  type CreateAutomationScheduleInput,
  type UpdateAutomationCaseInput,
  type UpdateAutomationRunInput,
  type UpdateAutomationScheduleInput,
} from '@/server/automation/automation.schema';
import { getSqliteDatabase, parseSqliteJson, runSqliteTransaction } from '@/server/storage/sqlite-database';
import { publishRealtimeRefreshEvent, type RefreshEntityType } from '@/server/realtime/ws-refresh';

type JsonRow = { record_json: string };

const terminalRunStatuses = new Set<AutomationRunStatus>([
  'completed',
  'passed',
  'failed',
  'blocked',
  'cancelled',
  'skipped',
]);

function now() {
  return new Date().toISOString();
}

function newId(prefix: 'case' | 'run' | 'schedule') {
  return `automation_${prefix}_${randomUUID()}`;
}

function publishAutomationRecord(
  entityType: Extract<RefreshEntityType, 'automationCase' | 'automationRun' | 'automationSchedule'>,
  record: AutomationCaseRecord | AutomationRunRecord | AutomationScheduleRecord,
  deleted = false,
) {
  void publishRealtimeRefreshEvent({
    entityType,
    id: record.id,
    userId: record.userId,
    updatedAt: record.updatedAt,
    ...(deleted ? { deleted: true } : { patch: record }),
  }).catch(() => undefined);
}

function normalizedLimit(value: number | undefined, fallback = 100) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(value || fallback)));
}

function definedValues<T extends object>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function parseCaseRow(row: JsonRow | undefined) {
  if (!row) return undefined;
  const parsed = automationCaseRecordSchema.safeParse(
    parseSqliteJson<unknown>(row.record_json, undefined),
  );
  return parsed.success ? parsed.data : undefined;
}

function parseRunRow(row: JsonRow | undefined) {
  if (!row) return undefined;
  const parsed = automationRunRecordSchema.safeParse(
    parseSqliteJson<unknown>(row.record_json, undefined),
  );
  return parsed.success ? parsed.data : undefined;
}

function parseScheduleRow(row: JsonRow | undefined) {
  if (!row) return undefined;
  const parsed = automationScheduleRecordSchema.safeParse(
    parseSqliteJson<unknown>(row.record_json, undefined),
  );
  return parsed.success ? parsed.data : undefined;
}

function readCase(database: DatabaseSync, id: string, userId?: string) {
  const row = (userId === undefined
    ? database.prepare('SELECT record_json FROM automation_case WHERE id = ?').get(id)
    : database.prepare('SELECT record_json FROM automation_case WHERE id = ? AND user_id = ?').get(id, userId)
  ) as JsonRow | undefined;
  return parseCaseRow(row);
}

function readRun(database: DatabaseSync, id: string, userId?: string) {
  const row = (userId === undefined
    ? database.prepare('SELECT record_json FROM automation_run WHERE id = ?').get(id)
    : database.prepare('SELECT record_json FROM automation_run WHERE id = ? AND user_id = ?').get(id, userId)
  ) as JsonRow | undefined;
  return parseRunRow(row);
}

function readSchedule(database: DatabaseSync, id: string, userId?: string) {
  const row = (userId === undefined
    ? database.prepare('SELECT record_json FROM automation_schedule WHERE id = ?').get(id)
    : database.prepare('SELECT record_json FROM automation_schedule WHERE id = ? AND user_id = ?').get(id, userId)
  ) as JsonRow | undefined;
  return parseScheduleRow(row);
}

function ensureCaseOwner(database: DatabaseSync, caseId: string, userId: string) {
  if (!readCase(database, caseId, userId)) {
    throw new Error(`Automation case ${caseId} was not found for this user.`);
  }
}

function insertRun(database: DatabaseSync, record: AutomationRunRecord) {
  database.prepare(`
    INSERT INTO automation_run (
      id, user_id, case_id, schedule_id, occurrence_key, trigger, status,
      lease_expires_at, record_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.userId,
    record.caseId,
    record.scheduleId || null,
    record.occurrenceKey || null,
    record.trigger,
    record.status,
    record.lease?.expiresAt || null,
    JSON.stringify(record),
    record.createdAt,
    record.updatedAt,
  );
}

function persistRun(database: DatabaseSync, record: AutomationRunRecord) {
  database.prepare(`
    UPDATE automation_run SET
      schedule_id = ?, occurrence_key = ?, trigger = ?, status = ?, lease_expires_at = ?,
      record_json = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(
    record.scheduleId || null,
    record.occurrenceKey || null,
    record.trigger,
    record.status,
    record.lease?.expiresAt || null,
    JSON.stringify(record),
    record.updatedAt,
    record.id,
    record.userId,
  );
}

function persistSchedule(database: DatabaseSync, record: AutomationScheduleRecord) {
  database.prepare(`
    UPDATE automation_schedule SET
      case_id = ?, title = ?, recurrence = ?, enabled = ?, next_run_at = ?,
      record_json = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(
    record.caseId,
    record.title,
    record.recurrence,
    record.enabled ? 1 : 0,
    record.nextRunAt,
    JSON.stringify(record),
    record.updatedAt,
    record.id,
    record.userId,
  );
}

export type AutomationCaseListOptions = {
  userId?: string;
  sourceSessionId?: string;
  limit?: number;
};

export function listAutomationCases(options: AutomationCaseListOptions = {}) {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (options.userId !== undefined) {
    clauses.push('user_id = ?');
    values.push(options.userId);
  }
  if (options.sourceSessionId !== undefined) {
    clauses.push('source_session_id = ?');
    values.push(options.sourceSessionId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = getSqliteDatabase().prepare(`
    SELECT record_json FROM automation_case
    ${where}
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(...values, normalizedLimit(options.limit)) as JsonRow[];
  return rows.map(parseCaseRow).filter((record): record is AutomationCaseRecord => Boolean(record));
}

export function getAutomationCase(id: string, userId?: string) {
  return readCase(getSqliteDatabase(), id, userId);
}

export function createAutomationCase(input: CreateAutomationCaseInput) {
  const timestamp = now();
  const record = automationCaseRecordSchema.parse({
    ...input,
    id: input.id || newId('case'),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  getSqliteDatabase().prepare(`
    INSERT INTO automation_case (
      id, user_id, source_session_id, title, target_url, mode, record_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.userId,
    record.sourceSessionId,
    record.title,
    record.targetUrl,
    record.mode,
    JSON.stringify(record),
    record.createdAt,
    record.updatedAt,
  );
  publishAutomationRecord('automationCase', record);
  return record;
}

export function updateAutomationCase(id: string, patch: UpdateAutomationCaseInput, userId?: string) {
  const record = runSqliteTransaction((database) => {
    const current = readCase(database, id, userId);
    if (!current) return undefined;
    const record = automationCaseRecordSchema.parse({
      ...current,
      ...definedValues(patch),
      id: current.id,
      userId: current.userId,
      createdAt: current.createdAt,
      updatedAt: now(),
    });
    database.prepare(`
      UPDATE automation_case SET
        source_session_id = ?, title = ?, target_url = ?, mode = ?, record_json = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(
      record.sourceSessionId,
      record.title,
      record.targetUrl,
      record.mode,
      JSON.stringify(record),
      record.updatedAt,
      record.id,
      record.userId,
    );
    return record;
  });
  if (record) publishAutomationRecord('automationCase', record);
  return record;
}

export function deleteAutomationCase(id: string, userId?: string) {
  const record = readCase(getSqliteDatabase(), id, userId);
  const statement = userId === undefined
    ? getSqliteDatabase().prepare('DELETE FROM automation_case WHERE id = ?')
    : getSqliteDatabase().prepare('DELETE FROM automation_case WHERE id = ? AND user_id = ?');
  const result = userId === undefined ? statement.run(id) : statement.run(id, userId);
  const deleted = Number(result.changes) > 0;
  if (deleted && record) publishAutomationRecord('automationCase', record, true);
  return deleted;
}

export type AutomationRunListOptions = {
  userId?: string;
  caseId?: string;
  scheduleId?: string;
  status?: AutomationRunStatus;
  limit?: number;
};

export function listAutomationRuns(options: AutomationRunListOptions = {}) {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  for (const [column, value] of [
    ['user_id', options.userId],
    ['case_id', options.caseId],
    ['schedule_id', options.scheduleId],
    ['status', options.status],
  ] as const) {
    if (value !== undefined) {
      clauses.push(`${column} = ?`);
      values.push(value);
    }
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = getSqliteDatabase().prepare(`
    SELECT record_json FROM automation_run
    ${where}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...values, normalizedLimit(options.limit)) as JsonRow[];
  return rows.map(parseRunRow).filter((record): record is AutomationRunRecord => Boolean(record));
}

export function getAutomationRun(id: string, userId?: string) {
  return readRun(getSqliteDatabase(), id, userId);
}

export function createAutomationRun(input: CreateAutomationRunInput) {
  const record = runSqliteTransaction((database) => {
    ensureCaseOwner(database, input.caseId, input.userId);
    const timestamp = now();
    const status = input.status || 'queued';
    const record = automationRunRecordSchema.parse({
      ...input,
      id: input.id || newId('run'),
      status,
      steps: input.steps || [],
      log: input.log || [],
      startedAt: input.startedAt || (status === 'running' ? timestamp : undefined),
      finishedAt: input.finishedAt || (terminalRunStatuses.has(status) ? timestamp : undefined),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    insertRun(database, record);
    return record;
  });
  publishAutomationRecord('automationRun', record);
  return record;
}

function automationRunWithPatch(
  current: AutomationRunRecord,
  patch: UpdateAutomationRunInput,
) {
  const {
    appendLog,
    error,
    lease,
    startedAt,
    finishedAt,
    ...ordinaryPatch
  } = patch;
  const timestamp = now();
  const candidate: Record<string, unknown> = {
    ...current,
    ...definedValues(ordinaryPatch),
    log: patch.log || current.log,
    id: current.id,
    userId: current.userId,
    caseId: current.caseId,
    createdAt: current.createdAt,
    updatedAt: timestamp,
  };
  if (appendLog?.length) candidate.log = [...(candidate.log as AutomationRunLogEntry[]), ...appendLog];
  if (error === null) delete candidate.error;
  else if (error !== undefined) candidate.error = error;
  if (lease === null) delete candidate.lease;
  else if (lease !== undefined) candidate.lease = lease;
  if (startedAt === null) delete candidate.startedAt;
  else if (startedAt !== undefined) candidate.startedAt = startedAt;
  if (finishedAt === null) delete candidate.finishedAt;
  else if (finishedAt !== undefined) candidate.finishedAt = finishedAt;
  if (candidate.status === 'running' && !candidate.startedAt) candidate.startedAt = timestamp;
  if (terminalRunStatuses.has(candidate.status as AutomationRunStatus) && !candidate.finishedAt) {
    candidate.finishedAt = timestamp;
  }
  return automationRunRecordSchema.parse(candidate);
}

export function updateAutomationRun(id: string, patch: UpdateAutomationRunInput, userId?: string) {
  const record = runSqliteTransaction((database) => {
    const current = readRun(database, id, userId);
    if (!current) return undefined;
    const record = automationRunWithPatch(current, patch);
    persistRun(database, record);
    return record;
  });
  if (record) publishAutomationRecord('automationRun', record);
  return record;
}

/** Atomically update a run only while it is in one of the expected states. */
export function updateAutomationRunIfStatus(
  id: string,
  expectedStatuses: AutomationRunStatus[],
  patch: UpdateAutomationRunInput,
  userId?: string,
  expectedLeaseOwner?: string,
) {
  const result = runSqliteTransaction((database) => {
    const current = readRun(database, id, userId);
    if (!current) return undefined;
    if (
      !expectedStatuses.includes(current.status)
      || (expectedLeaseOwner !== undefined && current.lease?.owner !== expectedLeaseOwner)
    ) {
      return { updated: false, run: current };
    }
    const record = automationRunWithPatch(current, patch);
    persistRun(database, record);
    return { updated: true, run: record };
  });
  if (result?.updated) publishAutomationRecord('automationRun', result.run);
  return result;
}

export function deleteAutomationRun(id: string, userId?: string) {
  const record = readRun(getSqliteDatabase(), id, userId);
  const statement = userId === undefined
    ? getSqliteDatabase().prepare('DELETE FROM automation_run WHERE id = ?')
    : getSqliteDatabase().prepare('DELETE FROM automation_run WHERE id = ? AND user_id = ?');
  const result = userId === undefined ? statement.run(id) : statement.run(id, userId);
  const deleted = Number(result.changes) > 0;
  if (deleted && record) publishAutomationRecord('automationRun', record, true);
  return deleted;
}

export function claimAutomationRunLease(
  runId: string,
  owner: string,
  ttlMs: number,
  userId?: string,
) {
  if (!owner.trim()) throw new Error('A lease owner is required.');
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('Lease TTL must be greater than zero.');
  const record = runSqliteTransaction((database) => {
    const current = readRun(database, runId, userId);
    if (!current || terminalRunStatuses.has(current.status)) return undefined;
    const timestamp = now();
    if (
      current.lease
      && current.lease.owner !== owner
      && Date.parse(current.lease.expiresAt) > Date.parse(timestamp)
    ) {
      return undefined;
    }
    const record = automationRunRecordSchema.parse({
      ...current,
      lease: {
        owner,
        acquiredAt: current.lease?.owner === owner ? current.lease.acquiredAt : timestamp,
        heartbeatAt: timestamp,
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      },
      updatedAt: timestamp,
    });
    persistRun(database, record);
    return record;
  });
  if (record) publishAutomationRecord('automationRun', record);
  return record;
}

export function releaseAutomationRunLease(runId: string, owner: string, userId?: string) {
  const record = runSqliteTransaction((database) => {
    const current = readRun(database, runId, userId);
    if (!current?.lease || current.lease.owner !== owner) return undefined;
    const withoutLease: Partial<AutomationRunRecord> = { ...current };
    delete withoutLease.lease;
    const record = automationRunRecordSchema.parse({ ...withoutLease, updatedAt: now() });
    persistRun(database, record);
    return record;
  });
  if (record) publishAutomationRecord('automationRun', record);
  return record;
}

export type AutomationScheduleListOptions = {
  userId?: string;
  caseId?: string;
  enabled?: boolean;
  limit?: number;
};

export function listAutomationSchedules(options: AutomationScheduleListOptions = {}) {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (options.userId !== undefined) {
    clauses.push('user_id = ?');
    values.push(options.userId);
  }
  if (options.caseId !== undefined) {
    clauses.push('case_id = ?');
    values.push(options.caseId);
  }
  if (options.enabled !== undefined) {
    clauses.push('enabled = ?');
    values.push(options.enabled ? 1 : 0);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = getSqliteDatabase().prepare(`
    SELECT record_json FROM automation_schedule
    ${where}
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(...values, normalizedLimit(options.limit)) as JsonRow[];
  return rows.map(parseScheduleRow).filter((record): record is AutomationScheduleRecord => Boolean(record));
}

export function getAutomationSchedule(id: string, userId?: string) {
  return readSchedule(getSqliteDatabase(), id, userId);
}

export function createAutomationSchedule(input: CreateAutomationScheduleInput) {
  const record = runSqliteTransaction((database) => {
    ensureCaseOwner(database, input.caseId, input.userId);
    const timestamp = now();
    const record = automationScheduleRecordSchema.parse({
      ...input,
      id: input.id || newId('schedule'),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    database.prepare(`
      INSERT INTO automation_schedule (
        id, user_id, case_id, title, recurrence, enabled, next_run_at,
        record_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.userId,
      record.caseId,
      record.title,
      record.recurrence,
      record.enabled ? 1 : 0,
      record.nextRunAt,
      JSON.stringify(record),
      record.createdAt,
      record.updatedAt,
    );
    return record;
  });
  publishAutomationRecord('automationSchedule', record);
  return record;
}

export function updateAutomationSchedule(
  id: string,
  patch: UpdateAutomationScheduleInput,
  userId?: string,
) {
  const record = runSqliteTransaction((database) => {
    const current = readSchedule(database, id, userId);
    if (!current) return undefined;
    if (patch.caseId && patch.caseId !== current.caseId) {
      ensureCaseOwner(database, patch.caseId, current.userId);
    }
    const { lastRunAt, ...ordinaryPatch } = patch;
    const candidate: Record<string, unknown> = {
      ...current,
      ...definedValues(ordinaryPatch),
      id: current.id,
      userId: current.userId,
      createdAt: current.createdAt,
      updatedAt: now(),
    };
    if (lastRunAt === null) delete candidate.lastRunAt;
    else if (lastRunAt !== undefined) candidate.lastRunAt = lastRunAt;
    const record = automationScheduleRecordSchema.parse(candidate);
    persistSchedule(database, record);
    return record;
  });
  if (record) publishAutomationRecord('automationSchedule', record);
  return record;
}

export function deleteAutomationSchedule(id: string, userId?: string) {
  const record = readSchedule(getSqliteDatabase(), id, userId);
  const statement = userId === undefined
    ? getSqliteDatabase().prepare('DELETE FROM automation_schedule WHERE id = ?')
    : getSqliteDatabase().prepare('DELETE FROM automation_schedule WHERE id = ? AND user_id = ?');
  const result = userId === undefined ? statement.run(id) : statement.run(id, userId);
  const deleted = Number(result.changes) > 0;
  if (deleted && record) publishAutomationRecord('automationSchedule', record, true);
  return deleted;
}

export type DueAutomationScheduleOptions = {
  at?: string;
  userId?: string;
  limit?: number;
};

export function listDueAutomationSchedules(options: DueAutomationScheduleOptions = {}) {
  const dueAt = options.at || now();
  const rows = (options.userId === undefined
    ? getSqliteDatabase().prepare(`
        SELECT record_json FROM automation_schedule
        WHERE enabled = 1 AND next_run_at <= ?
        ORDER BY next_run_at ASC
        LIMIT ?
      `).all(dueAt, normalizedLimit(options.limit))
    : getSqliteDatabase().prepare(`
        SELECT record_json FROM automation_schedule
        WHERE enabled = 1 AND next_run_at <= ? AND user_id = ?
        ORDER BY next_run_at ASC
        LIMIT ?
      `).all(dueAt, options.userId, normalizedLimit(options.limit))
  ) as JsonRow[];
  return rows.map(parseScheduleRow).filter((record): record is AutomationScheduleRecord => Boolean(record));
}

export type CreateAutomationScheduleOccurrenceInput = {
  scheduleId: string;
  nextRunAt: string;
  expectedNextRunAt?: string;
  triggeredAt?: string;
  runId?: string;
  userId?: string;
  status?: AutomationRunStatus;
  log?: AutomationRunLogEntry[];
  error?: string;
  misfired?: boolean;
};

export type CreateAutomationScheduleOccurrenceResult = {
  created: boolean;
  schedule: AutomationScheduleRecord;
  run?: AutomationRunRecord;
  reason?: 'disabled' | 'stale' | 'duplicate';
};

export function createAutomationScheduleOccurrence(
  input: CreateAutomationScheduleOccurrenceInput,
): CreateAutomationScheduleOccurrenceResult | undefined {
  const occurrence = runSqliteTransaction<CreateAutomationScheduleOccurrenceResult | undefined>((database) => {
    const schedule = readSchedule(database, input.scheduleId, input.userId);
    if (!schedule) return undefined;
    const occurrenceAt = input.expectedNextRunAt || schedule.nextRunAt;
    const existing = parseRunRow(database.prepare(`
      SELECT record_json FROM automation_run
      WHERE schedule_id = ? AND occurrence_key = ?
    `).get(schedule.id, occurrenceAt) as JsonRow | undefined);
    if (existing) return { created: false, schedule, run: existing, reason: 'duplicate' };
    if (!schedule.enabled) return { created: false, schedule, reason: 'disabled' };
    if (schedule.nextRunAt !== occurrenceAt) return { created: false, schedule, reason: 'stale' };

    const timestamp = input.triggeredAt || now();
    const overlapping = schedule.overlap === 'skip' && Boolean(database.prepare(`
      SELECT 1 FROM automation_run
      WHERE schedule_id = ? AND status IN ('queued', 'running')
      LIMIT 1
    `).get(schedule.id));
    const skipped = overlapping || (input.misfired === true && schedule.misfire === 'skip');
    const status = skipped ? 'skipped' : (input.status || 'queued');
    const error = input.error || (overlapping
      ? 'Skipped because a previous occurrence is still active.'
      : skipped ? 'Skipped by the schedule misfire policy.' : undefined);
    const run = automationRunRecordSchema.parse({
      id: input.runId || newId('run'),
      userId: schedule.userId,
      caseId: schedule.caseId,
      scheduleId: schedule.id,
      occurrenceKey: occurrenceAt,
      trigger: 'schedule',
      status,
      steps: [],
      log: input.log || [],
      error,
      startedAt: status === 'running' ? timestamp : undefined,
      finishedAt: terminalRunStatuses.has(status) ? timestamp : undefined,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const advancedSchedule = automationScheduleRecordSchema.parse({
      ...schedule,
      lastRunAt: timestamp,
      nextRunAt: input.nextRunAt,
      updatedAt: timestamp,
    });
    insertRun(database, run);
    const result = database.prepare(`
      UPDATE automation_schedule SET
        next_run_at = ?, record_json = ?, updated_at = ?
      WHERE id = ? AND enabled = 1 AND next_run_at = ?
    `).run(
      advancedSchedule.nextRunAt,
      JSON.stringify(advancedSchedule),
      advancedSchedule.updatedAt,
      advancedSchedule.id,
      occurrenceAt,
    );
    if (Number(result.changes) !== 1) {
      throw new Error(`Automation schedule ${schedule.id} changed while creating its occurrence.`);
    }
    return { created: true, schedule: advancedSchedule, run };
  });
  if (occurrence?.created && occurrence.run) {
    publishAutomationRecord('automationRun', occurrence.run);
    publishAutomationRecord('automationSchedule', occurrence.schedule);
  }
  return occurrence;
}
