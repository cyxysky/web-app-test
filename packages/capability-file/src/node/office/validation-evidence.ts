import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { OfficeDocumentDraft } from '../../office/types.js';
import { resolveUnoProgramWorker } from './uno.js';

/** Code revision only; do not rescan every installed font on a source read. */
export async function currentUnoWorkerDigest(): Promise<string | null> {
  try {
    const worker = await resolveUnoProgramWorker();
    return worker ? createHash('sha256').update(await readFile(worker)).digest('hex') : null;
  } catch {
    return null;
  }
}

export async function beginOfficeValidation(draft: OfficeDocumentDraft, sourceUnitPath?: string) {
  draft.validationEvidence = (draft.generator || 'uno') === 'uno' ? {
    sourceDigest: createHash('sha256').update(draft.program || '', 'utf8').digest('hex'),
    workerDigest: await currentUnoWorkerDigest(),
    checkedAt: new Date().toISOString(),
    scope: sourceUnitPath ? 'source-unit' : 'document',
    ...(sourceUnitPath ? { sourceUnitPath } : {}),
    stage: 'static-analysis',
  } : undefined;
}

export function officeValidationEvidence(draft: OfficeDocumentDraft, currentWorkerDigest: string | null) {
  if ((draft.generator || 'uno') !== 'uno') return undefined;
  const evidence = draft.validationEvidence;
  const currentSourceDigest = createHash('sha256').update(draft.program || '', 'utf8').digest('hex');
  const reason = !evidence ? 'unversioned-history'
    : evidence.sourceDigest !== currentSourceDigest ? 'source-changed'
      : !evidence.workerDigest || !currentWorkerDigest ? 'worker-version-unavailable'
        : evidence.workerDigest !== currentWorkerDigest ? 'worker-changed' : 'matching-revisions';
  const freshness = reason === 'matching-revisions' ? 'current'
    : reason === 'source-changed' || reason === 'worker-changed' ? 'stale' : 'unknown';
  return {
    ...evidence,
    freshness,
    reason,
    currentWorkerDigest,
    ...(draft.program && freshness !== 'current' && reason !== 'worker-version-unavailable' ? {
      guidance: 'Saved diagnostics are historical, not a current runtime verdict. When resuming this task, run render once against the current source/worker before declaring an infrastructure blocker. Do not repeat unchanged renders after that fresh result.',
      nextAction: { action: 'render', documentId: draft.documentId },
    } : {}),
    ...(reason === 'worker-version-unavailable' ? {
      guidance: 'Worker revision cannot be verified. Use checkedAt/stage and the latest execution; do not repeat a fresh failure merely to obtain a fingerprint.',
    } : {}),
  };
}
