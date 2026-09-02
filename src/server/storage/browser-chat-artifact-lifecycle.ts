import { readFile, readdir, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { artifactsRoot } from './paths';
import { structuredLog } from '@/server/observability/runtime-observability';

type ArtifactFile = {
  modifiedAt: number;
  path: string;
  priority: number;
  protected: boolean;
  size: number;
};

const sessionIdPattern = /^chat_[a-f0-9]{12}$/i;
const runtimeState = ((globalThis as typeof globalThis & {
  __browserChatArtifactMaintenance?: { running?: Promise<void>; timer?: ReturnType<typeof setInterval> };
}).__browserChatArtifactMaintenance ??= {});

function sessionIdFromArtifactDirectory(name: string) {
  const candidate = name.slice(0, 'chat_'.length + 12);
  return sessionIdPattern.test(candidate) && (name.length === candidate.length || name[candidate.length] === '_')
    ? candidate
    : undefined;
}

function configuredPositiveNumber(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function artifactDirectoriesForSession(sessionId: string) {
  if (!sessionIdPattern.test(sessionId)) return [];
  const root = artifactsRoot();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && (entry.name === sessionId || entry.name.startsWith(`${sessionId}_`)))
    .map((entry) => path.join(root, entry.name));
}

function normalizedArtifactPath(value: string) {
  return path.resolve(value).toLowerCase();
}

function cleanupPriority(filePath: string) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/attachment-previews/') || /\.validation(?:\.|$)/.test(normalized)) return 0;
  if (normalized.includes('/generated/')) return 1;
  if (normalized.includes('/downloads/') || normalized.includes('/document-assets/')) return 2;
  if (normalized.includes('.revisions/')) return 3;
  return 2;
}

async function protectedArtifactPaths(directories: string[]) {
  const root = artifactsRoot();
  const protectedPaths = new Set<string>();
  for (const directory of directories) {
    const drafts = path.join(directory, 'document-drafts');
    const entries = await readdir(drafts, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.endsWith('.transaction.json')) continue;
      const metadataPath = path.join(drafts, entry.name);
      try {
        const draft = JSON.parse(await readFile(metadataPath, 'utf8')) as {
          documentId?: string;
          generator?: 'javascript' | 'uno';
          renderedArtifactId?: string;
          revisions?: Array<{ sourceFileName?: string }>;
        };
        protectedPaths.add(normalizedArtifactPath(metadataPath));
        if (draft.documentId) {
          protectedPaths.add(normalizedArtifactPath(path.join(drafts, `${draft.documentId}${draft.generator === 'javascript' ? '.mjs' : '.py'}`)));
          for (const revision of draft.revisions || []) {
            if (revision.sourceFileName) {
              protectedPaths.add(normalizedArtifactPath(path.join(drafts, `${draft.documentId}.revisions`, path.basename(revision.sourceFileName))));
            }
          }
        }
        if (draft.renderedArtifactId) protectedPaths.add(normalizedArtifactPath(path.join(root, draft.renderedArtifactId)));
      } catch {
        // Corrupt metadata remains protected so quota cleanup cannot make recovery harder.
        protectedPaths.add(normalizedArtifactPath(metadataPath));
      }
    }
  }
  return protectedPaths;
}

async function collectFiles(directory: string, protectedPaths: ReadonlySet<string>): Promise<ArtifactFile[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map(async (entry): Promise<ArtifactFile[]> => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(filePath, protectedPaths);
    if (!entry.isFile()) return [];
    const metadata = await stat(filePath).catch(() => undefined);
    return metadata ? [{
      modifiedAt: metadata.mtimeMs,
      path: filePath,
      priority: cleanupPriority(filePath),
      protected: protectedPaths.has(normalizedArtifactPath(filePath))
        || /(?:\.lock|\.transaction\.json|\.tmp)$/i.test(entry.name),
      size: metadata.size,
    }] : [];
  }));
  return nested.flat();
}

export async function deleteBrowserChatArtifacts(sessionId: string) {
  const directories = await artifactDirectoriesForSession(sessionId);
  await Promise.all(directories.map((directory) => rm(directory, { force: true, recursive: true })));
  return directories.length;
}

export async function enforceBrowserChatArtifactQuota(sessionId: string) {
  const maxBytes = Math.floor(configuredPositiveNumber('BROWSER_CHAT_ARTIFACT_MAX_BYTES_PER_SESSION', 512 * 1024 * 1024));
  const directories = await artifactDirectoriesForSession(sessionId);
  const protectedPaths = await protectedArtifactPaths(directories);
  const files = (await Promise.all(directories.map((directory) => collectFiles(directory, protectedPaths))))
    .flat()
    .sort((a, b) => a.priority - b.priority || a.modifiedAt - b.modifiedAt);
  let totalBytes = files.reduce((total, file) => total + file.size, 0);
  let removedFiles = 0;
  for (const file of files) {
    if (totalBytes <= maxBytes) break;
    if (file.protected) continue;
    await unlink(file.path).catch(() => undefined);
    totalBytes -= file.size;
    removedFiles += 1;
  }
  return { maxBytes, remainingBytes: Math.max(0, totalBytes), removedFiles };
}

export async function maintainBrowserChatArtifacts(retainedSessionIds: Iterable<string>) {
  const retained = new Set([...retainedSessionIds].filter((sessionId) => sessionIdPattern.test(sessionId)));
  const root = artifactsRoot();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - configuredPositiveNumber('BROWSER_CHAT_ARTIFACT_RETENTION_DAYS', 14) * 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionId = sessionIdFromArtifactDirectory(entry.name);
    if (!sessionId) continue;
    const directory = path.join(root, entry.name);
    if (retained.has(sessionId)) continue;
    const metadata = await stat(directory).catch(() => undefined);
    if (metadata && metadata.mtimeMs < cutoff) await rm(directory, { force: true, recursive: true });
  }
  for (const sessionId of retained) await enforceBrowserChatArtifactQuota(sessionId);
}

export function scheduleBrowserChatArtifactMaintenance(retainedSessionIds: () => Promise<Iterable<string>>) {
  if (runtimeState.timer) return;
  const run = () => {
    if (runtimeState.running) return;
    runtimeState.running = Promise.resolve()
      .then(retainedSessionIds)
      .then(maintainBrowserChatArtifacts)
      .catch((error) => structuredLog({ event: 'browser_chat.artifact_maintenance_failed', level: 'warn', error }))
      .finally(() => { runtimeState.running = undefined; });
  };
  const first = setTimeout(run, 60_000);
  first.unref?.();
  runtimeState.timer = setInterval(run, 6 * 60 * 60 * 1000);
  runtimeState.timer.unref?.();
}
