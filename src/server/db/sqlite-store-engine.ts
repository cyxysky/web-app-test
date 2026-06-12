import { PrismaClient } from '@prisma/client';
import type {
  ModelConfigRecord,
  RunScheduleRecord,
  RuntimeEnvRecord,
  TestCaseRecord,
  TestRunRecord,
  TestGroupRecord,
} from '@/server/ai/schemas/test-case.schema';
import type { StoreData } from '@/server/db/store-data';
import { normalizeStoreData } from '@/server/db/store-data';
import { ensureDatabaseDir, sqliteDatabasePath, sqliteDatabaseUrl } from '@/server/storage/database';

let prisma: PrismaClient | undefined;
let schemaReady: Promise<void> | undefined;

function now() {
  return new Date().toISOString();
}

function json(value: unknown) {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function bool(value: unknown) {
  return value === true || value === 1 || value === '1';
}

export function databaseRuntimeInfo() {
  return {
    provider: 'sqlite',
    databasePath: sqliteDatabasePath(),
    databaseUrl: sqliteDatabaseUrl(),
  };
}

function getPrisma() {
  if (!prisma) {
    ensureDatabaseDir();
    prisma = new PrismaClient({
      datasources: {
        db: {
          url: sqliteDatabaseUrl(),
        },
      },
    });
  }
  return prisma;
}

async function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const db = getPrisma();
    await db.$executeRawUnsafe('PRAGMA foreign_keys = ON');
    await db.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS TestGroup (
        id TEXT PRIMARY KEY,
        parentId TEXT,
        name TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    await db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS TestGroup_parentId_idx ON TestGroup(parentId)');
    await db.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS TestCase (
        id TEXT PRIMARY KEY,
        groupId TEXT,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        targetUrl TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        priority TEXT NOT NULL DEFAULT 'medium',
        contentJson TEXT NOT NULL,
        imageNamesJson TEXT NOT NULL DEFAULT '[]',
        strategyMemoryJson TEXT NOT NULL DEFAULT '[]',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    await db.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS TestRun (
        id TEXT PRIMARY KEY,
        testCaseId TEXT NOT NULL,
        status TEXT NOT NULL,
        queueJson TEXT,
        startedAt TEXT,
        endedAt TEXT,
        resultJson TEXT,
        reportJson TEXT,
        analysisJson TEXT,
        debugJson TEXT,
        controlJson TEXT,
        createdAt TEXT NOT NULL
      )
    `);
    await db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS TestRun_testCaseId_idx ON TestRun(testCaseId)');
    await db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS TestRun_status_idx ON TestRun(status)');
    await db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS TestRun_createdAt_idx ON TestRun(createdAt)');
    await db.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS Artifact (
        id TEXT PRIMARY KEY,
        runId TEXT NOT NULL,
        type TEXT NOT NULL,
        path TEXT NOT NULL,
        title TEXT,
        metadataJson TEXT,
        createdAt TEXT NOT NULL
      )
    `);
    await db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS Artifact_runId_idx ON Artifact(runId)');
    await db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS Artifact_type_idx ON Artifact(type)');
    await db.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS RuntimeEnv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        secret INTEGER NOT NULL DEFAULT 0,
        updatedAt TEXT NOT NULL
      )
    `);
    await db.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS ModelConfig (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        configJson TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    await db.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS RunSchedule (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        configJson TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    await db.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS StoreSnapshot (
        key TEXT PRIMARY KEY,
        valueJson TEXT NOT NULL,
        reason TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    await db.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS BrowserChatSession (
        id TEXT PRIMARY KEY,
        valueJson TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    await db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS BrowserChatSession_updatedAt_idx ON BrowserChatSession(updatedAt)');
  })();
  return schemaReady;
}

type TestCaseRow = {
  id: string;
  groupId: string | null;
  title: string;
  description: string;
  targetUrl: string;
  status: TestCaseRecord['status'];
  priority: TestCaseRecord['priority'];
  contentJson: string;
  imageNamesJson: string;
  strategyMemoryJson: string;
  createdAt: string;
  updatedAt: string;
};

type TestRunRow = {
  id: string;
  testCaseId: string;
  status: TestRunRecord['status'];
  queueJson: string | null;
  startedAt: string | null;
  endedAt: string | null;
  resultJson: string | null;
  reportJson: string | null;
  analysisJson: string | null;
  debugJson: string | null;
  controlJson: string | null;
  createdAt: string;
};

type TestGroupRow = TestGroupRecord;
type RuntimeEnvRow = Omit<RuntimeEnvRecord, 'enabled' | 'secret'> & { enabled: number | boolean; secret: number | boolean };
type ModelConfigRow = { id: string; provider: string; configJson: string; updatedAt: string };
type RunScheduleRow = { id: string; name: string; enabled: number | boolean; configJson: string; createdAt: string; updatedAt: string };
type BrowserChatSessionRow = { id: string; valueJson: string; createdAt: string; updatedAt: string };

function testCaseFromRow(row: TestCaseRow): TestCaseRecord {
  return {
    id: row.id,
    groupId: row.groupId || undefined,
    title: row.title,
    description: row.description,
    targetUrl: row.targetUrl,
    status: row.status,
    priority: row.priority,
    content: parseJson(row.contentJson, {
      title: row.title,
      description: row.description,
      targetUrl: row.targetUrl,
      priority: row.priority,
      browserMode: 'default',
      isMarked: true,
      preconditions: [],
      testData: {},
      steps: [],
      expectedResults: [],
      risks: [],
    }),
    imageNames: parseJson(row.imageNamesJson, [] as string[]),
    strategyMemory: parseJson(row.strategyMemoryJson, [] as string[]),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function runFromRow(row: TestRunRow): TestRunRecord {
  return {
    id: row.id,
    testCaseId: row.testCaseId,
    status: row.status,
    queue: parseJson(row.queueJson, undefined as TestRunRecord['queue']),
    startedAt: row.startedAt || undefined,
    endedAt: row.endedAt || undefined,
    result: parseJson(row.resultJson, undefined as TestRunRecord['result']),
    report: parseJson(row.reportJson, undefined as TestRunRecord['report']),
    analysis: parseJson(row.analysisJson, undefined as TestRunRecord['analysis']),
    debug: parseJson(row.debugJson, undefined as TestRunRecord['debug']),
    control: parseJson(row.controlJson, undefined as TestRunRecord['control']),
    createdAt: row.createdAt,
  };
}

function runtimeEnvFromRow(row: RuntimeEnvRow): RuntimeEnvRecord {
  return {
    key: row.key,
    value: row.value,
    enabled: bool(row.enabled),
    secret: bool(row.secret),
    updatedAt: row.updatedAt,
  };
}

export async function readStoreData(seedData?: StoreData): Promise<StoreData> {
  await ensureSchema();
  const db = getPrisma();
  const [[{ count }], [{ snapshotCount }]] = await Promise.all([
    db.$queryRawUnsafe('SELECT COUNT(*) as count FROM TestCase') as Promise<Array<{ count: bigint | number }>>,
    db.$queryRawUnsafe("SELECT COUNT(*) as snapshotCount FROM StoreSnapshot WHERE key = 'store'") as Promise<Array<{ snapshotCount: bigint | number }>>,
  ]);
  if (Number(count) === 0 && Number(snapshotCount) === 0 && seedData) {
    await writeStoreData(seedData, 'seed');
  }

  const [testCases, runs, groups, runtimeEnv, modelConfigRows, schedules] = await Promise.all([
    db.$queryRawUnsafe('SELECT * FROM TestCase ORDER BY updatedAt DESC') as Promise<TestCaseRow[]>,
    db.$queryRawUnsafe('SELECT * FROM TestRun ORDER BY createdAt DESC') as Promise<TestRunRow[]>,
    db.$queryRawUnsafe('SELECT * FROM TestGroup ORDER BY createdAt ASC') as Promise<TestGroupRow[]>,
    db.$queryRawUnsafe('SELECT * FROM RuntimeEnv ORDER BY key ASC') as Promise<RuntimeEnvRow[]>,
    db.$queryRawUnsafe('SELECT * FROM ModelConfig WHERE id = ?', 'default') as Promise<ModelConfigRow[]>,
    db.$queryRawUnsafe('SELECT * FROM RunSchedule ORDER BY createdAt ASC') as Promise<RunScheduleRow[]>,
  ]);

  return normalizeStoreData({
    testCases: testCases.map(testCaseFromRow),
    runs: runs.map(runFromRow),
    groups,
    runtimeEnv: runtimeEnv.map(runtimeEnvFromRow),
    modelConfig: modelConfigRows[0] ? parseJson(modelConfigRows[0].configJson, undefined as ModelConfigRecord | undefined) : undefined,
    schedules: schedules.map((row) => parseJson(row.configJson, {
      id: row.id,
      name: row.name,
      enabled: bool(row.enabled),
      testCaseIds: [],
      intervalMinutes: 60,
      nextRunAt: now(),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } as RunScheduleRecord)),
  });
}

export async function readBrowserChatSessionSnapshots<T>(): Promise<T[]> {
  await ensureSchema();
  const db = getPrisma();
  const rows = await db.$queryRawUnsafe(
    'SELECT * FROM BrowserChatSession ORDER BY updatedAt DESC',
  ) as BrowserChatSessionRow[];
  return rows
    .map((row) => parseJson<T | undefined>(row.valueJson, undefined))
    .filter((item): item is T => Boolean(item));
}

export async function writeBrowserChatSessionSnapshots(snapshots: Array<{ id?: string; createdAt?: string; updatedAt?: string }>) {
  await ensureSchema();
  const db = getPrisma();
  const timestamp = now();
  const statements = [
    db.$executeRawUnsafe('DELETE FROM BrowserChatSession'),
  ];
  for (const snapshot of snapshots) {
    if (!snapshot?.id) continue;
    statements.push(db.$executeRawUnsafe(
      'INSERT INTO BrowserChatSession (id, valueJson, createdAt, updatedAt) VALUES (?, ?, ?, ?)',
      snapshot.id,
      json(snapshot),
      snapshot.createdAt || timestamp,
      snapshot.updatedAt || timestamp,
    ));
  }
  await db.$transaction(statements);
  return snapshots;
}

export async function writeStoreData(data: StoreData, reason = 'store-write') {
  await ensureSchema();
  const db = getPrisma();
  const normalized = normalizeStoreData(data);
  const statements = [
    db.$executeRawUnsafe('DELETE FROM TestRun'),
    db.$executeRawUnsafe('DELETE FROM TestCase'),
    db.$executeRawUnsafe('DELETE FROM TestGroup'),
    db.$executeRawUnsafe('DELETE FROM RuntimeEnv'),
    db.$executeRawUnsafe('DELETE FROM ModelConfig'),
    db.$executeRawUnsafe('DELETE FROM RunSchedule'),
    db.$executeRawUnsafe('DELETE FROM StoreSnapshot WHERE key = ?', 'store'),
  ];

  for (const group of normalized.groups || []) {
    statements.push(db.$executeRawUnsafe(
      'INSERT INTO TestGroup (id, parentId, name, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)',
      group.id,
      group.parentId || null,
      group.name,
      group.createdAt,
      group.updatedAt,
    ));
  }

  for (const testCase of normalized.testCases) {
    statements.push(db.$executeRawUnsafe(
      `INSERT INTO TestCase
        (id, groupId, title, description, targetUrl, status, priority, contentJson, imageNamesJson, strategyMemoryJson, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      testCase.id,
      testCase.groupId || null,
      testCase.title,
      testCase.description,
      testCase.targetUrl,
      testCase.status,
      testCase.priority,
      json(testCase.content),
      json(testCase.imageNames || []),
      json(testCase.strategyMemory || []),
      testCase.createdAt,
      testCase.updatedAt,
    ));
  }

  for (const run of normalized.runs) {
    statements.push(db.$executeRawUnsafe(
      `INSERT INTO TestRun
        (id, testCaseId, status, queueJson, startedAt, endedAt, resultJson, reportJson, analysisJson, debugJson, controlJson, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      run.id,
      run.testCaseId,
      run.status,
      run.queue ? json(run.queue) : null,
      run.startedAt || null,
      run.endedAt || null,
      run.result ? json(run.result) : null,
      run.report ? json(run.report) : null,
      run.analysis ? json(run.analysis) : null,
      run.debug ? json(run.debug) : null,
      run.control ? json(run.control) : null,
      run.createdAt,
    ));
  }

  for (const item of normalized.runtimeEnv || []) {
    statements.push(db.$executeRawUnsafe(
      'INSERT INTO RuntimeEnv (key, value, enabled, secret, updatedAt) VALUES (?, ?, ?, ?, ?)',
      item.key,
      item.value,
      item.enabled ? 1 : 0,
      item.secret ? 1 : 0,
      item.updatedAt,
    ));
  }

  if (normalized.modelConfig) {
    statements.push(db.$executeRawUnsafe(
      'INSERT INTO ModelConfig (id, provider, configJson, updatedAt) VALUES (?, ?, ?, ?)',
      'default',
      normalized.modelConfig.provider,
      json(normalized.modelConfig),
      normalized.modelConfig.updatedAt || now(),
    ));
  }

  for (const schedule of normalized.schedules || []) {
    statements.push(db.$executeRawUnsafe(
      'INSERT INTO RunSchedule (id, name, enabled, configJson, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
      schedule.id,
      schedule.name,
      schedule.enabled ? 1 : 0,
      json(schedule),
      schedule.createdAt,
      schedule.updatedAt,
    ));
  }

  const timestamp = now();
  statements.push(db.$executeRawUnsafe(
    'INSERT INTO StoreSnapshot (key, valueJson, reason, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)',
    'store',
    json(normalized),
    reason,
    timestamp,
    timestamp,
  ));

  await db.$transaction(statements);
  return normalized;
}
