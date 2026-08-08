import { readdir, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { artifactsRoot } from './paths';
import { normalizeApplicationUserId } from '@/server/auth/user-context';
import { incrementMetric, setMetricGauge, structuredLog } from '@/server/observability/runtime-observability';

type UploadFile = {
  absolutePath: string;
  modifiedAt: number;
  relativePath: string;
  size: number;
};

const state = ((globalThis as typeof globalThis & {
  __uploadArtifactMaintenance?: { running?: Promise<void>; timer?: ReturnType<typeof setInterval> };
}).__uploadArtifactMaintenance ??= {});

function configuredLimit(name: string, fallback: number, maximum: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value))) : fallback;
}

function uploadRoot() {
  return path.join(artifactsRoot(), 'uploads');
}

async function collectUserUploads(userId: string) {
  const directory = path.join(uploadRoot(), userId);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: UploadFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolutePath = path.join(directory, entry.name);
    const metadata = await stat(absolutePath).catch(() => undefined);
    if (!metadata) continue;
    files.push({
      absolutePath,
      modifiedAt: metadata.mtimeMs,
      relativePath: `uploads/${userId}/${entry.name}`,
      size: metadata.size,
    });
  }
  return files;
}

export async function userUploadUsage(userIdValue: unknown) {
  const userId = normalizeApplicationUserId(userIdValue);
  const files = await collectUserUploads(userId);
  return {
    bytes: files.reduce((total, file) => total + file.size, 0),
    files: files.length,
    maxBytes: configuredLimit('UPLOAD_MAX_BYTES_PER_USER', 1024 * 1024 * 1024, 20 * 1024 * 1024 * 1024),
    maxFiles: configuredLimit('UPLOAD_MAX_FILES_PER_USER', 1_000, 100_000),
    userId,
  };
}

export async function enforceUserUploadQuota(
  userIdValue: unknown,
  retainedPaths: ReadonlySet<string>,
  input: { protectedPath?: string } = {},
) {
  const userId = normalizeApplicationUserId(userIdValue);
  const maxBytes = configuredLimit('UPLOAD_MAX_BYTES_PER_USER', 1024 * 1024 * 1024, 20 * 1024 * 1024 * 1024);
  const maxFiles = configuredLimit('UPLOAD_MAX_FILES_PER_USER', 1_000, 100_000);
  const files = (await collectUserUploads(userId)).sort((left, right) => left.modifiedAt - right.modifiedAt);
  let bytes = files.reduce((total, file) => total + file.size, 0);
  let count = files.length;
  let removed = 0;
  for (const file of files) {
    if (bytes <= maxBytes && count <= maxFiles) break;
    if (file.absolutePath === input.protectedPath || retainedPaths.has(file.relativePath)) continue;
    await unlink(file.absolutePath).catch(() => undefined);
    bytes -= file.size;
    count -= 1;
    removed += 1;
  }
  setMetricGauge('upload_last_user_storage_bytes', Math.max(0, bytes));
  setMetricGauge('upload_last_user_storage_files', Math.max(0, count));
  if (removed) incrementMetric('upload_files_removed_total', {}, removed);
  return { bytes: Math.max(0, bytes), count: Math.max(0, count), maxBytes, maxFiles, overQuota: bytes > maxBytes || count > maxFiles, removed };
}

export async function maintainUserUploads(retainedPaths: ReadonlySet<string>) {
  const root = uploadRoot();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - configuredLimit('UPLOAD_RETENTION_DAYS', 30, 3650) * 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    if (entry.isFile()) {
      const absolutePath = path.join(root, entry.name);
      const relativePath = `uploads/${entry.name}`;
      const metadata = await stat(absolutePath).catch(() => undefined);
      if (metadata && metadata.mtimeMs < cutoff && !retainedPaths.has(relativePath)) await unlink(absolutePath).catch(() => undefined);
      continue;
    }
    if (!entry.isDirectory()) continue;
    const userId = normalizeApplicationUserId(entry.name);
    const files = await collectUserUploads(userId);
    for (const file of files) {
      if (file.modifiedAt < cutoff && !retainedPaths.has(file.relativePath)) await unlink(file.absolutePath).catch(() => undefined);
    }
    await enforceUserUploadQuota(userId, retainedPaths);
    const remaining = await readdir(path.join(root, entry.name)).catch(() => []);
    if (!remaining.length) await rm(path.join(root, entry.name), { force: true, recursive: true });
  }
}

export function scheduleUploadArtifactMaintenance(retainedUploadPaths: () => ReadonlySet<string>) {
  if (state.timer || process.env.UPLOAD_MAINTENANCE_ENABLED === 'false') return;
  const run = () => {
    if (state.running) return;
    try {
      state.running = maintainUserUploads(retainedUploadPaths())
        .catch((error) => structuredLog({ event: 'uploads.maintenance.failed', level: 'warn', error }))
        .finally(() => { state.running = undefined; });
    } catch (error) {
      structuredLog({ event: 'uploads.maintenance.failed', level: 'warn', error });
    }
  };
  const first = setTimeout(run, 60_000);
  first.unref?.();
  state.timer = setInterval(run, 6 * 60 * 60 * 1000);
  state.timer.unref?.();
}
