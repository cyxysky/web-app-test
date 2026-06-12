import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { appDataRoot } from '@/server/storage/paths';

export function databaseDir() {
  return path.resolve(process.env.DATABASE_DIR || path.join(appDataRoot(), '.data'));
}

export function sqliteDatabasePath() {
  return path.join(databaseDir(), process.env.SQLITE_DATABASE_NAME || 'ai-web-test.db');
}

export function databaseBackupDir() {
  return path.join(databaseDir(), 'backups');
}

export function ensureDatabaseBackupDir() {
  const dir = databaseBackupDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function resolveDatabaseBackupPath(fileName: string) {
  const cleanName = path.basename(fileName.trim());
  if (!cleanName || cleanName === '.' || cleanName === '..' || cleanName !== fileName.trim()) {
    throw new Error('Invalid backup file name');
  }
  return path.join(databaseBackupDir(), cleanName);
}

export function sqliteDatabaseUrl() {
  const explicitSqliteUrl = process.env.SQLITE_DATABASE_URL?.trim();
  if (explicitSqliteUrl) {
    if (!explicitSqliteUrl.startsWith('file:')) {
      throw new Error('SQLITE_DATABASE_URL must start with "file:" for the SQLite runtime database.');
    }
    return explicitSqliteUrl;
  }
  const legacyDatabaseUrl = process.env.DATABASE_URL?.trim();
  if (legacyDatabaseUrl?.startsWith('file:')) return legacyDatabaseUrl;
  return `file:${sqliteDatabasePath().replace(/\\/g, '/')}`;
}

export function packagedPrismaResourceDir() {
  return path.resolve(process.env.PRISMA_RESOURCE_DIR || path.join(appDataRoot(), 'resources', 'prisma'));
}

export function desktopPrismaSchemaPath() {
  const packaged = path.join(packagedPrismaResourceDir(), 'schema.prisma');
  if (existsSync(packaged)) return packaged;
  return path.resolve(process.cwd(), 'prisma', 'desktop', 'schema.prisma');
}

export function ensureDatabaseDir() {
  const dir = databaseDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function fileInfo(filePath: string) {
  if (!existsSync(filePath)) return undefined;
  const stats = statSync(filePath);
  return {
    path: filePath,
    bytes: stats.size,
    updatedAt: stats.mtime.toISOString(),
  };
}
