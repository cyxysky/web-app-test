import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { appDataRoot } from '@/server/storage/paths';

export function databaseDir() {
  return path.resolve(process.env.DATABASE_DIR || path.join(appDataRoot(), '.data'));
}

export function sqliteDatabasePath() {
  return path.join(databaseDir(), process.env.SQLITE_DATABASE_NAME || 'ai-web-test.db');
}

export function sqliteDatabaseUrl() {
  const configured = process.env.DATABASE_URL?.trim();
  if (configured) return configured;
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
