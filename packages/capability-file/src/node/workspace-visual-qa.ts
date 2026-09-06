import { loadDraft, saveDraft, withDraftLock, DOCUMENT_ID_PATTERN } from './workspace-draft-store.js';
import { sourceDigest } from './workspace-source-editor.js';
import type { FileArtifactOperationResult } from '../types.js';
import type { OfficeVisualQaDeckChecks, OfficeVisualQaPageChecks } from '../office/types.js';
import { officeDesignGuidance, missingDesignReviewChecks } from '../design-guidance.js';

export const VISUAL_QA_PAGE_CHECKS = [
  'overlap', 'clipping', 'alignment', 'spacing', 'typography', 'contrast',
  'visualHierarchy', 'chartTableLegibility', 'imageQuality',
] as const;

export const VISUAL_QA_DECK_CHECKS = [
  'templateConsistency', 'typographyConsistency', 'colorConsistency',
  'spacingRhythm', 'componentConsistency',
] as const;

export function failedPageVisualChecks(checks: OfficeVisualQaPageChecks | undefined) {
  if (!checks || typeof checks !== 'object') return { invalid: [...VISUAL_QA_PAGE_CHECKS], failed: [] as string[] };
  const invalid: string[] = [];
  const failed: string[] = [];
  for (const name of VISUAL_QA_PAGE_CHECKS) {
    const status = checks[name];
    if (status !== 'passed' && status !== 'failed' && status !== 'not-applicable') invalid.push(name);
    else if (status === 'not-applicable' && name !== 'chartTableLegibility' && name !== 'imageQuality') invalid.push(name);
    else if (status === 'failed') failed.push(name);
  }
  return { invalid, failed };
}

export function failedDeckVisualChecks(checks: OfficeVisualQaDeckChecks | undefined) {
  if (!checks || typeof checks !== 'object') return { invalid: [...VISUAL_QA_DECK_CHECKS], failed: [] as string[] };
  const invalid: string[] = [];
  const failed: string[] = [];
  for (const name of VISUAL_QA_DECK_CHECKS) {
    const status = checks[name];
    if (status !== 'passed' && status !== 'failed') invalid.push(name);
    else if (status === 'failed') failed.push(name);
  }
  for (const name of ['designIntent', 'compositionRhythm', 'contentConsistency', 'sourceTraceability'] as const) {
    if (checks[name] === undefined) continue;
    if (checks[name] !== 'passed' && checks[name] !== 'failed') invalid.push(name);
    else if (checks[name] === 'failed') failed.push(name);
  }
  return { invalid, failed };
}

export async function verifyCurrentUnoRenderedArtifact(input: {
  runId?: string;
  artifactId: string;
}): Promise<FileArtifactOperationResult> {
  try {
    const normalized = String(input.artifactId || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const segments = normalized.split('/').filter(Boolean);
    const generatedIndex = segments.indexOf('generated');
    // Non-versioned artifacts do not carry an Office source digest in their Artifact ID.
    if (generatedIndex < 0 || segments.length < generatedIndex + 4) return { ok: true, actual: 'unversioned-artifact' };
    const documentId = segments[generatedIndex + 1];
    const renderedDigest = segments[generatedIndex + 2];
    if (!DOCUMENT_ID_PATTERN.test(documentId) || !/^[a-f0-9]{64}$/i.test(renderedDigest)) {
      return { ok: true, actual: 'unversioned-artifact' };
    }
    const draft = await loadDraft(input.runId, documentId);
    const currentDigest = sourceDigest(draft.program || '');
    if (currentDigest !== renderedDigest || draft.renderedArtifactId !== normalized) {
      return {
        ok: false,
        actual: JSON.stringify({
          kind: 'stale-file-visual-artifact',
          documentId,
          artifactId: normalized,
          renderedDigest,
          currentSourceDigest: currentDigest,
          error: 'This artifact does not represent the current source draft and cannot be used as evidence for it.',
        }),
      };
    }
    return { ok: true, actual: JSON.stringify({ kind: 'current-file-visual-artifact', documentId, sourceDigest: currentDigest }) };
  } catch (error) {
    return { ok: false, actual: `File visual version check failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function versionedRenderedArtifact(artifactId: string) {
  const normalized = String(artifactId || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized.split('/').filter(Boolean);
  const generatedIndex = segments.indexOf('generated');
  if (generatedIndex < 0 || segments.length < generatedIndex + 4) return undefined;
  const documentId = segments[generatedIndex + 1];
  const renderedDigest = segments[generatedIndex + 2];
  if (!DOCUMENT_ID_PATTERN.test(documentId) || !/^[a-f0-9]{64}$/i.test(renderedDigest)) return undefined;
  return { artifactId: normalized, documentId, renderedDigest };
}

export async function recordOfficeVisualQaProgress(input: {
  runId?: string;
  artifactId: string;
  action: 'index' | 'read' | 'report';
  result: FileArtifactOperationResult;
}): Promise<FileArtifactOperationResult> {
  if (!input.result.ok) return input.result;
  const identity = versionedRenderedArtifact(input.artifactId);
  if (!identity) return input.result;
  try {
    const payload = JSON.parse(String(input.result.actual || '')) as {
      kind?: string;
      screenshotCount?: number;
      screenshots?: Array<{ pageNumber?: number; screenshotDigest?: string }>;
      reviews?: Array<{
        pageNumber?: number;
        status?: 'failed' | 'passed';
        observation?: string;
        checks?: OfficeVisualQaPageChecks;
        issues?: Array<{ type?: string; description?: string; region?: string; severity?: 'error' | 'warning' }>;
      }>;
      deckReview?: {
        status?: 'failed' | 'passed';
        observation?: string;
        checks?: OfficeVisualQaDeckChecks;
        issues?: Array<{ type?: string; description?: string; region?: string; severity?: 'error' | 'warning' }>;
      };
    };
    return await withDraftLock(input.runId, identity.documentId, async () => {
      const draft = await loadDraft(input.runId, identity.documentId);
      if (draft.renderedArtifactId !== identity.artifactId || draft.renderedDigest !== identity.renderedDigest) {
        return { ok: false, actual: 'File visual QA progress rejected because the rendered artifact is no longer current.' };
      }
      if (draft.visualQaArtifactId !== identity.artifactId) {
        draft.visualQaArtifactId = identity.artifactId;
        draft.visualQaDigest = undefined;
        draft.visualQaPageCount = undefined;
        draft.visualQaSeenPages = [];
        draft.visualQaReviews = [];
        draft.visualQaDeckReview = undefined;
        draft.visualQaPageDigests = [];
      }
      const screenshotCount = Number(payload.screenshotCount);
      if (Number.isSafeInteger(screenshotCount) && screenshotCount > 0) draft.visualQaPageCount = screenshotCount;
      if (input.action === 'read' && payload.kind === 'file-visual-read') {
        const seen = new Set(draft.visualQaSeenPages || []);
        const pageDigests = new Map((draft.visualQaPageDigests || []).map((item) => [item.pageNumber, item.screenshotDigest]));
        const reviewed = new Map((draft.visualQaReviews || []).map((review) => [review.pageNumber, review]));
        const reviewCache = new Map((draft.visualQaReviewCache || []).map((review) => [review.screenshotDigest, review]));
        for (const screenshot of payload.screenshots || []) {
          const page = Number(screenshot.pageNumber);
          if (Number.isSafeInteger(page) && page > 0 && (!draft.visualQaPageCount || page <= draft.visualQaPageCount)) {
            seen.add(page);
            const screenshotDigest = String(screenshot.screenshotDigest || '');
            if (/^[a-f0-9]{64}$/i.test(screenshotDigest)) {
              pageDigests.set(page, screenshotDigest);
              const cached = reviewCache.get(screenshotDigest);
              if (cached?.status === 'passed') reviewed.set(page, {
                pageNumber: page,
                status: 'passed',
                observation: cached.observation,
                checks: cached.checks,
                issues: [],
              });
            }
          }
        }
        draft.visualQaSeenPages = [...seen].sort((left, right) => left - right);
        draft.visualQaPageDigests = [...pageDigests].map(([pageNumber, screenshotDigest]) => ({ pageNumber, screenshotDigest }));
        draft.visualQaReviews = [...reviewed.values()].sort((left, right) => left.pageNumber - right.pageNumber);
      }
      if (input.action === 'report' && payload.kind === 'file-visual-report') {
        const reviewed = new Map((draft.visualQaReviews || []).map((review) => [review.pageNumber, review]));
        const seen = new Set(draft.visualQaSeenPages || []);
        for (const review of payload.reviews || []) {
          const pageNumber = Number(review.pageNumber);
          if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || !seen.has(pageNumber)) {
            return { ok: false, actual: `File visual review rejected: page ${pageNumber || '?'} has not been read from the current artifact.` };
          }
          const issues = (review.issues || []).map((issue) => ({
            type: String(issue.type || '').trim(),
            description: String(issue.description || '').trim(),
            ...(issue.region ? { region: String(issue.region).trim() } : {}),
            ...(issue.severity ? { severity: issue.severity } : {}),
          })).filter((issue) => issue.type && issue.description);
          const observation = String(review.observation || '').trim();
          if (observation.length < 20) return { ok: false, actual: `File visual review rejected: page ${pageNumber} requires a concrete visual observation of at least 20 characters.` };
          const checkResult = failedPageVisualChecks(review.checks);
          if (checkResult.invalid.length) return { ok: false, actual: `File visual review rejected: page ${pageNumber} is missing or has invalid checks: ${checkResult.invalid.join(', ')}.` };
          if (review.status === 'passed' && issues.length) return { ok: false, actual: `File visual review rejected: passed page ${pageNumber} contains issues.` };
          if (review.status === 'failed' && !issues.length) return { ok: false, actual: `File visual review rejected: failed page ${pageNumber} requires issue details.` };
          if (review.status !== 'passed' && review.status !== 'failed') return { ok: false, actual: `File visual review rejected: page ${pageNumber} requires status passed or failed.` };
          if (review.status === 'passed' && checkResult.failed.length) return { ok: false, actual: `File visual review rejected: passed page ${pageNumber} contains failed checks: ${checkResult.failed.join(', ')}.` };
          if (review.status === 'failed' && !checkResult.failed.length) return { ok: false, actual: `File visual review rejected: failed page ${pageNumber} requires at least one failed check.` };
          const duplicateObservation = [...reviewed.values()].find((existing) => existing.pageNumber !== pageNumber && existing.observation === observation);
          if (duplicateObservation) return { ok: false, actual: `File visual review rejected: pages ${duplicateObservation.pageNumber} and ${pageNumber} reuse the same observation. Describe page-specific visible evidence.` };
          reviewed.set(pageNumber, { pageNumber, status: review.status, observation, checks: review.checks!, issues });
        }
        draft.visualQaReviews = [...reviewed.values()].sort((left, right) => left.pageNumber - right.pageNumber);
        const cache = new Map((draft.visualQaReviewCache || []).map((review) => [review.screenshotDigest, review]));
        const pageDigests = new Map((draft.visualQaPageDigests || []).map((item) => [item.pageNumber, item.screenshotDigest]));
        for (const review of draft.visualQaReviews) {
          const screenshotDigest = pageDigests.get(review.pageNumber);
          if (screenshotDigest) cache.set(screenshotDigest, {
            screenshotDigest,
            status: review.status,
            observation: review.observation,
            checks: review.checks,
            issues: review.issues,
          });
        }
        draft.visualQaReviewCache = [...cache.values()].slice(-1_000);
        if (payload.deckReview) {
          const observation = String(payload.deckReview.observation || '').trim();
          const issues = (payload.deckReview.issues || []).map((issue) => ({
            type: String(issue.type || '').trim(),
            description: String(issue.description || '').trim(),
            ...(issue.region ? { region: String(issue.region).trim() } : {}),
            ...(issue.severity ? { severity: issue.severity } : {}),
          })).filter((issue) => issue.type && issue.description);
          const checkResult = failedDeckVisualChecks(payload.deckReview.checks);
          const missingDesignChecks = missingDesignReviewChecks(draft.design, payload.deckReview.checks);
          if (missingDesignChecks.length) return { ok: false, actual: JSON.stringify({
            kind: 'file-design-review-incomplete', code: 'DESIGN_REVIEW_REQUIRED',
            documentId: draft.documentId, artifactId: identity.artifactId,
            missingChecks: missingDesignChecks, selectedDirection: draft.design?.selectedDirection,
            instruction: 'Include designIntent, compositionRhythm, contentConsistency and sourceTraceability in deckReview.checks. In observation cite page-specific layout comparisons, recomputed chart/callout arithmetic and actually accessed source rows/periods. Pixel checks alone cannot verify facts. Preserve failed checks and explain missing evidence. No re-render is needed unless a real source defect is found.',
          }) };
          if (observation.length < 30) return { ok: false, actual: 'File visual deckReview rejected: a concrete cross-page observation of at least 30 characters is required.' };
          if (checkResult.invalid.length) return { ok: false, actual: `File visual deckReview rejected: missing or invalid checks: ${checkResult.invalid.join(', ')}.` };
          if (payload.deckReview.status !== 'passed' && payload.deckReview.status !== 'failed') return { ok: false, actual: 'File visual deckReview rejected: status must be passed or failed.' };
          if (payload.deckReview.status === 'passed' && (issues.length || checkResult.failed.length)) return { ok: false, actual: 'File visual deckReview rejected: a passed review cannot contain issues or failed checks.' };
          if (payload.deckReview.status === 'failed' && (!issues.length || !checkResult.failed.length)) return { ok: false, actual: 'File visual deckReview rejected: a failed review requires issue details and at least one failed check.' };
          draft.visualQaDeckReview = {
            status: payload.deckReview.status,
            observation,
            checks: payload.deckReview.checks!,
            issues,
          };
        }
      }
      const pageCount = draft.visualQaPageCount || 0;
      const completeCoverage = pageCount > 0
        && Array.from({ length: pageCount }, (_, index) => index + 1).every((page) => draft.visualQaSeenPages?.includes(page));
      const reviews = new Map((draft.visualQaReviews || []).map((review) => [review.pageNumber, review]));
      const completePassingReview = pageCount > 0
        && Array.from({ length: pageCount }, (_, index) => index + 1)
          .every((pageNumber) => reviews.get(pageNumber)?.status === 'passed');
      const completeDeckReview = draft.visualQaDeckReview?.status === 'passed'
        && missingDesignReviewChecks(draft.design, draft.visualQaDeckReview?.checks).length === 0;
      draft.visualQaDigest = completeCoverage && completePassingReview && completeDeckReview ? identity.renderedDigest : undefined;
      draft.workflow = {
        state: draft.visualQaDigest === identity.renderedDigest ? 'completed' : 'qa-pending',
        checkpointAt: new Date().toISOString(),
        renderedDigest: identity.renderedDigest,
      };
      await saveDraft(input.runId, draft);
      return {
        ...input.result,
        actual: JSON.stringify({
          ...payload,
          visualQa: {
            artifactId: identity.artifactId,
            renderedDigest: identity.renderedDigest,
            visualQaDigest: draft.visualQaDigest || null,
            pageCount,
            seenPageCount: draft.visualQaSeenPages?.length || 0,
            seenPages: draft.visualQaSeenPages || [],
            reviewedPageCount: draft.visualQaReviews?.length || 0,
            failedPages: (draft.visualQaReviews || []).filter((review) => review.status === 'failed').map((review) => review.pageNumber),
            deckReviewStatus: draft.visualQaDeckReview?.status || null,
            requiredDesignChecks: officeDesignGuidance(draft).requiredDeckChecks,
            complete: draft.visualQaDigest === identity.renderedDigest && completeCoverage && completePassingReview && completeDeckReview,
          },
        }),
      };
    });
  } catch (error) {
    return { ok: false, actual: `File visual QA state update failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
