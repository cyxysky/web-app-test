import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  listDatabaseBackups,
  readBrowserChatSessionSnapshots,
  readSchemaMigrations,
  readStoreData,
} from '@/server/db/sqlite-store-engine';
import {
  databaseBackupDir,
  desktopPrismaSchemaPath,
  ensureDatabaseDir,
  fileInfo,
  sqliteDatabasePath,
  sqliteDatabaseUrl,
} from '@/server/storage/database';
import { artifactsRoot } from '@/server/storage/paths';

function prismaCliPath() {
  const candidates = [
    path.resolve(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js'),
    path.resolve(process.cwd(), '..', 'node_modules', 'prisma', 'build', 'index.js'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function recordCounts(data: Awaited<ReturnType<typeof readStoreData>>, browserChatSessions: number) {
  return {
    testCases: data.testCases.length,
    runs: data.runs.length,
    groups: data.groups?.length || 0,
    runtimeEnv: data.runtimeEnv?.length || 0,
    schedules: data.schedules?.length || 0,
    modelConfig: data.modelConfig ? 1 : 0,
    siteKnowledge: data.siteKnowledge?.length || 0,
    browserChatSessions,
  };
}

export async function storageHealthSnapshot() {
  const schemaPath = desktopPrismaSchemaPath();
  const databasePath = sqliteDatabasePath();
  const database = fileInfo(databasePath);
  const schemaExists = existsSync(schemaPath);
  const cliPath = prismaCliPath();
  const [data, browserChatSessions, schema, backups] = await Promise.all([
    readStoreData(),
    readBrowserChatSessionSnapshots(),
    readSchemaMigrations(),
    listDatabaseBackups(),
  ]);
  const latestBackup = backups[0];

  return {
    activeProvider: 'sqlite',
    activeStore: 'sqlite-prisma-raw',
    database: {
      path: databasePath,
      url: sqliteDatabaseUrl(),
      exists: Boolean(database),
      file: database,
      sizeBytes: database?.bytes || 0,
      lastWriteAt: database?.updatedAt,
      recordCounts: recordCounts(data, browserChatSessions.length),
    },
    schema,
    backups: {
      directory: databaseBackupDir(),
      count: backups.length,
      latest: latestBackup,
      items: backups.slice(0, 8),
    },
    artifacts: {
      root: artifactsRoot(),
      policy: 'SQLite stores structured runtime data. Screenshots, uploads, Playwright traces, and report attachments remain filesystem artifacts.',
    },
    prisma: {
      schemaPath,
      schemaExists,
      cliPath,
      cliAvailable: Boolean(cliPath),
    },
    runtime: {
      state: 'database_active',
      message: 'SQLite is the runtime source of truth for test data, settings, schedules, and browser-chat sessions.',
      nextActions: [
        'Use /api/storage/status to inspect database health.',
        'Use /api/storage/sqlite/initialize to ensure the SQLite schema exists.',
        'Use /api/storage/sqlite/backup before destructive import or restore operations.',
        'Use /api/storage/sqlite/export to create a logical JSON export for transfer or audit.',
        'Run npm run prisma:desktop:generate before desktop packaging if you want Prisma delegate types to match the desktop schema.',
      ],
    },
  };
}

export async function initializeSqliteDatabase() {
  ensureDatabaseDir();
  await readStoreData();
  return {
    ok: true,
    health: await storageHealthSnapshot(),
  };
}
