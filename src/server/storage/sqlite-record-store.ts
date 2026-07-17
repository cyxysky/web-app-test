import type { RunScheduleRecord, SkillRecord, TestCaseRecord, TestGroupRecord, TestRunRecord } from '@/server/ai/schemas/test-case.schema';
import { getSqliteDatabase, parseSqliteJson, runSqliteTransaction } from '@/server/storage/sqlite-database';

type ConfigRecord = {
  runtimeEnv: unknown[];
  modelConfig?: unknown;
};

type JsonRow = { record_json: string };

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

export function readTestGroups() {
  return readJsonRows<TestGroupRecord>('SELECT record_json FROM test_group ORDER BY created_at ASC');
}

export function readTestCases() {
  return readJsonRows<TestCaseRecord>('SELECT record_json FROM test_case ORDER BY updated_at DESC');
}

export function readSkills() {
  return readJsonRows<SkillRecord>('SELECT record_json FROM skill ORDER BY updated_at DESC');
}

export function readRunSchedules() {
  return readJsonRows<RunScheduleRecord>('SELECT record_json FROM run_schedule ORDER BY created_at ASC');
}

export function replaceTestCaseRecords(input: {
  groups: TestGroupRecord[];
  testCases: TestCaseRecord[];
  skills: SkillRecord[];
  schedules: RunScheduleRecord[];
}) {
  runSqliteTransaction((database) => {
    database.exec('DELETE FROM test_group; DELETE FROM test_case; DELETE FROM skill; DELETE FROM run_schedule;');
    const insertGroup = database.prepare(`
      INSERT INTO test_group (id, parent_id, name, record_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertTestCase = database.prepare(`
      INSERT INTO test_case (id, group_id, title, target_url, status, priority, record_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSkill = database.prepare(`
      INSERT INTO skill (id, title, status, record_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertSchedule = database.prepare(`
      INSERT INTO run_schedule (id, name, enabled, record_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const group of input.groups) {
      insertGroup.run(group.id, group.parentId || null, group.name, JSON.stringify(group), group.createdAt, group.updatedAt);
    }
    for (const testCase of input.testCases) {
      insertTestCase.run(
        testCase.id,
        testCase.groupId || null,
        testCase.title,
        testCase.targetUrl,
        testCase.status,
        testCase.priority,
        JSON.stringify(testCase),
        testCase.createdAt,
        testCase.updatedAt,
      );
    }
    for (const skill of input.skills) {
      insertSkill.run(skill.id, skill.title, skill.status, JSON.stringify(skill), skill.createdAt, skill.updatedAt);
    }
    for (const schedule of input.schedules) {
      insertSchedule.run(
        schedule.id,
        schedule.name,
        schedule.enabled ? 1 : 0,
        JSON.stringify(schedule),
        schedule.createdAt,
        schedule.updatedAt,
      );
    }
  });
}

export function readTestRuns() {
  return readJsonRows<TestRunRecord>('SELECT record_json FROM test_run ORDER BY created_at DESC');
}

export function replaceTestRuns(runs: TestRunRecord[]) {
  runSqliteTransaction((database) => {
    database.exec('DELETE FROM test_run');
    const insert = database.prepare(`
      INSERT INTO test_run (id, test_case_id, status, record_json, created_at, started_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const run of runs) {
      insert.run(
        run.id,
        run.testCaseId,
        run.status,
        JSON.stringify(run),
        run.createdAt,
        run.startedAt || null,
        run.endedAt || null,
      );
    }
  });
}

export function readPersonalMemoryRecords<T>() {
  return readJsonRows<T>('SELECT record_json FROM personal_memory_item ORDER BY updated_at DESC');
}

export function replacePersonalMemoryRecords(items: Array<{
  id: string;
  userId: string;
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
        id, user_id, scope, domain, type, memory_key, status, record_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of items) {
      insert.run(
        item.id,
        item.userId,
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

export function readBrowserChatSessionRecord<T extends { logs?: unknown[] }>(sessionId: string) {
  const row = getSqliteDatabase().prepare(`
    SELECT snapshot_json FROM browser_chat_session WHERE id = ?
  `).get(sessionId) as { snapshot_json?: string } | undefined;
  const snapshot = parseSqliteJson<T | undefined>(row?.snapshot_json, undefined);
  return snapshot ? { ...snapshot, logs: readBrowserChatLogs(sessionId) } : undefined;
}

export function readBrowserChatSessionSummaries<T>() {
  const rows = getSqliteDatabase().prepare(`
    SELECT summary_json FROM browser_chat_session ORDER BY updated_at DESC
  `).all() as Array<{ summary_json?: string }>;
  return rows
    .map((row) => parseSqliteJson<T | undefined>(row.summary_json, undefined))
    .filter((item): item is T => Boolean(item));
}

export function writeBrowserChatSessionRecord<TSnapshot extends BrowserChatSessionFields, TLog extends { id: string; time: string }>(
  snapshot: TSnapshot,
  summary: unknown,
  logs: TLog[],
) {
  runSqliteTransaction((database) => {
    database.prepare(`
      INSERT INTO browser_chat_session (
        id, user_id, title, status, snapshot_json, summary_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        user_id = excluded.user_id,
        title = excluded.title,
        status = excluded.status,
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
    database.prepare('DELETE FROM browser_chat_log WHERE session_id = ?').run(snapshot.id);
    const insertLog = database.prepare(`
      INSERT INTO browser_chat_log (session_id, id, time, record_json) VALUES (?, ?, ?, ?)
    `);
    for (const log of logs) insertLog.run(snapshot.id, log.id, log.time, JSON.stringify(log));
  });
}

export function deleteBrowserChatSessionRecord(sessionId: string) {
  getSqliteDatabase().prepare('DELETE FROM browser_chat_session WHERE id = ?').run(sessionId);
}
