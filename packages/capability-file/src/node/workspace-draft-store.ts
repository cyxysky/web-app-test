import { CapabilityTaskQueue } from '@webpilot/capability-sdk';
import { currentNodeFileWorkspaceHost } from './workspace-host.js';
import { synchronizeSourceUnits, sourceDigest } from './workspace-source-editor.js';
import { randomUUID } from 'node:crypto';
import { access, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { raceWithAbort } from '@webpilot/capability-sdk';
import { sanitizeNodeArtifactFileName } from './artifacts.js';
import type { OfficeDocumentDraft } from '../office/types.js';

export const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

export const draftLocks = new Map<string, CapabilityTaskQueue>();

export const DRAFT_LOCK_WAIT_MS = 120_000;

export const STALE_DRAFT_LOCK_MS = 10 * 60_000;

export const sanitizeFileName = sanitizeNodeArtifactFileName;

export function artifactDir(runId: string | undefined, kind: 'attachment-previews' | 'document-assets' | 'document-drafts' | 'downloads' | 'generated') {
  return path.join(currentNodeFileWorkspaceHost().artifactsRoot, sanitizeFileName(runId, 'adhoc'), kind);
}

export function draftPath(runId: string | undefined, documentId: string) {
  return path.join(artifactDir(runId, 'document-drafts'), `${sanitizeFileName(documentId, 'document')}.json`);
}

export function draftProgramPath(runId: string | undefined, documentId: string, generator: OfficeDocumentDraft['generator'] = 'uno') {
  return path.join(
    artifactDir(runId, 'document-drafts'),
    `${sanitizeFileName(documentId, 'document')}${generator === 'javascript' ? '.mjs' : '.py'}`,
  );
}

export function draftTransactionPath(runId: string | undefined, documentId: string) {
  return path.join(artifactDir(runId, 'document-drafts'), `${sanitizeFileName(documentId, 'document')}.transaction.json`);
}

export function draftLockPath(runId: string | undefined, documentId: string) {
  return path.join(artifactDir(runId, 'document-drafts'), `${sanitizeFileName(documentId, 'document')}.lock`);
}

export function requireDocumentId(value: string | undefined, action: 'readSource' | 'generate' | 'edit' | 'render') {
  const documentId = String(value || '').trim();
  if (!DOCUMENT_ID_PATTERN.test(documentId)) {
    throw new Error(`file action=${action} requires the stable documentId returned by action=plan.`);
  }
  return documentId;
}

export async function acquireFilesystemDraftLock(runId: string | undefined, documentId: string, abortSignal?: AbortSignal) {
  const lockPath = draftLockPath(runId, documentId);
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + DRAFT_LOCK_WAIT_MS;
  while (true) {
    if (abortSignal?.aborted) throw abortSignal.reason instanceof Error ? abortSignal.reason : new Error('Draft operation aborted.');
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }), 'utf8');
      return async () => {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code || '') : '';
      if (code !== 'EEXIST') throw error;
      try {
        const metadata = await stat(lockPath);
        let ownerIsAlive = true;
        try {
          const owner = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: number };
          if (!Number.isSafeInteger(owner.pid) || Number(owner.pid) < 1) ownerIsAlive = false;
          else process.kill(Number(owner.pid), 0);
        } catch {
          ownerIsAlive = false;
        }
        if (!ownerIsAlive || Date.now() - metadata.mtimeMs > STALE_DRAFT_LOCK_MS) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch (lockError) {
        const lockCode = lockError && typeof lockError === 'object' && 'code' in lockError ? String((lockError as { code?: unknown }).code || '') : '';
        if (lockCode !== 'ENOENT') throw lockError;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for the workspace draft lock for ${documentId}.`);
      await raceWithAbort(new Promise((resolve) => setTimeout(resolve, 50)), abortSignal);
    }
  }
}

export async function withDraftLock<T>(runId: string | undefined, documentId: string, operation: () => Promise<T>, abortSignal?: AbortSignal) {
  const key = draftLockPath(runId, documentId);
  let queue = draftLocks.get(key);
  if (!queue) {
    queue = new CapabilityTaskQueue({ maxQueued: 32, queueTimeoutMs: DRAFT_LOCK_WAIT_MS });
    draftLocks.set(key, queue);
  }
  const current = queue;
  try {
    return await current.run(async (signal) => {
      const release = await acquireFilesystemDraftLock(runId, documentId, signal);
      try { signal.throwIfAborted(); return await operation(); }
      finally { await release(); }
    }, { abortSignal });
  } finally {
    void current.idle().then(() => {
      if (draftLocks.get(key) === current && !current.snapshot().active && !current.snapshot().queued) draftLocks.delete(key);
    });
  }
}

export async function writeDraftJsonAtomically(target: string, draft: OfficeDocumentDraft) {
  const candidate = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(candidate, JSON.stringify(draft, null, 2), { encoding: 'utf8', flag: 'wx' });
    await rename(candidate, target);
  } finally {
    await unlink(candidate).catch(() => undefined);
  }
}

export async function recoverDraftTransaction(runId: string | undefined, documentId: string) {
  const transactionPath = draftTransactionPath(runId, documentId);
  let pending: OfficeDocumentDraft;
  try {
    pending = JSON.parse(await readFile(transactionPath, 'utf8')) as OfficeDocumentDraft;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code || '') : '';
    if (code === 'ENOENT') return;
    throw error;
  }
  if (pending.documentId !== documentId) {
    throw new Error('Draft transaction identity does not match the requested documentId.');
  }
  let sourceMatches = false;
  if (pending.program) {
    try {
      sourceMatches = sourceDigest(await readFile(draftProgramPath(runId, documentId, pending.generator), 'utf8')) === pending.sourceDigest;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code || '') : '';
      if (code !== 'ENOENT') throw error;
    }
  } else {
    try {
      await access(draftProgramPath(runId, documentId, pending.generator));
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code || '') : '';
      if (code === 'ENOENT') sourceMatches = true;
      else throw error;
    }
  }
  if (sourceMatches) {
    await writeDraftJsonAtomically(draftPath(runId, documentId), pending);
  }
  await unlink(transactionPath).catch(() => undefined);
}

export async function loadDraft(runId: string | undefined, documentId: string) {
  await recoverDraftTransaction(runId, documentId);
  const parsed = JSON.parse(await readFile(draftPath(runId, documentId), 'utf8')) as OfficeDocumentDraft;
  parsed.generator ||= 'javascript';
  parsed.operation ||= parsed.sourceDocument ? 'modify' : 'create';
  parsed.workflow ||= {
    state: parsed.visualQaDigest && parsed.visualQaDigest === parsed.renderedDigest
      ? 'completed'
      : parsed.renderedDigest
        ? 'qa-pending'
        : parsed.validatedSourceDigest === parsed.sourceDigest
          ? 'render-ready'
          : parsed.program
            ? 'authoring'
            : 'planned',
    checkpointAt: parsed.updatedAt || parsed.createdAt,
    renderedDigest: parsed.renderedDigest,
  };
  if (parsed.documentId !== documentId) throw new Error('Document draft identity does not match the requested documentId.');
  if (parsed.program) {
    try {
      const workspaceProgram = await readFile(draftProgramPath(runId, documentId, parsed.generator), 'utf8');
      const workspaceDigest = sourceDigest(workspaceProgram);
      if (parsed.sourceDigest && parsed.sourceDigest !== workspaceDigest) {
        throw new Error('Workspace source file does not match its saved source metadata. Reload the workspace before editing.');
      }
      // The file is the executable source of truth; JSON contains metadata only.
      parsed.program = workspaceProgram;
      parsed.sourceDigest = workspaceDigest;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code || '')
        : '';
      if (code !== 'ENOENT') throw error;
      // A pre-workspace draft remains readable and is migrated on its next save.
    }
  }
  if (parsed.workflow?.state === 'rendering' || parsed.workflow?.state === 'validating') {
    const recoveredFrom = parsed.workflow.state;
    const currentDigest = parsed.sourceDigest || sourceDigest(parsed.program || '');
    parsed.workflow = {
      state: parsed.visualQaDigest && parsed.visualQaDigest === parsed.renderedDigest
        ? 'completed'
        : parsed.renderedDigest === currentDigest
          ? 'qa-pending'
          : parsed.validatedSourceDigest === currentDigest
            ? 'render-ready'
            : 'authoring',
      checkpointAt: new Date().toISOString(),
      error: `Recovered after an interrupted ${recoveredFrom} stage; completed checkpoints were preserved.`,
      recoveredFrom,
      renderedDigest: parsed.renderedDigest,
    };
    await writeDraftWorkspace(runId, parsed);
  }
  return parsed;
}

export async function writeDraftWorkspace(runId: string | undefined, draft: OfficeDocumentDraft) {
  const dir = artifactDir(runId, 'document-drafts');
  await mkdir(dir, { recursive: true });
  const target = draftPath(runId, draft.documentId);
  const programTarget = draftProgramPath(runId, draft.documentId, draft.generator);
  const transactionTarget = draftTransactionPath(runId, draft.documentId);
  const transactionCandidate = path.join(dir, `.${sanitizeFileName(draft.documentId, 'document')}.${randomUUID()}.transaction.json`);
  const programCandidate = path.join(dir, `.${sanitizeFileName(draft.documentId, 'document')}.${randomUUID()}.py`);
  try {
    // The journal makes a .py/JSON replacement recoverable across a crash or
    // an interrupted Windows rename. It is deliberately kept on failure.
    await writeFile(transactionCandidate, JSON.stringify(draft, null, 2), { encoding: 'utf8', flag: 'wx' });
    await rename(transactionCandidate, transactionTarget);
    if (draft.program) {
      await writeFile(programCandidate, draft.program, { encoding: 'utf8', flag: 'wx' });
      await rename(programCandidate, programTarget);
    } else {
      await unlink(programTarget).catch(() => undefined);
    }
    // Publish metadata only after the matching workspace source exists.
    await writeDraftJsonAtomically(target, draft);
    await unlink(transactionTarget).catch(() => undefined);
  } finally {
    await unlink(transactionCandidate).catch(() => undefined);
    await unlink(programCandidate).catch(() => undefined);
  }
}

export async function saveDraft(runId: string | undefined, draft: OfficeDocumentDraft) {
  const dir = artifactDir(runId, 'document-drafts');
  await mkdir(dir, { recursive: true });
  draft.updatedAt = new Date().toISOString();
  draft.sourceDigest = draft.program ? sourceDigest(draft.program) : undefined;
  if (draft.program) synchronizeSourceUnits(draft);
  await writeDraftWorkspace(runId, draft);
}

export async function saveWorkingDraft(runId: string | undefined, draft: OfficeDocumentDraft) {
  draft.updatedAt = new Date().toISOString();
  draft.sourceDigest = draft.program ? sourceDigest(draft.program) : undefined;
  await writeDraftWorkspace(runId, draft);
}
