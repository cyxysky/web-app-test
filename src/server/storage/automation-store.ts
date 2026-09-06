import { randomUUID } from 'node:crypto';
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
  type UpdateAutomationRunInput,
  type UpdateAutomationCaseInput,
} from '@/server/automation/automation.schema';
import {
  executeDatabase,
  getDatabase,
  parseDatabaseJson,
  queryDatabase,
  queryDatabaseOne,
  runDatabaseTransaction,
  type DatabaseExecutor,
} from '@/server/db/database';
import { publishRealtimeRefreshEvent, type RefreshEntityType } from '@/server/realtime/ws-refresh';
import { automationTaskGuidance } from '@/server/automation/automation-task';

type JsonRow = { record_json: string };

const terminalRunStatuses = new Set<AutomationRunStatus>([
  'completed', 'passed', 'failed', 'blocked', 'cancelled', 'skipped',
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
    entityType, id: record.id, userId: record.userId, updatedAt: record.updatedAt,
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

function parseCaseRow(row?: JsonRow): AutomationCaseRecord | undefined {
  if (!row) return undefined;
  const parsed = automationCaseRecordSchema.safeParse(parseDatabaseJson<unknown>(row.record_json, undefined));
  return parsed.success ? { ...parsed.data, guidance: automationTaskGuidance(parsed.data) } : undefined;
}

function parseRunRow(row?: JsonRow) {
  if (!row) return undefined;
  const parsed = automationRunRecordSchema.safeParse(parseDatabaseJson<unknown>(row.record_json, undefined));
  return parsed.success ? parsed.data : undefined;
}

function parseScheduleRow(row?: JsonRow) {
  if (!row) return undefined;
  const parsed = automationScheduleRecordSchema.safeParse(parseDatabaseJson<unknown>(row.record_json, undefined));
  return parsed.success ? parsed.data : undefined;
}

async function readCase(executor: DatabaseExecutor, id: string, userId?: string) {
  const row = userId === undefined
    ? await queryDatabaseOne<JsonRow>('SELECT record_json FROM automation_case WHERE id = ?', [id], executor)
    : await queryDatabaseOne<JsonRow>('SELECT record_json FROM automation_case WHERE id = ? AND user_id = ?', [id, userId], executor);
  return parseCaseRow(row);
}

async function readRun(executor: DatabaseExecutor, id: string, userId?: string) {
  const row = userId === undefined
    ? await queryDatabaseOne<JsonRow>('SELECT record_json FROM automation_run WHERE id = ?', [id], executor)
    : await queryDatabaseOne<JsonRow>('SELECT record_json FROM automation_run WHERE id = ? AND user_id = ?', [id, userId], executor);
  return parseRunRow(row);
}

async function readSchedule(executor: DatabaseExecutor, id: string, userId?: string) {
  const row = userId === undefined
    ? await queryDatabaseOne<JsonRow>('SELECT record_json FROM automation_schedule WHERE id = ?', [id], executor)
    : await queryDatabaseOne<JsonRow>('SELECT record_json FROM automation_schedule WHERE id = ? AND user_id = ?', [id, userId], executor);
  return parseScheduleRow(row);
}

async function ensureCaseOwner(executor: DatabaseExecutor, caseId: string, userId: string) {
  if (!await readCase(executor, caseId, userId)) {
    throw new Error(`Automation case ${caseId} was not found for this user.`);
  }
}

async function insertRun(executor: DatabaseExecutor, record: AutomationRunRecord) {
  await executeDatabase(`
    INSERT INTO automation_run (
      id, user_id, case_id, schedule_id, occurrence_key, trigger, status,
      lease_expires_at, record_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [record.id, record.userId, record.caseId, record.scheduleId || null,
    record.occurrenceKey || null, record.trigger, record.status, record.lease?.expiresAt || null,
    JSON.stringify(record), record.createdAt, record.updatedAt], executor);
}

async function persistRun(executor: DatabaseExecutor, record: AutomationRunRecord) {
  await executeDatabase(`
    UPDATE automation_run SET schedule_id = ?, occurrence_key = ?, trigger = ?, status = ?,
      lease_expires_at = ?, record_json = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `, [record.scheduleId || null, record.occurrenceKey || null, record.trigger, record.status,
    record.lease?.expiresAt || null, JSON.stringify(record), record.updatedAt, record.id, record.userId], executor);
}

export type AutomationCaseListOptions = {
  beforeId?: string; beforeUpdatedAt?: string; userId?: string; sourceSessionId?: string; limit?: number;
};

export async function listAutomationCases(options: AutomationCaseListOptions = {}) {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (options.userId !== undefined) { clauses.push('user_id = ?'); values.push(options.userId); }
  if (options.sourceSessionId !== undefined) { clauses.push('source_session_id = ?'); values.push(options.sourceSessionId); }
  if (options.beforeUpdatedAt && options.beforeId) {
    clauses.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
    values.push(options.beforeUpdatedAt, options.beforeUpdatedAt, options.beforeId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await queryDatabase<JsonRow>(`
    SELECT record_json FROM automation_case ${where}
    ORDER BY updated_at DESC, id DESC LIMIT ?
  `, [...values, normalizedLimit(options.limit)]);
  return rows.map(parseCaseRow).filter((record): record is AutomationCaseRecord => Boolean(record));
}

export async function getAutomationCase(id: string, userId?: string) {
  return readCase(await getDatabase(), id, userId);
}

export async function createAutomationCase(input: CreateAutomationCaseInput) {
  const timestamp = now();
  const record = automationCaseRecordSchema.parse({
    ...input, id: input.id || newId('case'), createdAt: timestamp, updatedAt: timestamp,
  });
  await executeDatabase(`
    INSERT INTO automation_case (
      id, user_id, source_session_id, title, target_url, record_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [record.id, record.userId, record.sourceSessionId, record.title, record.targetUrl,
    JSON.stringify(record), record.createdAt, record.updatedAt]);
  publishAutomationRecord('automationCase', record);
  return record;
}

export async function updateAutomationCase(id: string, userId: string, patch: UpdateAutomationCaseInput) {
  const record = await runDatabaseTransaction(async (manager) => {
    const current = await readCase(manager, id, userId);
    if (!current) return undefined;
    const next = automationCaseRecordSchema.parse({
      ...current, ...definedValues(patch),
      targetUrl: patch.targetUrl === '' ? 'about:blank' : patch.targetUrl ?? current.targetUrl,
      updatedAt: now(),
    });
    await executeDatabase(`
      UPDATE automation_case SET title = ?, target_url = ?, record_json = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `, [next.title, next.targetUrl, JSON.stringify(next), next.updatedAt, id, userId], manager);
    return next;
  });
  if (record) publishAutomationRecord('automationCase', record);
  return record;
}

export async function deleteAutomationCase(id: string, userId?: string) {
  const record = await runDatabaseTransaction(async (manager) => {
    const current = await readCase(manager, id, userId);
    if (!current) return undefined;
    const rows = userId === undefined
      ? await queryDatabase<{ id: string }>('DELETE FROM automation_case WHERE id = ? RETURNING id', [id], manager)
      : await queryDatabase<{ id: string }>('DELETE FROM automation_case WHERE id = ? AND user_id = ? RETURNING id', [id, userId], manager);
    return rows.length ? current : undefined;
  });
  if (record) publishAutomationRecord('automationCase', record, true);
  return Boolean(record);
}

export type AutomationRunListOptions = {
  userId?: string; caseId?: string; scheduleId?: string; status?: AutomationRunStatus; limit?: number;
};

export async function listAutomationRuns(options: AutomationRunListOptions = {}) {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  for (const [column, value] of [
    ['user_id', options.userId], ['case_id', options.caseId],
    ['schedule_id', options.scheduleId], ['status', options.status],
  ] as const) {
    if (value !== undefined) { clauses.push(`${column} = ?`); values.push(value); }
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await queryDatabase<JsonRow>(`
    SELECT record_json FROM automation_run ${where}
    ORDER BY created_at DESC LIMIT ?
  `, [...values, normalizedLimit(options.limit)]);
  return rows.map(parseRunRow).filter((record): record is AutomationRunRecord => Boolean(record));
}

export async function getAutomationRun(id: string, userId?: string) {
  return readRun(await getDatabase(), id, userId);
}

export async function createAutomationRun(input: CreateAutomationRunInput) {
  const record = await runDatabaseTransaction(async (manager) => {
    await ensureCaseOwner(manager, input.caseId, input.userId);
    const timestamp = now();
    const status = input.status || 'queued';
    const next = automationRunRecordSchema.parse({
      ...input, id: input.id || newId('run'), status, steps: input.steps || [], log: input.log || [],
      startedAt: input.startedAt || (status === 'running' ? timestamp : undefined),
      finishedAt: input.finishedAt || (terminalRunStatuses.has(status) ? timestamp : undefined),
      createdAt: timestamp, updatedAt: timestamp,
    });
    await insertRun(manager, next);
    return next;
  });
  publishAutomationRecord('automationRun', record);
  return record;
}

function automationRunWithPatch(current: AutomationRunRecord, patch: UpdateAutomationRunInput) {
  const { appendLog, error, lease, startedAt, finishedAt, ...ordinaryPatch } = patch;
  const timestamp = now();
  const candidate: Record<string, unknown> = {
    ...current, ...definedValues(ordinaryPatch), log: patch.log || current.log,
    id: current.id, userId: current.userId, caseId: current.caseId,
    createdAt: current.createdAt, updatedAt: timestamp,
  };
  if (appendLog?.length) candidate.log = [...(candidate.log as AutomationRunLogEntry[]), ...appendLog];
  if (error === null) delete candidate.error; else if (error !== undefined) candidate.error = error;
  if (lease === null) delete candidate.lease; else if (lease !== undefined) candidate.lease = lease;
  if (startedAt === null) delete candidate.startedAt; else if (startedAt !== undefined) candidate.startedAt = startedAt;
  if (finishedAt === null) delete candidate.finishedAt; else if (finishedAt !== undefined) candidate.finishedAt = finishedAt;
  if (candidate.status === 'running' && !candidate.startedAt) candidate.startedAt = timestamp;
  if (terminalRunStatuses.has(candidate.status as AutomationRunStatus) && !candidate.finishedAt) candidate.finishedAt = timestamp;
  return automationRunRecordSchema.parse(candidate);
}

export async function updateAutomationRunIfStatus(
  id: string,
  expectedStatuses: AutomationRunStatus[],
  patch: UpdateAutomationRunInput,
  userId?: string,
  expectedLeaseOwner?: string,
) {
  const result = await runDatabaseTransaction(async (manager) => {
    const current = await readRun(manager, id, userId);
    if (!current) return undefined;
    if (!expectedStatuses.includes(current.status)
      || (expectedLeaseOwner !== undefined && current.lease?.owner !== expectedLeaseOwner)) {
      return { updated: false, run: current };
    }
    const record = automationRunWithPatch(current, patch);
    await persistRun(manager, record);
    return { updated: true, run: record };
  });
  if (result?.updated) publishAutomationRecord('automationRun', result.run);
  return result;
}

export async function claimAutomationRunLease(runId: string, owner: string, ttlMs: number, userId?: string) {
  if (!owner.trim()) throw new Error('A lease owner is required.');
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('Lease TTL must be greater than zero.');
  const record = await runDatabaseTransaction(async (manager) => {
    const current = await readRun(manager, runId, userId);
    if (!current || terminalRunStatuses.has(current.status)) return undefined;
    const timestamp = now();
    if (current.lease && current.lease.owner !== owner
      && Date.parse(current.lease.expiresAt) > Date.parse(timestamp)) return undefined;
    const next = automationRunRecordSchema.parse({
      ...current,
      lease: {
        owner,
        acquiredAt: current.lease?.owner === owner ? current.lease.acquiredAt : timestamp,
        heartbeatAt: timestamp,
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      },
      updatedAt: timestamp,
    });
    await persistRun(manager, next);
    return next;
  });
  if (record) publishAutomationRecord('automationRun', record);
  return record;
}

export async function releaseAutomationRunLease(runId: string, owner: string, userId?: string) {
  const record = await runDatabaseTransaction(async (manager) => {
    const current = await readRun(manager, runId, userId);
    if (!current?.lease || current.lease.owner !== owner) return undefined;
    const withoutLease: Partial<AutomationRunRecord> = { ...current };
    delete withoutLease.lease;
    const next = automationRunRecordSchema.parse({ ...withoutLease, updatedAt: now() });
    await persistRun(manager, next);
    return next;
  });
  if (record) publishAutomationRecord('automationRun', record);
  return record;
}

export type AutomationScheduleListOptions = { userId?: string; caseId?: string; enabled?: boolean; limit?: number };

export async function listAutomationSchedules(options: AutomationScheduleListOptions = {}) {
  const clauses: string[] = [];
  const values: Array<string | number | boolean> = [];
  if (options.userId !== undefined) { clauses.push('user_id = ?'); values.push(options.userId); }
  if (options.caseId !== undefined) { clauses.push('case_id = ?'); values.push(options.caseId); }
  if (options.enabled !== undefined) { clauses.push('enabled = ?'); values.push(options.enabled); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await queryDatabase<JsonRow>(`
    SELECT record_json FROM automation_schedule ${where}
    ORDER BY updated_at DESC LIMIT ?
  `, [...values, normalizedLimit(options.limit)]);
  return rows.map(parseScheduleRow).filter((record): record is AutomationScheduleRecord => Boolean(record));
}

export async function createAutomationSchedule(input: CreateAutomationScheduleInput) {
  const record = await runDatabaseTransaction(async (manager) => {
    await ensureCaseOwner(manager, input.caseId, input.userId);
    const timestamp = now();
    const next = automationScheduleRecordSchema.parse({
      ...input, id: input.id || newId('schedule'), createdAt: timestamp, updatedAt: timestamp,
    });
    await executeDatabase(`
      INSERT INTO automation_schedule (
        id, user_id, case_id, title, recurrence, enabled, next_run_at,
        record_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [next.id, next.userId, next.caseId, next.title, next.recurrence, next.enabled,
      next.nextRunAt, JSON.stringify(next), next.createdAt, next.updatedAt], manager);
    return next;
  });
  publishAutomationRecord('automationSchedule', record);
  return record;
}

export async function deleteAutomationSchedule(id: string, userId?: string) {
  const record = await runDatabaseTransaction(async (manager) => {
    const current = await readSchedule(manager, id, userId);
    if (!current) return undefined;
    const rows = userId === undefined
      ? await queryDatabase<{ id: string }>('DELETE FROM automation_schedule WHERE id = ? RETURNING id', [id], manager)
      : await queryDatabase<{ id: string }>('DELETE FROM automation_schedule WHERE id = ? AND user_id = ? RETURNING id', [id, userId], manager);
    return rows.length ? current : undefined;
  });
  if (record) publishAutomationRecord('automationSchedule', record, true);
  return Boolean(record);
}

export type DueAutomationScheduleOptions = { at?: string; userId?: string; limit?: number };

export async function listDueAutomationSchedules(options: DueAutomationScheduleOptions = {}) {
  const dueAt = options.at || now();
  const rows = options.userId === undefined
    ? await queryDatabase<JsonRow>(`
        SELECT record_json FROM automation_schedule
        WHERE enabled = ? AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT ?
      `, [true, dueAt, normalizedLimit(options.limit)])
    : await queryDatabase<JsonRow>(`
        SELECT record_json FROM automation_schedule
        WHERE enabled = ? AND next_run_at <= ? AND user_id = ? ORDER BY next_run_at ASC LIMIT ?
      `, [true, dueAt, options.userId, normalizedLimit(options.limit)]);
  return rows.map(parseScheduleRow).filter((record): record is AutomationScheduleRecord => Boolean(record));
}

export type CreateAutomationScheduleOccurrenceInput = {
  scheduleId: string; nextRunAt: string; expectedNextRunAt?: string; triggeredAt?: string;
  runId?: string; userId?: string; status?: AutomationRunStatus; log?: AutomationRunLogEntry[];
  error?: string; misfired?: boolean;
};

export type CreateAutomationScheduleOccurrenceResult = {
  created: boolean; schedule: AutomationScheduleRecord; run?: AutomationRunRecord;
  reason?: 'disabled' | 'stale' | 'duplicate';
};

export async function createAutomationScheduleOccurrence(
  input: CreateAutomationScheduleOccurrenceInput,
): Promise<CreateAutomationScheduleOccurrenceResult | undefined> {
  const occurrence = await runDatabaseTransaction(async (manager) => {
    const schedule = await readSchedule(manager, input.scheduleId, input.userId);
    if (!schedule) return undefined;
    const occurrenceAt = input.expectedNextRunAt || schedule.nextRunAt;
    const existing = parseRunRow(await queryDatabaseOne<JsonRow>(`
      SELECT record_json FROM automation_run WHERE schedule_id = ? AND occurrence_key = ?
    `, [schedule.id, occurrenceAt], manager));
    if (existing) return { created: false, schedule, run: existing, reason: 'duplicate' as const };
    if (!schedule.enabled) return { created: false, schedule, reason: 'disabled' as const };
    if (schedule.nextRunAt !== occurrenceAt) return { created: false, schedule, reason: 'stale' as const };

    const timestamp = input.triggeredAt || now();
    const active = await queryDatabaseOne<{ active: number }>(`
      SELECT 1 AS active FROM automation_run
      WHERE schedule_id = ? AND status IN ('queued', 'running') LIMIT 1
    `, [schedule.id], manager);
    const overlapping = schedule.overlap === 'skip' && Boolean(active);
    const skipped = overlapping || (input.misfired === true && schedule.misfire === 'skip');
    const status = skipped ? 'skipped' : (input.status || 'queued');
    const error = input.error || (overlapping
      ? 'Skipped because a previous occurrence is still active.'
      : skipped ? 'Skipped by the schedule misfire policy.' : undefined);
    const run = automationRunRecordSchema.parse({
      id: input.runId || newId('run'), userId: schedule.userId, caseId: schedule.caseId,
      scheduleId: schedule.id, occurrenceKey: occurrenceAt, trigger: 'schedule', status,
      steps: [], log: input.log || [], error,
      startedAt: status === 'running' ? timestamp : undefined,
      finishedAt: terminalRunStatuses.has(status) ? timestamp : undefined,
      createdAt: timestamp, updatedAt: timestamp,
    });
    const advancedSchedule = automationScheduleRecordSchema.parse({
      ...schedule, lastRunAt: timestamp, nextRunAt: input.nextRunAt, updatedAt: timestamp,
    });
    await insertRun(manager, run);
    const updated = await queryDatabase<{ id: string }>(`
      UPDATE automation_schedule SET next_run_at = ?, record_json = ?, updated_at = ?
      WHERE id = ? AND enabled = ? AND next_run_at = ? RETURNING id
    `, [advancedSchedule.nextRunAt, JSON.stringify(advancedSchedule), advancedSchedule.updatedAt,
      advancedSchedule.id, true, occurrenceAt], manager);
    if (updated.length !== 1) {
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
