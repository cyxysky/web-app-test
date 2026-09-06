import { recordOfficeVisualQaProgress, verifyCurrentUnoRenderedArtifact } from './workspace-visual-qa.js';
export { verifyCurrentUnoRenderedArtifact, recordOfficeVisualQaProgress } from './workspace-visual-qa.js';
import { officeValidationRepairHints, semanticGenerationPlan } from './workspace-result.js';
export { officeValidationRepairHints, formatFileArtifactResult } from './workspace-result.js';
import { loadDraft, saveDraft, saveWorkingDraft, withDraftLock, requireDocumentId, DOCUMENT_ID_PATTERN, artifactDir, sanitizeFileName, draftProgramPath } from './workspace-draft-store.js';

import { currentNodeFileWorkspaceHost, resolveNodeFileWorkspaceHost, type ResolvedNodeFileWorkspaceHost, type NodeFileWorkspaceHost, nodeFileWorkspaceHost } from './workspace-host.js';
export { type NodeFileWorkspaceHost, disposeDefaultNodeFileWorkspace } from './workspace-host.js';
import { sourceUnitsForDraft, applyUnoDraftPatchHunks, applyUnoDraftReplacements, synchronizeSourceUnits, isolateSourceUnit, replaceSourceUnit, draftSourceLineCount, normalizedDraftSource, type ParsedSourceUnit, sourceDigest, type UnoDraftPatchResult, normalizedSourceUnitPath } from './workspace-source-editor.js';
export { sourceUnitsForDraft, applyUnoDraftPatch, type UnoDraftPatchHunkFailure, type UnoDraftPatchResult, applyUnoDraftPatchHunks, applyUnoDraftReplacements } from './workspace-source-editor.js';

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, type Dirent } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';

import type { FileArtifactOperationResult, FileAttachmentBinding } from '../types.js';
import { generateFileToPaths } from './generate.js';
import { type NodeFileConvertInput, type NodeFileConvertExecutionOptions } from './convert.js';
import { type NodeFileDownloadInput, type NodeFileDownloadExecutionOptions } from './download.js';

import { inspectUnoApi, isUnoBridgeStartupError, isUnoStylePropertyInfoError, isUnoWorkerInternalError } from './office/uno.js';
import { validateOfficeArtifact, type OfficeElementMapEntry } from './office/validation.js';
import { validateOfficeRendererMatrix } from './office/render-validation.js';
import { analyzeOfficeProgram, diagnoseOfficeProgramRuntimeError, type OfficeProgramDiagnostic } from './office/program-analysis.js';
import type { OfficeDocumentDraft, OfficeDocumentKind, OfficeSemanticDocumentInput } from '../office/types.js';
import { registerOfficePreview, type FilePreviewResult } from './office/preview.js';
import { officeGenerationRuntimeFingerprint } from './office/runtime-fingerprint.js';
import { beginOfficeValidation, currentUnoWorkerDigest, officeValidationEvidence } from './office/validation-evidence.js';
import { compileOfficeSemanticDocument } from './office/semantic.js';
import { officeDesignBriefSchema, officeDesignGuidance } from '../design-guidance.js';

function officeOperationWasInterrupted(error: unknown, abortSignal?: AbortSignal) {
  if (abortSignal?.aborted) return true;
  return /(?:AbortError|operation (?:was )?aborted)/i
    .test(error instanceof Error ? error.message : String(error));
}

const TOOL_ERROR_MAX_CHARACTERS = 6_000;
const OFFICE_PIPELINE_VERSION = 'office-pipeline-v13-cjk-shared-preview';

export type PlanArtifactInput = {
  abortSignal?: AbortSignal;
  runId?: string;
  documentId?: string;
  fileName?: string | null;
  documentType?: OfficeDocumentKind;
  intent?: string;
  design?: OfficeDocumentDraft['design'];
  operation?: 'create' | 'modify';
  sourceAttachmentId?: string;
  attachmentBindings?: FileAttachmentBinding[];
};

export type GenerateUnoProgramInput = {
  runId?: string;
  documentId?: string;
  program?: string;
  /** Compact semantic create input compiled into the existing validated UNO draft pipeline. */
  spec?: OfficeSemanticDocumentInput;
  /** Required with baseDigest for an intentional complete source replacement. */
  replaceExisting?: boolean;
  baseDigest?: string;
  render?: boolean;
  includeVisualVerification?: boolean;
  attachmentBindings?: FileAttachmentBinding[];
  abortSignal?: AbortSignal;
  onProgress?: (progress: FileGenerationProgress) => void | Promise<void>;
};

export type FileGenerationProgress = {
  phase: string;
  message: string;
  current?: number;
  total?: number;
};

export type EditUnoProgramInput = {
  runId?: string;
  documentId?: string;
  /** Optional @webpilot-unit path. The patch is scoped to that page/section source unit. */
  path?: string;
  /** Exact digest returned by the latest read for this draft or selected source unit. */
  baseDigest?: string;
  /** Codex apply_patch document. Each well-formed @@ hunk is applied independently. */
  patch?: string;
  /** Exact, unique source replacements; mutually exclusive with patch. */
  replacements?: Array<{ oldText: string; newText: string }>;
  program?: string;
  render?: boolean;
  includeVisualVerification?: boolean;
  attachmentBindings?: FileAttachmentBinding[];
  abortSignal?: AbortSignal;
  onProgress?: (progress: FileGenerationProgress) => void | Promise<void>;
};

export type UnoApiInput = {
  abortSignal?: AbortSignal;
  runId?: string;
  documentId?: string;
  documentType?: OfficeDocumentKind;
  query?: string;
  offset?: number;
  limit?: number;
};

export type ReadUnoDraftInput = {
  abortSignal?: AbortSignal;
  runId?: string;
  documentId?: string;
  path?: string;
  /** One-based window; unit-relative when an existing source-unit path is supplied. */
  startLine?: number;
  endLine?: number;
  includeDiagnostics?: boolean;
};

export type RenderArtifactInput = {
  runId?: string;
  documentId?: string;
  includeVisualVerification?: boolean;
  attachmentBindings?: FileAttachmentBinding[];
  abortSignal?: AbortSignal;
  onProgress?: (progress: FileGenerationProgress) => void | Promise<void>;
};

function compactToolText(value: unknown, limit = TOOL_ERROR_MAX_CHARACTERS) {
  const text = String(value || '');
  if (text.length <= limit) return text;
  // Python's actionable exception is at the end, after the call stack.
  // Preserve both origin and cause instead of truncating away the actual error.
  const tailSize = Math.min(900, Math.floor(limit / 2));
  const headSize = limit - tailSize;
  return `${text.slice(0, headSize)}\n… ${text.length - limit} characters omitted …\n${text.slice(-tailSize)}`;
}

function compactValidationDiagnosticsForTool(
  diagnostics: OfficeDocumentDraft['validationDiagnostics'],
): NonNullable<OfficeDocumentDraft['validationDiagnostics']> {
  const values = diagnostics || [];
  return values.map((diagnostic) => {
    const normalized = isUnoStylePropertyInfoError(diagnostic.message)
      ? { ...diagnoseOfficeProgramRuntimeError('', diagnostic.message)[0] }
      : diagnostic;
    return { ...normalized, message: compactToolText(normalized.message, 1_500) };
  });
}

function compactWorkflowForTool(workflow: OfficeDocumentDraft['workflow']) {
  return workflow ? { ...workflow, error: workflow.error ? compactToolText(workflow.error) : undefined } : undefined;
}

type DocumentAsset = {
  assetName: string;
  bytes: number;
  sha256: string;
  origin: 'attachment' | 'download' | 'generated';
  ref?: string;
  width?: number;
  height?: number;
  optimized?: boolean;
};

function describeDocumentAsset(asset: DocumentAsset) {
  return {
    assetName: asset.assetName,
    bytes: asset.bytes,
    sha256: asset.sha256,
    origin: asset.origin,
    ref: asset.ref,
    format: path.extname(asset.assetName).replace(/^\./, '').toLowerCase() || undefined,
    width: asset.width,
    height: asset.height,
    aspectRatio: asset.width && asset.height ? asset.width / asset.height : undefined,
    optimized: asset.optimized,
  };
}

async function sha256File(filePath: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function optimizeWorkspaceImage(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  if (!['.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp'].includes(extension)) return {};
  const metadata = await sharp(filePath, { failOn: 'none' }).metadata();
  const width = metadata.width;
  const height = metadata.height;
  const shouldOptimize = Boolean(
    metadata.orientation
    || metadata.space === 'cmyk'
    || (width && height && (width > 4096 || height > 4096 || width * height > 20_000_000)),
  );
  if (!shouldOptimize) return { width, height, optimized: false };
  const temporary = `${filePath}.${randomUUID()}.optimized${extension}`;
  try {
    let pipeline = sharp(filePath, { failOn: 'none' })
      .rotate()
      .resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true })
      .toColorspace('srgb');
    if (extension === '.jpg' || extension === '.jpeg') pipeline = pipeline.jpeg({ quality: 88, mozjpeg: true });
    else if (extension === '.png') pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
    else if (extension === '.webp') pipeline = pipeline.webp({ quality: 88 });
    else pipeline = pipeline.tiff({ compression: 'lzw' });
    await pipeline.toFile(temporary);
    await rename(temporary, filePath);
    const optimizedMetadata = await sharp(filePath, { failOn: 'none' }).metadata();
    return { width: optimizedMetadata.width, height: optimizedMetadata.height, optimized: true };
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

const documentExtensions: Record<OfficeDocumentKind, Set<string>> = {
  presentation: new Set(['.ppt', '.pptx', '.odp']),
  spreadsheet: new Set(['.xls', '.xlsx', '.ods']),
  word: new Set(['.doc', '.docx', '.odt']),
};
const javascriptOfficeExtensions = new Set(['.docx', '.pptx', '.xlsx', '.pdf']);

function configuredOfficeGenerator(fileName: string, operation: 'create' | 'modify'):
  OfficeDocumentDraft['generator'] {
  if (operation === 'modify') return 'uno';
  const configured = currentNodeFileWorkspaceHost().officeGenerationMode;
  const extension = path.extname(fileName).toLowerCase();
  if (configured === 'javascript') {
    if (!javascriptOfficeExtensions.has(extension)) {
      throw new Error('JavaScript Office generation supports .pptx, .docx, .xlsx, and PDF converted from the matching Office source. Select UNO mode for binary Office or OpenDocument output.');
    }
    return 'javascript';
  }
  if (configured === 'auto' && javascriptOfficeExtensions.has(extension)) return 'javascript';
  return 'uno';
}

async function plannedSourceDocument(input: PlanArtifactInput, assets: DocumentAsset[]) {
  const matchingBindings = (input.attachmentBindings || []).filter((binding) => (
    input.documentType && documentExtensions[input.documentType].has(path.extname(binding.name).toLowerCase())
  ));
  // Never infer an existing-file edit from natural-language intent. A request
  // can mention "fix" or "revise" while it is still creating a new document.
  // Modification is an explicit API contract: operation=modify or a selected
  // sourceAttachmentId.
  const inferredModify = input.operation === 'modify' || Boolean(input.sourceAttachmentId);
  if (!inferredModify) return { operation: 'create' as const, sourceDocument: undefined };
  const binding = input.sourceAttachmentId
    ? matchingBindings.find((item) => item.ref === input.sourceAttachmentId)
    : matchingBindings.length === 1 ? matchingBindings[0] : undefined;
  if (!binding) {
    const reason = input.sourceAttachmentId
      ? 'sourceAttachmentId is not a registered Office attachment matching documentType'
      : matchingBindings.length > 1
        ? 'multiple matching Office attachments are available; sourceAttachmentId is required'
        : 'no matching Office attachment is available';
    throw new Error(`Existing-file modification requires a source Office attachment: ${reason}.`);
  }
  const requestedExtension = path.extname(String(input.fileName || '')).toLowerCase();
  const sourceExtension = path.extname(binding.name).toLowerCase();
  if (requestedExtension !== sourceExtension) {
    throw new Error(`Existing-file modification must preserve the source format (${sourceExtension}); requested output uses ${requestedExtension || 'no extension'}. Create a separate documentId for format conversion.`);
  }
  const asset = assets.find((item) => item.origin === 'attachment' && item.ref === binding.ref);
  if (!asset) throw new Error('The selected source attachment could not be mounted into the document workspace.');
  return {
    operation: 'modify' as const,
    sourceDocument: {
      assetName: asset.assetName,
      attachmentId: binding.ref,
      bytes: asset.bytes,
      fileName: binding.name,
      sha256: asset.sha256,
    },
  };
}

function assetFileName(name: string, namespace: string, claimed: Set<string>) {
  const direct = sanitizeFileName(name, 'asset.bin');
  const normalizedNamespace = sanitizeFileName(namespace, 'asset').slice(0, 48);
  const parsed = path.parse(direct);
  const base = `${normalizedNamespace}-${parsed.name}${parsed.ext}`;
  if (!claimed.has(base.toLowerCase())) {
    claimed.add(base.toLowerCase());
    return base;
  }
  const alternate = `${normalizedNamespace}-${randomUUID().slice(0, 8)}-${parsed.name}${parsed.ext}`;
  claimed.add(alternate.toLowerCase());
  return alternate;
}

async function visibleFiles(directory: string) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && !entry.name.startsWith('.'));
  } catch {
    return [];
  }
}

async function visibleFilesRecursive(directory: string, relative = ''): Promise<Array<{ name: string; path: string }>> {
  try {
    const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
    const files: Array<{ name: string; path: string }> = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const childRelative = path.join(relative, entry.name);
      if (entry.isDirectory()) files.push(...await visibleFilesRecursive(directory, childRelative));
      else if (entry.isFile()) files.push({
        name: childRelative.replace(/[\\/]+/g, '-'),
        path: path.join(directory, childRelative),
      });
    }
    return files;
  } catch {
    return [];
  }
}

/**
 * Materialize the only local filesystem visible to an Office draft.  This is
 * a per-run, copied asset workspace: uploads, downloads, and final generated
 * artifacts are available by deterministic names, never by host paths.
 */
export async function syncDocumentAssets(
  runId: string | undefined,
  attachmentBindings: FileAttachmentBinding[] = [],
): Promise<DocumentAsset[]> {
  const destination = artifactDir(runId, 'document-assets');
  await mkdir(destination, { recursive: true });
  const cachePath = path.join(destination, '.asset-cache.json');
  type CachedAsset = Pick<DocumentAsset, 'bytes' | 'height' | 'optimized' | 'sha256' | 'width'> & { pipelineVersion: string; sourceSha256: string };
  let cache: Record<string, CachedAsset> = {};
  try {
    cache = JSON.parse(await readFile(cachePath, 'utf8')) as Record<string, CachedAsset>;
  } catch {
    // The asset cache is optional and recreated after an interrupted write.
  }
  const sources: Array<{ name: string; path: string; origin: DocumentAsset['origin']; ref?: string }> = [];
  for (const binding of attachmentBindings) {
    if (!binding.name || !binding.path) continue;
    sources.push({ name: binding.name, path: binding.path, origin: 'attachment', ref: binding.ref });
  }
  for (const origin of ['downloads', 'generated'] as const) {
    const directory = artifactDir(runId, origin);
    const files = origin === 'generated'
      ? await visibleFilesRecursive(directory)
      : (await visibleFiles(directory)).map((entry) => ({ name: entry.name, path: path.join(directory, entry.name) }));
    for (const entry of files) {
      sources.push({ name: entry.name, path: entry.path, origin: origin === 'downloads' ? 'download' : 'generated' });
    }
  }
  const claimed = new Set<string>();
  const result: DocumentAsset[] = [];
  for (const source of sources) {
    try {
      const metadata = await stat(source.path);
      if (!metadata.isFile()) continue;
      const assetName = assetFileName(
        source.name,
        source.origin === 'attachment' ? `attachment-${source.ref || 'file'}` : source.origin,
        claimed,
      );
      const target = path.join(destination, assetName);
      const sourceSha256 = await sha256File(source.path);
      const cached = cache[assetName];
      if (cached?.pipelineVersion === OFFICE_PIPELINE_VERSION && cached.sourceSha256 === sourceSha256) {
        try {
          const cachedMetadata = await stat(target);
          if (cachedMetadata.isFile() && cachedMetadata.size === cached.bytes && await sha256File(target) === cached.sha256) {
            result.push({ assetName, bytes: cached.bytes, sha256: cached.sha256, origin: source.origin, ref: source.ref, width: cached.width, height: cached.height, optimized: cached.optimized });
            continue;
          }
        } catch {
          // Rebuild a missing cached derivative below.
        }
      }
      await copyFile(source.path, target);
      const image = await optimizeWorkspaceImage(target).catch(() => ({}));
      const copiedMetadata = await stat(target);
      const asset: DocumentAsset = { assetName, bytes: copiedMetadata.size, sha256: await sha256File(target), origin: source.origin, ref: source.ref, ...image };
      result.push(asset);
      cache[assetName] = { pipelineVersion: OFFICE_PIPELINE_VERSION, sourceSha256, bytes: asset.bytes, sha256: asset.sha256, width: asset.width, height: asset.height, optimized: asset.optimized };
    } catch {
      // A stale upload or artifact must not make unrelated document authoring fail.
    }
  }
  await writeFile(cachePath, JSON.stringify(cache), 'utf8').catch(() => undefined);
  return result;
}

function artifactResultPayload(input: {
  filePath: string;
  fileName: string;
  bytes: number;
  sourceUrl?: string;
  kind: 'download' | 'generated';
}) {
  const host = currentNodeFileWorkspaceHost();
  const root = host.artifactsRoot;
  const relative = path.relative(root, input.filePath).replace(/\\/g, '/');
  const url = relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? host.artifactUrl({ absolutePath: path.resolve(input.filePath), relativePath: relative })
    : undefined;
  return {
    artifactId: relative,
    kind: input.kind,
    fileName: input.fileName,
    path: input.filePath,
    url,
    downloadUrl: url ? `${url}?download=1` : undefined,
    bytes: input.bytes,
    sourceUrl: input.sourceUrl,
  };
}

async function resolveEditDocumentId(
  runId: string | undefined,
  value: string | undefined,
  baseDigest: string | undefined,
) {
  const supplied = String(value || '').trim();
  if (supplied) return requireDocumentId(supplied, 'edit');

  const drafts = (await listOfficeDraftCatalog(runId)).filter((draft) => Boolean(draft.sourceDigest));
  const normalizedDigest = String(baseDigest || '').trim().toLowerCase();
  const digestMatches = /^[a-f0-9]{64}$/.test(normalizedDigest)
    ? drafts.filter((draft) => String(draft.sourceDigest || '').toLowerCase() === normalizedDigest)
    : [];
  if (digestMatches.length === 1) return digestMatches[0].documentId;
  if (drafts.length === 1) return drafts[0].documentId;

  const candidates = drafts.map((draft) => draft.documentId).join(', ') || '(none)';
  throw new Error(
    `file action=edit could not infer documentId because this conversation has ${drafts.length} editable drafts: ${candidates}. `
    + 'Copy documentId from list or the latest readSource result; artifactId is not a source identity.',
  );
}

export async function downloadFileArtifact(
  input: NodeFileDownloadInput,
  options?: NodeFileDownloadExecutionOptions,
): Promise<FileArtifactOperationResult> {
  return currentNodeFileWorkspaceHost().downloader.download(input, options);
}
export async function convertFileArtifact(
  input: NodeFileConvertInput,
  options?: NodeFileConvertExecutionOptions,
): Promise<FileArtifactOperationResult> {
  return currentNodeFileWorkspaceHost().converter.convert(input, options);
}

export type OfficeDraftCatalogEntry = {
  documentId: string;
  documentType: OfficeDocumentKind;
  fileName: string;
  generator: 'javascript' | 'uno';
  sourceDigest: string | null;
  validatedSourceDigest: string | null;
  validationStatus: OfficeDocumentDraft['validationStatus'] | null;
  validationFailureCount: number;
  validationEvidence?: ReturnType<typeof officeValidationEvidence>;
  renderedDigest: string | null;
  visualQaDigest: string | null;
  visualQaFailedPages?: number[];
  visualQaFailureSummary?: string[];
  visualQaDeckStatus?: 'failed' | 'passed';
  state: NonNullable<OfficeDocumentDraft['workflow']>['state'];
  updatedAt: string;
};

export async function listOfficeDraftCatalog(runId: string | undefined): Promise<OfficeDraftCatalogEntry[]> {
  const directory = artifactDir(runId, 'document-drafts');
  let entries: Dirent<string>[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code || '') : '';
    if (code === 'ENOENT') return [];
    throw error;
  }
  const catalog: OfficeDraftCatalogEntry[] = [];
  const workerDigest = await currentUnoWorkerDigest();
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.') || !entry.name.endsWith('.json')) continue;
    const documentId = entry.name.slice(0, -'.json'.length);
    if (!DOCUMENT_ID_PATTERN.test(documentId)) continue;
    try {
      const draft = await loadDraft(runId, documentId);
      const failedReviews = (draft.visualQaReviews || []).filter((review) => review.status === 'failed');
      catalog.push({
        documentId: draft.documentId,
        documentType: draft.documentType,
        fileName: draft.fileName,
        generator: draft.generator || 'uno',
        sourceDigest: draft.sourceDigest || null,
        validatedSourceDigest: draft.validatedSourceDigest || null,
        validationStatus: draft.validationStatus || null,
        validationFailureCount: draft.validationFailureCount || 0,
        validationEvidence: officeValidationEvidence(draft, workerDigest),
        renderedDigest: draft.renderedDigest || null,
        visualQaDigest: draft.visualQaDigest || null,
        visualQaFailedPages: failedReviews.map((review) => review.pageNumber),
        visualQaFailureSummary: failedReviews.flatMap((review) => review.issues
          .map((issue) => `page ${review.pageNumber}: ${issue.type}: ${issue.description}`))
          .concat((draft.visualQaDeckReview?.issues || []).map((issue) => `whole artifact: ${issue.type}: ${issue.description}`))
          .slice(0, 20),
        visualQaDeckStatus: draft.visualQaDeckReview?.status,
        state: draft.workflow?.state || (draft.program ? 'authoring' : 'planned'),
        updatedAt: draft.updatedAt,
      });
    } catch {
      // A corrupt sidecar is reported when addressed directly; it must not hide healthy drafts.
    }
  }
  return catalog.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function listOfficeDrafts(input: { runId?: string }): Promise<FileArtifactOperationResult> {
  try {
    const drafts = await listOfficeDraftCatalog(input.runId);
    return { ok: true, actual: JSON.stringify({ kind: 'office-draft-catalog', drafts: drafts.map((draft) => ({
      ...draft, sourceRead: { action: 'readSource', documentId: draft.documentId },
    })) }) };
  } catch (error) {
    return { ok: false, actual: `Office draft list failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function officeDraftCatalogForPrompt(runId: string | undefined) {
  const drafts = await listOfficeDraftCatalog(runId);
  if (!drafts.length) return '';
  return [
    '[Current Office draft catalog - saved validation may be historical]',
    'Resume an existing logical document with its exact documentId. Do not guess an ID or create a replacement unless the user explicitly requests a new document.',
    'For source/diagnostics: file(action=readSource, documentId=...). Read one code window, then edit. readContent + artifactId reads the finished file, NOT its source. Digests listed below are state metadata; get edit.baseDigest from readSource.patchBaseDigest.',
    'validationFailureCount counts failed validations in the repair sequence, possibly with different sources/causes. It is NOT a bridge retry count. validationEvidence freshness=stale/unknown cannot justify a current infrastructure blocker: on task resumption, obtain one fresh render result, then act on that result without unchanged retry loops. A current source-unit check is not full-document validation.',
    ...drafts.slice(0, 100).map((draft) => `- documentId=${draft.documentId} | type=${draft.documentType} | file=${JSON.stringify(draft.fileName)} | state=${draft.state} | validationStatus=${draft.validationStatus || 'none'} | validationEvidence=${JSON.stringify(draft.validationEvidence ? { freshness: draft.validationEvidence.freshness, reason: draft.validationEvidence.reason, checkedAt: draft.validationEvidence.checkedAt, scope: draft.validationEvidence.scope, stage: draft.validationEvidence.stage } : null)} | validationFailureCount=${draft.validationFailureCount} | sourceDigest=${draft.sourceDigest || 'none'} | validatedSourceDigest=${draft.validatedSourceDigest || 'none'} | renderedDigest=${draft.renderedDigest || 'none'} | visualQaDigest=${draft.visualQaDigest || 'none'} | visualQaDeckStatus=${draft.visualQaDeckStatus || 'none'}${draft.visualQaFailedPages?.length || draft.visualQaDeckStatus === 'failed' ? ` | visualQaFailedPages=${draft.visualQaFailedPages?.join(',') || 'none'} | visualQaFailures=${JSON.stringify(draft.visualQaFailureSummary || [])}` : ''} | updatedAt=${draft.updatedAt}`),
  ].join('\n');
}

function invalidateActiveVisualQa(draft: OfficeDocumentDraft) {
  draft.visualQaArtifactId = undefined;
  draft.visualQaDigest = undefined;
  draft.visualQaPageCount = undefined;
  draft.visualQaSeenPages = [];
  draft.visualQaReviews = [];
  draft.visualQaDeckReview = undefined;
  draft.visualQaPageDigests = [];
}

// Office generators often contain dense Python statements. Large source
// windows can consume tens of thousands of model tokens and trigger a loop in
// which context compaction discards the source before the edit is submitted.
// Keep reads small and stream repairs as one bounded read followed by one edit.
const LARGE_SOURCE_LINE_THRESHOLD = 120;
const MAX_SOURCE_READ_LINES = 80;

function sourceUnitForRequestedPath(units: ParsedSourceUnit[], requestedPath: string | undefined) {
  if (!requestedPath) return undefined;
  return units.find((unit) => unit.path === requestedPath);
}

async function readUnoDraftUnlocked(input: ReadUnoDraftInput): Promise<FileArtifactOperationResult> {
  try {
    const documentId = String(input.documentId || '').trim();
    if (!documentId) return { ok: false, actual: 'file action=readSource requires documentId. To inspect file text/data instead, use readContent with artifactId or attachmentId.' };
    const draft = await loadDraft(input.runId, documentId);
    if (!draft.program) return { ok: false, actual: `Office draft ${documentId} has no source yet; call action=generate first.` };
    let units: ParsedSourceUnit[] = [];
    let sourceIndexError: string | undefined;
    try {
      units = sourceUnitsForDraft(draft.program, draft);
    } catch (error) {
      sourceIndexError = error instanceof Error ? error.message : String(error);
      if (!/^(?:Office source unit |Duplicate Office source unit path:)/.test(sourceIndexError)) throw error;
      // A broken optional index must not make the actual source unreadable.
      // Keep validation strict, but allow exact global-window repairs.
    }
    const requestedPath = input.path ? normalizedSourceUnitPath(input.path) : undefined;
    const requestedUnit = sourceUnitForRequestedPath(units, requestedPath);
    const hasBoundedFallback = Boolean(
      requestedPath
      && !requestedUnit
      && (input.startLine !== undefined || input.endLine !== undefined),
    );
    if (requestedPath && !requestedUnit && !hasBoundedFallback) {
      const available = units.map((unit) => unit.path).join(', ') || '(none)';
      return { ok: false, actual: `Office source unit ${requestedPath} does not exist. Available source units: ${available}. For shared helpers or unmarked sources, read a bounded startLine/endLine window instead.` };
    }
    const readableSource = requestedUnit?.content ?? draft.program;
    const readableLines = normalizedDraftSource(readableSource).split('\n');
    const totalReadableLines = draftSourceLineCount(readableSource);
    const requestedStart = input.startLine === undefined ? undefined : Number(input.startLine);
    const requestedEnd = input.endLine === undefined ? undefined : Number(input.endLine);
    if (requestedStart !== undefined && (!Number.isInteger(requestedStart) || requestedStart < 1)) {
      return { ok: false, actual: 'Office draft read startLine must be a positive one-based integer.' };
    }
    if (requestedEnd !== undefined && (!Number.isInteger(requestedEnd) || requestedEnd < 1)) {
      return { ok: false, actual: 'Office draft read endLine must be a positive one-based integer.' };
    }
    const explicitRange = requestedStart !== undefined || requestedEnd !== undefined;
    // A bounded read of a named source unit uses unit-relative coordinates.
    // Models naturally ask for symbols/foo startLine=1; requiring the unit's
    // global offset made otherwise valid reads fail and encouraged stale edits.
    // Unbounded unit reads keep their historical global range metadata.
    const unitRelativeRange = Boolean(requestedUnit && explicitRange);
    const coordinateOffset = requestedUnit && !unitRelativeRange ? requestedUnit.startLine - 1 : 0;
    const coordinateStart = coordinateOffset + 1;
    const coordinateEnd = coordinateOffset + totalReadableLines;
    const boundedRequestedStart = requestedStart === undefined ? undefined : Math.min(requestedStart, coordinateEnd);
    const boundedRequestedEnd = requestedEnd === undefined ? undefined : Math.min(requestedEnd, coordinateEnd);
    const rangeStart = boundedRequestedStart ?? (boundedRequestedEnd === undefined
      ? coordinateStart
      : Math.max(coordinateStart, boundedRequestedEnd - MAX_SOURCE_READ_LINES + 1));
    const requestedRangeEnd = boundedRequestedEnd ?? (boundedRequestedStart === undefined
      ? Math.min(coordinateEnd, coordinateStart + MAX_SOURCE_READ_LINES - 1)
      : Math.min(coordinateEnd, rangeStart + MAX_SOURCE_READ_LINES - 1));
    const rangeEnd = Math.min(requestedRangeEnd, rangeStart + MAX_SOURCE_READ_LINES - 1);
    if (rangeStart < coordinateStart || rangeStart > rangeEnd || rangeEnd > coordinateEnd) {
      return { ok: false, actual: `Office draft read range ${rangeStart}-${rangeEnd} is outside the current global ${coordinateStart}-${coordinateEnd} source lines${requestedUnit ? ` for unit ${requestedUnit.path}` : ''}.` };
    }
    const omitLargeProgram = !explicitRange && (
      requestedUnit
        ? totalReadableLines > MAX_SOURCE_READ_LINES
        : totalReadableLines > LARGE_SOURCE_LINE_THRESHOLD
    );
    const localRangeStart = rangeStart - coordinateOffset;
    const localRangeEnd = rangeEnd - coordinateOffset;
    const returnedSource = omitLargeProgram
      ? ''
      : readableLines.slice(localRangeStart - 1, localRangeEnd).join('\n');
    const diagnostics = draft.validationDiagnostics || [];
    return {
      ok: true,
      actual: JSON.stringify({
        kind: 'uno-draft',
        readKind: 'source',
        sourceIndexError,
        sourceIndexRecovery: sourceIndexError
          ? 'Source-unit markers are malformed. Read/edit by global startLine/endLine without path using patchBaseDigest; repair the markers. The source buffer is still available and no render is required.'
          : undefined,
        sourceLanguage: draft.generator === 'javascript' ? 'javascript' : 'python',
        documentId: draft.documentId,
        sourceFileName: path.basename(draftProgramPath(input.runId, documentId, draft.generator)),
        // Recover the brief after compaction without replaying it on every bounded code read.
        design: !explicitRange && !requestedUnit ? draft.design : undefined,
        sourceUnitDigest: requestedUnit ? sourceDigest(readableSource) : undefined,
        // A patch is optimistic-concurrency controlled against the complete
        // draft, even when the read was scoped to one unit. edit accepts this
        // digest both with and without the optional source-unit path.
        patchBaseDigest: sourceDigest(draft.program),
        validationStatus: draft.validationStatus || 'pending',
        validationEvidence: officeValidationEvidence(draft, await currentUnoWorkerDigest()),
        validationFailureCount: draft.validationFailureCount || 0,
        validationFailureCountMeaning: 'Failed validations in this repair sequence; may have different causes/source versions. Not a count of bridge startup failures.',
        diagnosticCounts: {
          errors: diagnostics.filter((item) => item.severity === 'error').length,
          warnings: diagnostics.filter((item) => item.severity === 'warning').length,
        },
        // Reading code is not a replay of the full document validation report.
        // Keep saved diagnostics available explicitly, including genuine errors.
        validationDiagnostics: input.includeDiagnostics === true
          ? compactValidationDiagnosticsForTool(diagnostics) : undefined,
        sourceUnitPath: requestedUnit?.path,
        requestedPathIgnored: hasBoundedFallback ? requestedPath : undefined,
        sourceUnitKind: requestedUnit?.kind,
        sourceUnitGlobalLines: requestedUnit ? { startLine: requestedUnit.startLine, endLine: requestedUnit.endLine } : undefined,
        sourceUnitCount: !explicitRange && !requestedUnit ? units.length : undefined,
        sourceUnits: !explicitRange && !requestedUnit
          ? units.map((unit) => ({
            inferred: unit.inferred === true,
            kind: unit.kind,
            path: unit.path,
            sourceDigest: sourceDigest(unit.content),
            lineCount: draftSourceLineCount(unit.content),
            status: draft.sourceUnits?.find((state) => state.path === unit.path)?.status || 'pending',
          }))
          : undefined,
        lineCount: totalReadableLines,
        returnedLineCount: omitLargeProgram ? 0 : localRangeEnd - localRangeStart + 1,
        requestedRangeTruncated: !omitLargeProgram && rangeEnd < requestedRangeEnd,
        nextRead: !omitLargeProgram && rangeEnd < requestedRangeEnd ? {
          action: 'readSource', documentId: draft.documentId,
          ...(requestedUnit ? { path: requestedUnit.path } : {}),
          startLine: requestedUnit && !unitRelativeRange ? localRangeEnd + 1 : rangeEnd + 1,
          endLine: requestedUnit && !unitRelativeRange
            ? Math.min(localRangeEnd + MAX_SOURCE_READ_LINES, totalReadableLines)
            : Math.min(rangeEnd + MAX_SOURCE_READ_LINES, requestedRangeEnd),
        } : undefined,
        programOmitted: omitLargeProgram || undefined,
        sourceLineRange: omitLargeProgram ? undefined : {
          startLine: rangeStart,
          endLine: rangeEnd,
          coordinateSpace: unitRelativeRange ? 'unit' : 'global',
          totalSourceLines: draftSourceLineCount(draft.program),
          unitLineCount: requestedUnit ? totalReadableLines : undefined,
          globalStartLine: requestedUnit && unitRelativeRange ? requestedUnit.startLine + rangeStart - 1 : undefined,
          globalEndLine: requestedUnit && unitRelativeRange ? requestedUnit.startLine + rangeEnd - 1 : undefined,
        },
        readGuidance: omitLargeProgram
          ? `This ${totalReadableLines}-line ${requestedUnit ? 'source unit' : 'draft'} is too large for an unbounded read. ${requestedUnit ? `Read the same path ${requestedUnit.path} with ` : 'Read one sourceUnits path, or use '}startLine/endLine around the reported diagnostic (maximum ${MAX_SOURCE_READ_LINES} lines). If endLine exceeds EOF it is automatically clamped. The returned program preserves exact whitespace for a Codex-format patch.`
          : rangeEnd < requestedRangeEnd
            ? 'Only sourceLineRange is included in program. Continue with nextRead only if those remaining lines are needed; do not reread this window. lineCount is the total size of the source/unit, not the amount returned.'
            : undefined,
        patchGuidance: omitLargeProgram ? undefined
          : 'Use patchBaseDigest as edit.baseDigest. Prefer replacements:[{oldText,newText}] for small fixes; copy exact program whitespace. All edits locate unique targets on this pre-edit snapshot and commit together or none do. No fuzzy matching or stale-version rebase. In patch, put -old/+new in the same @@ hunk, separate from ALL source indentation. Inspect saved and validation separately.',
        readFallbackGuidance: hasBoundedFallback
          ? `The requested path ${requestedPath} is not a known source unit, so the supplied startLine/endLine were applied to the complete draft instead.`
          : undefined,
        program: omitLargeProgram ? undefined : returnedSource,
      }),
    };
  } catch (error) {
    return { ok: false, actual: `Office draft read failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function getUnoApi(input: UnoApiInput): Promise<FileArtifactOperationResult> {
  const documentId = String(input.documentId || '').trim();
  if (!documentId) return getUnoApiUnlocked(input);
  try {
    // Catalog delivery updates draft metadata. Serialize it with edit/render so
    // an API read cannot write back an older program or erase its edit receipt.
    return await withDraftLock(input.runId, documentId, () => getUnoApiUnlocked({ ...input, documentId }), input.abortSignal);
  } catch (error) {
    return { ok: false, actual: `UNO API inspection failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function getUnoApiUnlocked(input: UnoApiInput): Promise<FileArtifactOperationResult> {
  const documentId = String(input.documentId || '').trim();
  if (!documentId) {
    return { ok: false, actual: 'file action=unoApi requires a stable documentId. It may be queried before plan only when documentType is also provided.' };
  }
  try {
    let draft: OfficeDocumentDraft | undefined;
    try {
      draft = await loadDraft(input.runId, documentId);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code || '')
        : '';
      if (code !== 'ENOENT') throw error;
    }
    if (!draft && !input.documentType) {
      return {
        ok: false,
        actual: `Office draft ${documentId} is not planned. Provide documentType to inspect the unbound UNO catalog, or call action=plan first.`,
      };
    }
    if (draft && (draft.generator || 'uno') === 'javascript') {
      return {
        ok: false,
        actual: `Document ${documentId} uses JavaScript generation. UNO API guidance is unavailable for this draft; call action=jsApi for ${draft.documentType} instead.`,
      };
    }
    if (draft && input.documentType && input.documentType !== draft.documentType) {
      return {
        ok: false,
        actual: `Document ${documentId} is planned as ${draft.documentType}, not ${input.documentType}. Omit documentType or use the planned value.`,
      };
    }
    const documentType = draft?.documentType || input.documentType!;
    const normalizedQuery = String(input.query || '').trim().toLowerCase();
    const catalog = await inspectUnoApi({ documentType, query: normalizedQuery || undefined, limit: 120 });
    const catalogDigest = sourceDigest(JSON.stringify(catalog));
    const moduleKey = normalizedQuery || '__index__';
    const moduleDigests = draft?.unoApiModuleDigests || {};
    const alreadyLoaded = Boolean(draft && moduleDigests[moduleKey] === catalogDigest);
    if (draft) {
      moduleDigests[moduleKey] = catalogDigest;
      draft.unoApiModuleDigests = moduleDigests;
      draft.unoApiCatalogDigest = catalogDigest;
      draft.unoApiCatalogLoadedAt ||= new Date().toISOString();
      await saveDraft(input.runId, draft);
    }
    const catalogForModel = normalizedQuery && catalog.queryMatched === true
      ? Object.fromEntries(Object.entries(catalog).filter(([key]) => key !== 'moduleIndex' && key !== 'rules'))
      : catalog;
    return {
      ok: true,
      actual: JSON.stringify({
        kind: 'uno-api',
        documentId,
        documentType,
        catalogDigest,
        query: normalizedQuery || undefined,
        alreadyLoaded,
        boundToPlannedDraft: Boolean(draft),
        nextAction: draft ? undefined : 'plan',
        ...catalogForModel,
      }),
    };
  } catch (error) {
    return { ok: false, actual: `UNO API inspection failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function getOfficeJsApi(
  input: Pick<UnoApiInput, 'runId' | 'documentId' | 'documentType' | 'query'>,
): Promise<FileArtifactOperationResult> {
  const documentId = String(input.documentId || '').trim();
  if (!documentId) {
    return { ok: false, actual: 'file action=jsApi requires the documentId returned by action=plan.' };
  }
  let draft: OfficeDocumentDraft;
  try {
    draft = await loadDraft(input.runId, documentId);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : '';
    if (code === 'ENOENT') {
      return { ok: false, actual: `Office draft ${documentId} is not planned. Call action=plan before action=jsApi.` };
    }
    return { ok: false, actual: `JavaScript Office API inspection failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if ((draft.generator || 'uno') !== 'javascript') {
    return {
      ok: false,
      actual: JSON.stringify({
        kind: 'office-api-engine-mismatch', documentId, generator: 'uno',
        error: 'This is a Python/UNO draft. jsApi was not executed. Do not retry jsApi or rewrite the draft in JavaScript.',
        nextCall: { action: 'unoApi', documentId, ...(input.query ? { query: input.query } : {}) },
      }),
    };
  }
  if (input.documentType && input.documentType !== draft.documentType) {
    return {
      ok: false,
      actual: `Document ${documentId} is planned as ${draft.documentType}, not ${input.documentType}. Use the planned documentType.`,
    };
  }
  const documentType = draft.documentType;
  const examples = {
    presentation: `export async function createDocument(job) {
  const pptx = new job.PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  const assets = await job.listAssets();
  const exactImageName = 'replace-with-an-exact-name-from-availableAssets.png';
  const image = assets.find((asset) => asset.name === exactImageName);
  const slide = pptx.addSlide();
  slide.addText('Title', { x: 0.7, y: 0.5, w: 12, h: 0.6, fontSize: 28, bold: true, margin: 0, breakLine: false, fit: 'shrink' });
  if (image) slide.addImage({ path: await job.assetPath(image.name), x: 0.7, y: 1.4, w: 5.2, h: 3.2 });
  await pptx.writeFile({ fileName: job.outputPath });
}`,
    word: `export async function createDocument(job) {
  const { Document, Packer, PageBreak, Paragraph, Table, TableCell, TableRow, TextRun } = job.docx;
  const table = new Table({ rows: [new TableRow({ children: [
    new TableCell({ children: [new Paragraph('Item')] }),
    new TableCell({ children: [new Paragraph('Value')] }),
  ] })] });
  const document = new Document({ sections: [{ children: [
    new Paragraph({ children: [new TextRun({ text: 'Title', bold: true, size: 40 })] }),
    table,
    new Paragraph({ children: [new PageBreak()] }),
    new Paragraph('Second page'),
  ] }] });
  await job.writeOutput(await Packer.toBuffer(document));
}`,
    spreadsheet: `export async function createDocument(job) {
  const workbook = new job.ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Summary');
  sheet.addRow(['Item', 'Value']);
  sheet.addRow(['Revenue', 1200]);
  await workbook.xlsx.writeFile(job.outputPath);
}`,
  } as const;
  const recipes = {
    assets: `const assets = await job.listAssets(); // [{ name, bytes }]
const assetByName = new Map(assets.map((asset) => [asset.name, asset]));
const exactName = 'copy-the-exact-availableAssets-name.png';
if (!assetByName.has(exactName)) throw new Error('Missing asset: ' + exactName);
const localPath = await job.assetPath(exactName);`,
    presentationImage: `const slide = pptx.addSlide();
slide.addImage({ path: await job.assetPath(exactName), x: 0.7, y: 1.2, w: 5.4, h: 3.4 });`,
    wordImage: `import { readFile } from 'node:fs/promises';
const { ImageRun, Paragraph } = job.docx;
const imageBytes = await readFile(await job.assetPath(exactName));
const imageParagraph = new Paragraph({ children: [new ImageRun({ data: imageBytes, transformation: { width: 640, height: 360 } })] });`,
    wordTable: `const { Paragraph, Table, TableCell, TableRow } = job.docx;
const table = new Table({ rows: [
  new TableRow({ children: [
    new TableCell({ children: [new Paragraph('Item')] }),
    new TableCell({ children: [new Paragraph('Value')] }),
  ] }),
] });`,
    wordPageBreak: `const { PageBreak, Paragraph } = job.docx;
const pageBreak = new Paragraph({ children: [new PageBreak()] });`,
    pdf: `// For a planned .pdf, author the planned Word/PowerPoint/Spreadsheet source normally.
// job.outputPath already points to the correct temporary Office extension.
// The server converts that Office output to PDF after createDocument returns.`,
  };
  return {
    ok: true,
    actual: JSON.stringify({
      kind: 'office-js-api',
      documentType,
      libraries: {
        presentation: 'pptxgenjs via job.PptxGenJS',
        word: 'docx via job.docx',
        spreadsheet: 'exceljs via job.ExcelJS',
      },
      rules: [
        'Export exactly one async or synchronous createDocument(job) function.',
        'Recommended workflow: action=generate may create a small runnable skeleton, then repeated action=edit calls can add pages, sections, assets, and layout incrementally. This is guidance, not a size restriction; a complete runnable initial program remains valid when appropriate.',
        'Source units and bounded reads are optional editing aids for large programs, never a validation requirement.',
        'Write the final editable Office file to job.outputPath, or use await job.writeOutput(buffer) for docx buffers.',
        'job.listAssets() returns objects shaped exactly as { name, bytes }, never strings. Read asset.name; never call split() on an asset object.',
        'Use the exact availableAssets/listAssets name without URL encoding, decoding, basename guessing, or invented prefixes, then call await job.assetPath(exactName).',
        'For DOCX images, read local bytes from await job.assetPath(exactName) and pass them to ImageRun. Do not pass a path string as ImageRun data.',
        'DOCX Table.rows must contain TableRow instances, and each TableRow.children must contain TableCell instances; plain nested arrays are invalid.',
        'Insert a DOCX page break with a PageBreak child inside a Paragraph.',
        'To inspect an already-downloaded image asset, call file action=readContent with its exact artifactId. To read generation code, use readSource + documentId instead.',
        'Do not fetch remote URLs from the draft; download assets with the file tool first.',
        'JavaScript mode creates PPTX, DOCX, or XLSX directly. A .pdf target is supported by creating the matching Office source for documentType and converting it with local LibreOffice.',
        'For PDF, still write to job.outputPath exactly as shown; its temporary extension is already the correct .pptx, .docx, or .xlsx source format.',
        'Existing-file modification remains UNO-based.',
        'Every action=edit applies source patch hunks before validation. Call readSource for one diagnostic-focused code window and its patchBaseDigest, then edit before reading another window. Combine only repairs whose exact source is already present.',
      ],
      recipes,
      completeDocument: examples[documentType],
    }),
  };
}

type ValidatedDraftCandidate = {
  assets: DocumentAsset[];
  cacheHit: boolean;
  validation: Awaited<ReturnType<typeof validateOfficeArtifact>> & {
    rendererMatrix?: Awaited<ReturnType<typeof validateOfficeRendererMatrix>>;
  };
  generated: {
    bytes: number;
    diagnostics?: unknown;
    extension: string;
    outputPath: string;
    previewPath?: string;
  };
};

type OfficeArtifactValidation = ValidatedDraftCandidate['validation'];

function assertOfficeValidationPassed(
  validation: OfficeArtifactValidation,
  diagnostics: Array<{ message: string; severity?: string }> = validation.issues,
) {
  if (validation.passed) return;
  const failed = diagnostics.filter((issue) => issue.severity === 'error');
  const error = new Error(failed.map((issue) => issue.message).join('\n'));
  Object.assign(error, { diagnostics: failed });
  throw error;
}

function includeGeneratedRuntimeValidation(
  validation: OfficeArtifactValidation,
  diagnostics: unknown,
  enabled: boolean,
): OfficeArtifactValidation {
  if (!enabled) return validation;
  const issues = [...generatedRuntimeDiagnostics(diagnostics), ...generatedVerificationIssues(diagnostics)];
  const next = {
    ...validation,
    issues: [...validation.issues, ...issues],
    passed: validation.passed && !issues.some((issue) => issue.severity === 'error'),
  };
  assertOfficeValidationPassed(next, issues);
  return next;
}

async function includeRendererValidation(
  validation: OfficeArtifactValidation,
  previewPath?: string,
): Promise<OfficeArtifactValidation> {
  const rendererMatrix = await validateOfficeRendererMatrix({ libreOfficePdfPath: previewPath });
  const next = {
    ...validation,
    issues: [...validation.issues, ...rendererMatrix.issues],
    passed: validation.passed && rendererMatrix.passed,
    rendererMatrix,
  };
  assertOfficeValidationPassed(next);
  return next;
}

function officeQualityGate(
  validation: OfficeArtifactValidation,
  visualVerification: FilePreviewResult | undefined,
  noVisualReason?: string,
) {
  return {
    structural: true,
    renderers: validation.rendererMatrix?.renderers,
    rendererPolicy: validation.rendererMatrix?.policy,
    visual: visualVerification ? {
      previewGenerated: visualVerification.imagePaths.length > 0,
      modelReviewRequired: true,
      previewPages: visualVerification.renderedPages,
      fullReviewStatus: 'pending',
    } : {
      status: 'not-performed',
      ...(noVisualReason ? { reason: noVisualReason } : {}),
    },
  };
}

function generatedElementMap(diagnostics: unknown): OfficeElementMapEntry[] {
  if (!diagnostics || typeof diagnostics !== 'object') return [];
  const candidate = (diagnostics as { elementMap?: unknown }).elementMap;
  if (!Array.isArray(candidate)) return [];
  return candidate.filter((entry): entry is OfficeElementMapEntry => Boolean(
    entry && typeof entry === 'object' && typeof (entry as { elementId?: unknown }).elementId === 'string',
  ));
}

export function generatedVerificationIssues(diagnostics: unknown) {
  if (!diagnostics || typeof diagnostics !== 'object') return [];
  const elementById = new Map(generatedElementMap(diagnostics).map((entry) => [entry.elementId, entry]));
  const verification = (diagnostics as { verification?: unknown }).verification;
  if (!verification || typeof verification !== 'object') return [];
  const issues = (verification as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return [];
  const normalized = issues.filter((issue): issue is {
    column?: number;
    elementId?: string;
    elementIds?: string[];
    line?: number;
    locator?: Record<string, unknown>;
    page?: number;
    repairHint?: string;
    shapes?: number[];
    description: string;
    severity: 'error' | 'warning';
    type: string;
  } => Boolean(issue && typeof issue === 'object' && typeof (issue as { description?: unknown }).description === 'string'))
    .map((issue) => {
      const page = typeof issue.page === 'number' && Number.isFinite(issue.page) ? issue.page : undefined;
      const shapes = Array.isArray(issue.shapes) ? issue.shapes.filter((shape) => Number.isInteger(shape)) : undefined;
      const elementIds = Array.isArray(issue.elementIds)
        ? issue.elementIds.filter((elementId): elementId is string => typeof elementId === 'string' && Boolean(elementId))
        : undefined;
      const primaryElement = (issue.elementId && elementById.get(issue.elementId))
        || (elementIds?.[0] ? elementById.get(elementIds[0]) : undefined);
      return {
        code: `RUNTIME_${String(issue.type || 'LAYOUT').toUpperCase()}`,
        column: issue.column,
        elementId: issue.elementId,
        elementIds,
        line: issue.line || primaryElement?.line,
        locator: issue.locator || primaryElement?.locator || (page ? { slide: page, ...(shapes?.length ? { shapes } : {}) } : undefined),
        message: issue.repairHint ? `${issue.description} Repair: ${issue.repairHint}` : issue.description,
        page,
        severity: issue.severity === 'error' ? 'error' as const : 'warning' as const,
        shapes,
      };
    });
  const seen = new Set<string>();
  const unique = normalized.filter((issue) => {
    const key = JSON.stringify([issue.code, issue.page, issue.shapes, issue.elementIds, issue.message]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Preserve every distinct pair. The model can batch independent fixes in one
  // patch only when validation does not collapse the document at a root node.
  return unique;
}

function generatedFeatureCounts(diagnostics: unknown): Record<string, number> {
  if (!diagnostics || typeof diagnostics !== 'object') return {};
  const candidate = (diagnostics as { featureCounts?: unknown }).featureCounts;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return {};
  return Object.fromEntries(Object.entries(candidate as Record<string, unknown>)
    .map(([name, value]) => [name, Number(value)] as const)
    .filter(([, value]) => Number.isSafeInteger(value) && value >= 0));
}

export function generatedRuntimeDiagnostics(diagnostics: unknown): OfficeProgramDiagnostic[] {
  if (!diagnostics || typeof diagnostics !== 'object') return [];
  const candidate = (diagnostics as { runtimeDiagnostics?: unknown }).runtimeDiagnostics;
  if (!Array.isArray(candidate)) return [];
  return candidate.filter((entry): entry is Record<string, unknown> => Boolean(
    entry && typeof entry === 'object' && typeof (entry as { message?: unknown }).message === 'string',
  )).map((entry) => ({
    code: typeof entry.code === 'string' ? entry.code : 'UNO_RUNTIME_WARNING',
    ...(typeof entry.callColumn === 'number' ? { callColumn: entry.callColumn } : {}),
    ...(typeof entry.callLine === 'number' ? { callLine: entry.callLine } : {}),
    ...(typeof entry.column === 'number' ? { column: entry.column } : {}),
    ...(typeof entry.elementId === 'string' ? { elementId: entry.elementId } : {}),
    ...(typeof entry.line === 'number' ? { line: entry.line } : {}),
    message: String(entry.message),
    severity: entry.severity === 'error' ? 'error' : 'warning',
  }));
}

export function officeValidationCacheBaseName(documentId: string, digest: string) {
  return `validation-${sanitizeFileName(documentId, 'document')}-${digest}`;
}

const PRESENTATION_CAPABILITY_REQUIREMENTS = [
  ['RectangleShape', 'RectangleShape'],
  ['EllipseShape', 'EllipseShape'],
  ['CustomShape', 'CustomShape'],
  ['CaptionShape', 'CaptionShape'],
  ['ConnectorShape', 'ConnectorShape'],
  ['LineShape', 'LineShape'],
  ['MeasureShape', 'MeasureShape'],
  ['TextShape', 'TextShape'],
  ['GraphicObjectShape', 'GraphicObject'],
  ['GraphicObject', 'GraphicObject'],
] as const;

export function requestedPresentationCapabilities(intent: string | undefined) {
  const requested = String(intent || '');
  const seen = new Set<string>();
  return PRESENTATION_CAPABILITY_REQUIREMENTS.flatMap(([label, feature]) => {
    if (seen.has(feature) || !new RegExp(`\\b${label}\\b`, 'i').test(requested)) return [];
    seen.add(feature);
    return [{ label, feature }];
  });
}

function missingRequestedPresentationCapabilityDiagnostics(
  draft: OfficeDocumentDraft,
  diagnostics: unknown,
): OfficeProgramDiagnostic[] {
  if (draft.documentType !== 'presentation' || draft.generator !== 'uno') return [];
  const counts = generatedFeatureCounts(diagnostics);
  return requestedPresentationCapabilities(draft.intent)
    .filter(({ feature }) => (counts[feature] || 0) < 1)
    .map(({ label, feature }) => ({
      code: 'UNO_REQUIRED_CAPABILITY_MISSING',
      severity: 'error' as const,
      message: (
        `The plan explicitly requires ${label}, but generated featureCounts.${feature}=0. `
        + 'Author the real capability with the installed presentation facade example; a visually similar shape does not satisfy this requirement.'
      ),
    }));
}

function validationCachePaths(runId: string | undefined, draft: OfficeDocumentDraft, extension: string) {
  const digest = sourceDigest(draft.program || '');
  // LibreOffice on Windows can create its lock descriptor for a dot-prefixed
  // target and then abort storeAsURL with 0x11b. Keep validation artifacts
  // private by directory, but use a normal basename that LibreOffice can save.
  const base = path.join(
    artifactDir(runId, 'document-drafts'),
    officeValidationCacheBaseName(draft.documentId, digest),
  );
  return {
    artifactPath: `${base}${extension}`,
    lockPath: path.join(path.dirname(base), `.~lock.${path.basename(base)}${extension}#`),
    metadataPath: `${base}.json`,
    previewPath: `${base}.preview.pdf`,
  };
}

async function clearValidationCacheFiles(cache: ReturnType<typeof validationCachePaths>) {
  await Promise.all([
    unlink(cache.artifactPath).catch(() => undefined),
    unlink(cache.lockPath).catch(() => undefined),
    unlink(cache.metadataPath).catch(() => undefined),
    unlink(cache.previewPath).catch(() => undefined),
  ]);
}

function documentAssetsFingerprint(assets: DocumentAsset[], runtimeFingerprint: string, draft: OfficeDocumentDraft) {
  return createHash('sha256').update(JSON.stringify({
    pipelineVersion: OFFICE_PIPELINE_VERSION,
    runtimeFingerprint,
    generator: draft.generator,
    documentType: draft.documentType,
    fileName: draft.fileName,
    sourceDocument: draft.sourceDocument,
    assets: assets.map((asset) => ({
    assetName: asset.assetName,
    bytes: asset.bytes,
    sha256: asset.sha256,
    origin: asset.origin,
    ref: asset.ref,
    })),
  }), 'utf8').digest('hex');
}

async function generateValidatedDraftCandidate(input: {
  runId?: string;
  draft: OfficeDocumentDraft;
  attachmentBindings?: FileAttachmentBinding[];
  abortSignal?: AbortSignal;
  onProgress?: (progress: FileGenerationProgress) => void | Promise<void>;
}): Promise<Omit<ValidatedDraftCandidate, 'validation'>> {
  if (!input.draft.program) throw new Error(`Office draft ${input.draft.documentId} has no source yet; call action=generate first.`);
  // Execute the candidate from an isolated source file. The committed
  // workspace is only replaced after every validation gate succeeds.
  await input.onProgress?.({ phase: 'assets', message: '正在同步文件素材' });
  const assets = await syncDocumentAssets(input.runId, input.attachmentBindings);
  const assetFingerprint = documentAssetsFingerprint(assets, await officeGenerationRuntimeFingerprint(), input.draft);
  const extension = path.extname(input.draft.fileName).toLowerCase();
  const cache = validationCachePaths(input.runId, input.draft, extension);
  try {
    const metadata = JSON.parse(await readFile(cache.metadataPath, 'utf8')) as {
      assetFingerprint?: string; diagnostics?: unknown; artifactDigest?: string; previewDigest?: string;
    };
    if (metadata.assetFingerprint === assetFingerprint) {
      const artifactMetadata = await stat(cache.artifactPath);
      const previewMetadata = await stat(cache.previewPath).catch(() => undefined);
      if (!artifactMetadata.isFile() || metadata.artifactDigest !== await sha256File(cache.artifactPath)
        || (metadata.previewDigest && metadata.previewDigest !== await sha256File(cache.previewPath))
        || (input.draft.generator === 'uno' && !metadata.previewDigest)) {
        throw new Error('Cached Office artifact or preview changed; regenerate the candidate.');
      }
      return {
        assets,
        cacheHit: true,
        generated: {
          bytes: artifactMetadata.size,
          extension,
          outputPath: cache.artifactPath,
          previewPath: previewMetadata?.isFile() ? cache.previewPath : undefined,
          diagnostics: metadata.diagnostics,
        },
      };
    }
  } catch {
    // A missing or interrupted cache is not a document failure; regenerate it.
  }
  await clearValidationCacheFiles(cache);
  await input.onProgress?.({ phase: 'execute', message: '正在执行文档脚本' });
  const candidateSourcePath = path.join(
    artifactDir(input.runId, 'document-drafts'),
    `.candidate-${sanitizeFileName(input.draft.documentId, 'document')}-${randomUUID()}${input.draft.generator === 'javascript' ? '.mjs' : '.py'}`,
  );
  await writeFile(candidateSourcePath, input.draft.program, { encoding: 'utf8', flag: 'wx' });
  let cacheCompleted = false;
  try {
    const generated = await generateFileToPaths({
      ...input.draft,
      programPath: candidateSourcePath,
      outputPath: cache.artifactPath,
      previewPath: cache.previewPath,
      assetsPath: artifactDir(input.runId, 'document-assets'),
      generator: input.draft.generator,
      requiredSourceAssetName: input.draft.sourceDocument?.assetName,
      abortSignal: input.abortSignal,
      onProgress: input.onProgress,
    });
    await writeFile(cache.metadataPath, JSON.stringify({
      assetFingerprint, diagnostics: generated.diagnostics,
      artifactDigest: await sha256File(generated.outputPath),
      previewDigest: generated.previewPath ? await sha256File(generated.previewPath) : undefined,
    }), 'utf8');
    cacheCompleted = true;
    return { assets, cacheHit: false, generated };
  } finally {
    await Promise.all([
      unlink(candidateSourcePath).catch(() => undefined),
      unlink(cache.lockPath).catch(() => undefined),
    ]);
    if (!cacheCompleted) await clearValidationCacheFiles(cache);
  }
}

async function prepareValidatedDraft(input: {
  runId?: string;
  draft: OfficeDocumentDraft;
  attachmentBindings?: FileAttachmentBinding[];
  abortSignal?: AbortSignal;
  onProgress?: (progress: FileGenerationProgress) => void | Promise<void>;
}): Promise<ValidatedDraftCandidate> {
  if (!input.draft.program) throw new Error(`Office draft ${input.draft.documentId} has no source yet; call action=generate first.`);
  try {
    await beginOfficeValidation(input.draft);
    input.draft.validationStatus = 'pending';
    input.draft.workflow = { state: 'validating', checkpointAt: new Date().toISOString() };
    await input.onProgress?.({ phase: 'static-analysis', message: '正在检查脚本语法和确定性错误' });
    const staticAnalysis = await analyzeOfficeProgram(input.draft.program, input.draft.generator || 'uno');
    const parsedUnits = sourceUnitsForDraft(input.draft.program, input.draft);
    const staticDiagnostics = staticAnalysis.diagnostics.map((diagnostic) => {
      const unit = diagnostic.line
        ? parsedUnits.find((candidate) => diagnostic.line! >= candidate.startLine && diagnostic.line! <= candidate.endLine)
        : undefined;
      return unit ? {
        ...diagnostic,
        globalLine: diagnostic.line,
        unitLine: diagnostic.line! - unit.startLine + 1,
        unitPath: unit.path,
      } : diagnostic;
    });
    input.draft.validationDiagnostics = staticDiagnostics;
    if (!staticAnalysis.passed) {
      const error = new Error(staticDiagnostics
        .filter((item) => item.severity === 'error')
        .map((item) => `${item.line || '?'}:${item.column || '?'} ${item.message}`)
        .join('\n'));
      Object.assign(error, { diagnostics: staticDiagnostics });
      throw error;
    }
    if (input.draft.validationEvidence) input.draft.validationEvidence.stage = 'execution';
    const candidate = await generateValidatedDraftCandidate(input);
    if (input.draft.validationEvidence) input.draft.validationEvidence.stage = 'artifact-validation';
    await input.onProgress?.({ phase: 'artifact-validation', message: '正在执行统一 Office、字体和嵌入图片检查' });
    const unoStrict = input.draft.generator === 'uno';
    const elementMap = unoStrict ? generatedElementMap(candidate.generated.diagnostics) : [];
    const sourceAbsolutePath = input.draft.operation === 'modify' && input.draft.sourceDocument
      ? path.join(artifactDir(input.runId, 'document-assets'), input.draft.sourceDocument.assetName)
      : undefined;
    let validation: ValidatedDraftCandidate['validation'] = await validateOfficeArtifact({
      absolutePath: candidate.generated.outputPath,
      sourceAbsolutePath,
      elementMap: unoStrict ? elementMap : undefined,
      featureCounts: unoStrict ? generatedFeatureCounts(candidate.generated.diagnostics) : undefined,
      extension: candidate.generated.extension,
      requireElementIds: unoStrict && input.draft.operation !== 'modify',
      validationProfile: unoStrict ? 'uno-strict' : 'basic',
    });
    // Candidate byte digests are checked before reuse. Re-executing identical
    // source cannot repair a deterministic validation failure; report it once.
    const capabilityIssues = unoStrict
      ? missingRequestedPresentationCapabilityDiagnostics(input.draft, candidate.generated.diagnostics)
      : [];
    if (capabilityIssues.length) {
      validation = {
        ...validation,
        issues: [...validation.issues, ...capabilityIssues],
        passed: false,
      };
    }
    assertOfficeValidationPassed(validation);
    validation = includeGeneratedRuntimeValidation(validation, candidate.generated.diagnostics, unoStrict);
    if (unoStrict) {
      await input.onProgress?.({ phase: 'renderer-validation', message: '正在通过 LibreOffice 验证渲染结果' });
      validation = await includeRendererValidation(validation, candidate.generated.previewPath);
    }
    input.draft.validationStatus = 'passed';
    if (input.draft.validationEvidence) input.draft.validationEvidence.stage = 'complete';
    input.draft.validationFailureCount = 0;
    input.draft.validatedSourceDigest = sourceDigest(input.draft.program);
    input.draft.validationDiagnostics = [
      ...staticDiagnostics,
      ...validation.issues.map((issue) => {
        const unit = issue.line
          ? parsedUnits.find((candidate) => issue.line! >= candidate.startLine && issue.line! <= candidate.endLine)
          : undefined;
        return unit ? { ...issue, unitPath: unit.path } : issue;
      }),
    ];
    if (unoStrict) {
      input.draft.elementMap = generatedElementMap(candidate.generated.diagnostics).map((element) => {
        const unit = element.line
          ? parsedUnits.find((candidate) => element.line! >= candidate.startLine && element.line! <= candidate.endLine)
          : undefined;
        return unit ? { ...element, unitPath: unit.path } : element;
      });
      if (validation.rendererMatrix) input.draft.rendererValidation = validation.rendererMatrix;
    } else {
      delete input.draft.elementMap;
      delete input.draft.rendererValidation;
    }
    synchronizeSourceUnits(input.draft, 'passed');
    input.draft.workflow = { state: 'render-ready', checkpointAt: new Date().toISOString() };
    await saveDraft(input.runId, input.draft);
    return { ...candidate, validation };
  } catch (error) {
    if (officeOperationWasInterrupted(error, input.abortSignal)) throw error;
    if (input.draft.generator === 'uno' && (isUnoBridgeStartupError(error) || isUnoWorkerInternalError(error))) {
      input.draft.validationStatus = 'pending';
      input.draft.validationDiagnostics = diagnoseOfficeProgramRuntimeError(input.draft.program, error instanceof Error ? error.message : String(error));
      input.draft.workflow = { state: 'failed', checkpointAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) };
      throw error;
    }
    const explicitDiagnostics = error && typeof error === 'object' && 'diagnostics' in error
      ? (error as { diagnostics?: OfficeProgramDiagnostic[] }).diagnostics
      : undefined;
    const errorText = error instanceof Error ? error.message : String(error);
    const diagnostics = explicitDiagnostics || (input.draft.generator === 'uno'
      ? diagnoseOfficeProgramRuntimeError(input.draft.program || '', errorText)
      : undefined);
    input.draft.validationStatus = 'failed';
    input.draft.validationFailureCount = (input.draft.validationFailureCount || 0) + 1;
    input.draft.validationDiagnostics = diagnostics || [{
      message: errorText,
      severity: 'error',
    }];
    synchronizeSourceUnits(input.draft, 'failed');
    input.draft.workflow = {
      state: 'authoring',
      checkpointAt: new Date().toISOString(),
      error: errorText,
    };
    throw error;
  }
}

async function validateDraft(input: {
  runId?: string;
  draft: OfficeDocumentDraft;
  includeVisualVerification?: boolean;
  documentChanged?: boolean;
  attachmentBindings?: FileAttachmentBinding[];
  abortSignal?: AbortSignal;
  onProgress?: (progress: FileGenerationProgress) => void | Promise<void>;
}): Promise<FileArtifactOperationResult> {
  try {
    const candidate = await prepareValidatedDraft(input);
    const needsOfficePreview = input.includeVisualVerification && [
      '.doc', '.docx', '.odt', '.pdf', '.xls', '.xlsx', '.ods', '.ppt', '.pptx', '.odp',
    ].includes(candidate.generated.extension);
    if (needsOfficePreview && !candidate.generated.previewPath) {
      throw new Error('LibreOffice UNO worker did not produce a PDF preview for draft validation.');
    }
    if (needsOfficePreview) await input.onProgress?.({ phase: 'visual', message: '正在生成验证预览' });
    const visualVerification = needsOfficePreview
      ? await currentNodeFileWorkspaceHost().renderPreview({
          absolutePath: candidate.generated.previewPath!,
          extension: '.pdf',
          name: input.draft.fileName,
          previewRoot: artifactDir(input.runId, 'attachment-previews'),
        })
      : undefined;
    if (needsOfficePreview && (!visualVerification?.imagePaths.length || visualVerification.renderer !== 'pdf')) {
      throw new Error(`visual quality gate failed: ${visualVerification?.warning || 'LibreOffice produced no page previews'}`);
    }
    return {
      ok: true,
      actual: JSON.stringify({
        kind: 'uno-draft-validation',
        documentId: input.draft.documentId,
        sourceRead: { action: 'readSource', documentId: input.draft.documentId },
        nextAction: { action: 'render', documentId: input.draft.documentId },
        fileName: input.draft.fileName,
        generator: input.draft.generator || 'uno',
        sourceDigest: sourceDigest(input.draft.program || ''),
        sourceCharacters: input.draft.program?.length || 0,
        validationStatus: input.draft.validationStatus,
        validationEvidence: officeValidationEvidence(input.draft, await currentUnoWorkerDigest()),
        documentChanged: input.documentChanged || false,
        cacheHit: candidate.cacheHit,
        generationDiagnostics: candidate.generated.diagnostics,
        semantic: input.draft.semantic,
        automaticValidation: candidate.validation,
        workflow: input.draft.workflow,
        qualityGate: officeQualityGate(candidate.validation, visualVerification),
      }),
      referenceImagePaths: visualVerification?.imagePaths.length ? visualVerification.imagePaths : undefined,
    };
  } catch (error) {
    const source = input.draft.program || '';
    const validationError = error instanceof Error ? error.message : String(error);
    const transientUnoFailure = input.draft.generator === 'uno' && isUnoBridgeStartupError(error);
    const workerFailure = input.draft.generator === 'uno' && isUnoWorkerInternalError(error);
    const infrastructureFailure = transientUnoFailure || workerFailure;
    let saveError: string | undefined;
    try {
      await saveWorkingDraft(input.runId, input.draft);
    } catch (workingSaveError) {
      saveError = workingSaveError instanceof Error ? workingSaveError.message : String(workingSaveError);
    }
    return {
      ok: false,
      actual: JSON.stringify({
        kind: workerFailure ? 'uno-infrastructure-error' : transientUnoFailure ? 'uno-infrastructure-retry' : 'uno-draft-validation',
        ...(infrastructureFailure ? { sourceRepairRequired: false, sourceValidity: 'unverified', retryable: false, retryAfter: 'runtime-change-or-confirmed-recovery' } : {}),
        documentId: input.draft.documentId,
        sourceRead: { action: 'readSource', documentId: input.draft.documentId },
        fileName: input.draft.fileName,
        generator: input.draft.generator || 'uno',
        changed: input.documentChanged || false,
        saved: !saveError,
        sourceDigest: sourceDigest(source),
        sourceCharacters: source.length,
        lineCount: draftSourceLineCount(source),
        validation: infrastructureFailure ? 'pending' : 'failed',
        validationEvidence: officeValidationEvidence(input.draft, await currentUnoWorkerDigest()),
        validationFailureCount: infrastructureFailure ? input.draft.validationFailureCount || 0 : input.draft.validationFailureCount || 1,
        diagnostics: compactValidationDiagnosticsForTool(input.draft.validationDiagnostics),
        semantic: input.draft.semantic,
        repairHints: transientUnoFailure
          ? ['LibreOffice startup retries were exhausted before source validation completed; the current source was preserved.']
          : officeValidationRepairHints(input.draft.validationDiagnostics || [], validationError),
        error: compactToolText(saveError ? `${validationError}\nWorking source save failed: ${saveError}` : validationError),
        workflow: compactWorkflowForTool(input.draft.workflow),
      }),
    };
  }
}

async function validateDraftSourceUnit(input: {
  runId?: string;
  draft: OfficeDocumentDraft;
  sourceUnitPath: string;
  includeVisualVerification?: boolean;
  attachmentBindings?: FileAttachmentBinding[];
  abortSignal?: AbortSignal;
  onProgress?: (progress: FileGenerationProgress) => void | Promise<void>;
}): Promise<FileArtifactOperationResult> {
  const extension = path.extname(input.draft.fileName).toLowerCase();
  const suffix = randomUUID();
  const directory = artifactDir(input.runId, 'document-drafts');
  const sourcePath = path.join(directory, `.unit-${suffix}${input.draft.generator === 'javascript' ? '.mjs' : '.py'}`);
  const outputPath = path.join(directory, `.unit-${suffix}${extension}`);
  const previewPath = path.join(directory, `.unit-${suffix}.preview.pdf`);
  try {
    if (!input.draft.program) throw new Error('The Office draft has no working source.');
    await beginOfficeValidation(input.draft, input.sourceUnitPath);
    const units = sourceUnitsForDraft(input.draft.program, input.draft);
    const unit = units.find((candidate) => candidate.path === input.sourceUnitPath);
    if (!unit) throw new Error(`Office source unit ${input.sourceUnitPath} does not exist.`);
    const isolatedSource = isolateSourceUnit(input.draft.program, input.sourceUnitPath, input.draft.generator, units);
    await input.onProgress?.({ phase: 'unit-static-analysis', message: '正在检查整份文档的语法与 API 调用' });
    // Source-unit execution is an optimization only. Static preflight always
    // sees the complete draft so one edit returns every discoverable syntax,
    // facade method, signature, and supported nested-argument diagnostic.
    const staticAnalysis = await analyzeOfficeProgram(input.draft.program, input.draft.generator || 'uno');
    if (!staticAnalysis.passed) {
      const error = new Error(staticAnalysis.diagnostics.filter((item) => item.severity === 'error').map((item) => item.message).join('\n'));
      Object.assign(error, { diagnostics: staticAnalysis.diagnostics });
      throw error;
    }
    await mkdir(directory, { recursive: true });
    await writeFile(sourcePath, isolatedSource, 'utf8');
    const assets = await syncDocumentAssets(input.runId, input.attachmentBindings);
    await input.onProgress?.({ phase: 'unit-execute', message: `正在隔离执行 ${input.sourceUnitPath}` });
    if (input.draft.validationEvidence) input.draft.validationEvidence.stage = 'execution';
    const generated = await generateFileToPaths({
      ...input.draft,
      programPath: sourcePath,
      outputPath,
      previewPath,
      assetsPath: artifactDir(input.runId, 'document-assets'),
      generator: input.draft.generator,
      requiredSourceAssetName: input.draft.sourceDocument?.assetName,
      abortSignal: input.abortSignal,
      onProgress: input.onProgress,
    });
    if (input.draft.validationEvidence) input.draft.validationEvidence.stage = 'artifact-validation';
    const unoStrict = input.draft.generator === 'uno';
    const elementMap = unoStrict ? generatedElementMap(generated.diagnostics) : [];
    const sourceAbsolutePath = input.draft.operation === 'modify' && input.draft.sourceDocument
      ? path.join(artifactDir(input.runId, 'document-assets'), input.draft.sourceDocument.assetName)
      : undefined;
    let validation: ValidatedDraftCandidate['validation'] = await validateOfficeArtifact({
      absolutePath: generated.outputPath,
      sourceAbsolutePath,
      elementMap: unoStrict ? elementMap : undefined,
      featureCounts: unoStrict ? generatedFeatureCounts(generated.diagnostics) : undefined,
      extension: generated.extension,
      requireElementIds: unoStrict && input.draft.operation !== 'modify',
      validationProfile: unoStrict ? 'uno-strict' : 'basic',
    });
    assertOfficeValidationPassed(validation);
    validation = includeGeneratedRuntimeValidation(validation, generated.diagnostics, unoStrict);
    if (unoStrict) {
      validation = await includeRendererValidation(validation, generated.previewPath);
    }
    const needsVisuals = Boolean(input.includeVisualVerification && generated.previewPath);
    const visualVerification = needsVisuals
      ? await currentNodeFileWorkspaceHost().renderPreview({
          absolutePath: generated.previewPath!,
          cacheKey: `${sourceDigest(unit.content)}:unit-validation`,
          extension: '.pdf',
          name: `${input.draft.fileName}:${input.sourceUnitPath}`,
          previewRoot: artifactDir(input.runId, 'attachment-previews'),
        })
      : undefined;
    const state = input.draft.sourceUnits?.find((item) => item.path === input.sourceUnitPath);
    if (state) {
      state.sourceDigest = sourceDigest(unit.content);
      state.validatedDigest = state.sourceDigest;
      state.status = 'passed';
    }
    input.draft.validationStatus = 'pending';
    if (input.draft.validationEvidence) input.draft.validationEvidence.stage = 'complete';
    input.draft.validationDiagnostics = [
      ...staticAnalysis.diagnostics.map((diagnostic) => ({ ...diagnostic, unitPath: input.sourceUnitPath })),
      ...validation.issues.map((issue) => ({ ...issue, unitPath: input.sourceUnitPath })),
    ];
    if (unoStrict) {
      input.draft.elementMap = elementMap;
      if (validation.rendererMatrix) input.draft.rendererValidation = validation.rendererMatrix;
    } else {
      delete input.draft.elementMap;
      delete input.draft.rendererValidation;
    }
    input.draft.workflow = { state: 'authoring', checkpointAt: new Date().toISOString() };
    await saveDraft(input.runId, input.draft);
    return {
      ok: true,
      actual: JSON.stringify({
        kind: 'office-source-unit-validation',
        documentId: input.draft.documentId,
        sourceUnitPath: input.sourceUnitPath,
        sourceUnitDigest: sourceDigest(unit.content),
        validation: 'passed',
        validationEvidence: officeValidationEvidence(input.draft, await currentUnoWorkerDigest()),
        renderable: input.draft.validatedSourceDigest === sourceDigest(input.draft.program),
        assets: assets.map(describeDocumentAsset),
        automaticValidation: validation,
        automaticVisualChecks: visualVerification?.automaticChecks || [],
      }),
      referenceImagePaths: visualVerification?.imagePaths.length ? visualVerification.imagePaths : undefined,
    };
  } catch (error) {
    const state = input.draft.sourceUnits?.find((item) => item.path === input.sourceUnitPath);
    if (state) {
      state.validatedDigest = undefined;
      state.status = 'failed';
    }
    const explicitDiagnostics = error && typeof error === 'object' && 'diagnostics' in error
      ? (error as { diagnostics?: OfficeProgramDiagnostic[] }).diagnostics
      : undefined;
    const errorText = error instanceof Error ? error.message : String(error);
    const transientUnoFailure = input.draft.generator === 'uno' && isUnoBridgeStartupError(error);
    const workerFailure = input.draft.generator === 'uno' && isUnoWorkerInternalError(error);
    const diagnostics = explicitDiagnostics || (input.draft.generator === 'uno'
      ? diagnoseOfficeProgramRuntimeError(input.draft.program || '', errorText)
      : undefined);
    if (transientUnoFailure || workerFailure) {
      if (state) state.status = 'pending';
      input.draft.validationStatus = 'pending';
      input.draft.validationDiagnostics = diagnostics || [];
      input.draft.workflow = { state: 'authoring', checkpointAt: new Date().toISOString() };
      let saveError: string | undefined;
      try {
        await saveWorkingDraft(input.runId, input.draft);
      } catch (workingSaveError) {
        saveError = workingSaveError instanceof Error ? workingSaveError.message : String(workingSaveError);
      }
      return {
        ok: false,
        actual: JSON.stringify({
          kind: workerFailure ? 'uno-infrastructure-error' : 'uno-infrastructure-retry',
          sourceRepairRequired: false,
          sourceValidity: 'unverified',
          retryable: false,
          retryAfter: 'runtime-change-or-confirmed-recovery',
          documentId: input.draft.documentId,
          sourceUnitPath: input.sourceUnitPath,
          validation: 'pending',
          validationEvidence: officeValidationEvidence(input.draft, await currentUnoWorkerDigest()),
          saved: !saveError,
          renderable: true,
          sourceDigest: sourceDigest(input.draft.program || ''),
          diagnostics: compactValidationDiagnosticsForTool(input.draft.validationDiagnostics),
          repairHints: workerFailure ? officeValidationRepairHints([], errorText)
            : ['LibreOffice startup retries were exhausted before source-unit validation completed; the current source was preserved.'],
          error: compactToolText(saveError ? `${errorText}\nWorking source save failed: ${saveError}` : errorText),
          workflow: compactWorkflowForTool(input.draft.workflow),
        }),
      };
    }
    input.draft.validationStatus = 'failed';
    input.draft.validationFailureCount = (input.draft.validationFailureCount || 0) + 1;
    input.draft.validationDiagnostics = (diagnostics || [{ message: errorText, severity: 'error' as const }])
      .map((diagnostic) => ({ ...diagnostic, unitPath: input.sourceUnitPath }));
    input.draft.workflow = { state: 'authoring', checkpointAt: new Date().toISOString(), error: errorText };
    let saveError: string | undefined;
    try {
      await saveWorkingDraft(input.runId, input.draft);
    } catch (workingSaveError) {
      saveError = workingSaveError instanceof Error ? workingSaveError.message : String(workingSaveError);
    }
    return {
      ok: false,
      actual: JSON.stringify({
        kind: 'office-source-unit-validation',
        documentId: input.draft.documentId,
        sourceUnitPath: input.sourceUnitPath,
        validation: 'failed',
        validationEvidence: officeValidationEvidence(input.draft, await currentUnoWorkerDigest()),
        saved: !saveError,
        renderable: false,
        sourceDigest: sourceDigest(input.draft.program || ''),
        validationFailureCount: input.draft.validationFailureCount || 1,
        diagnostics: compactValidationDiagnosticsForTool(input.draft.validationDiagnostics),
        repairHints: officeValidationRepairHints(input.draft.validationDiagnostics, error instanceof Error ? error.message : String(error)),
        error: compactToolText(saveError
          ? `${error instanceof Error ? error.message : String(error)}\nWorking source save failed: ${saveError}`
          : error instanceof Error ? error.message : String(error)),
        workflow: compactWorkflowForTool(input.draft.workflow),
      }),
    };
  } finally {
    await Promise.all([
      unlink(sourcePath).catch(() => undefined),
      unlink(outputPath).catch(() => undefined),
      unlink(previewPath).catch(() => undefined),
    ]);
  }
}

async function renderDraft(input: {
  runId?: string;
  draft: OfficeDocumentDraft;
  includeVisualVerification?: boolean;
  documentChanged?: boolean;
  attachmentBindings?: FileAttachmentBinding[];
  abortSignal?: AbortSignal;
  onProgress?: (progress: FileGenerationProgress) => void | Promise<void>;
}): Promise<FileArtifactOperationResult> {
  let publishCandidatePath: string | undefined;
  try {
    const candidate = await prepareValidatedDraft(input);
    const digest = sourceDigest(input.draft.program || '');
    if (input.draft.validatedSourceDigest !== digest) {
      throw new Error('The working source has not passed validation and cannot be rendered. Continue editing the saved current source until validation passes.');
    }
    input.draft.workflow = { state: 'rendering', checkpointAt: new Date().toISOString() };
    await saveDraft(input.runId, input.draft);
    const requestedName = sanitizeFileName(input.draft.fileName, `document-${Date.now()}.pdf`);
    const dir = path.join(
      artifactDir(input.runId, 'generated'),
      sanitizeFileName(input.draft.documentId, 'document'),
      digest,
    );
    await mkdir(dir, { recursive: true });
    const target = { fileName: requestedName, filePath: path.join(dir, requestedName) };
    const needsOfficePreview = input.includeVisualVerification && [
      '.doc', '.docx', '.odt', '.pdf', '.xls', '.xlsx', '.ods', '.ppt', '.pptx', '.odp',
    ].includes(candidate.generated.extension);
    if (needsOfficePreview && !candidate.generated.previewPath) {
      throw new Error('LibreOffice UNO worker did not produce a PDF preview for visual verification.');
    }
    if (needsOfficePreview) await input.onProgress?.({ phase: 'visual', message: '正在生成逐页预览' });
    const visualVerification = needsOfficePreview
      ? await currentNodeFileWorkspaceHost().renderPreview({
          absolutePath: candidate.generated.previewPath!,
          extension: '.pdf',
          name: target.fileName,
          previewRoot: artifactDir(input.runId, 'attachment-previews'),
        })
      : undefined;
    if (needsOfficePreview
      && (!visualVerification?.imagePaths.length
        || visualVerification.renderer !== 'pdf')) {
      throw new Error(`visual quality gate failed: ${visualVerification?.warning || 'LibreOffice produced no page previews'}`);
    }

    // Only action=render publishes the already-validated candidate. Keep the
    // previous artifact intact until the replacement binary is fully written.
    const publicationReused = input.draft.renderedDigest === digest
      && input.draft.renderedFileName === target.fileName
      && await sha256File(target.filePath).catch(() => '') === await sha256File(candidate.generated.outputPath);
    await input.onProgress?.({ phase: 'publish', message: '正在发布最终文件' });
    if (!publicationReused) {
      publishCandidatePath = path.join(dir, `.render-${randomUUID()}${candidate.generated.extension}`);
      await copyFile(candidate.generated.outputPath, publishCandidatePath);
      await rename(publishCandidatePath, target.filePath);
      publishCandidatePath = undefined;
    }
    const artifact = artifactResultPayload({
      kind: 'generated',
      fileName: target.fileName,
      filePath: target.filePath,
      bytes: candidate.generated.bytes,
    });
    if (candidate.generated.previewPath) {
      await registerOfficePreview({
        absolutePath: target.filePath,
        previewPath: candidate.generated.previewPath,
        extension: candidate.generated.extension,
        previewRoot: artifactDir(input.runId, 'attachment-previews'),
      });
    }
    input.draft.renderedArtifactId = artifact.artifactId;
    input.draft.renderedFileName = target.fileName;
    input.draft.renderedDigest = digest;
    if (!publicationReused) {
      input.draft.visualQaArtifactId = undefined;
      input.draft.visualQaDigest = undefined;
      input.draft.visualQaPageCount = undefined;
      input.draft.visualQaSeenPages = [];
      input.draft.visualQaReviews = [];
      input.draft.visualQaDeckReview = undefined;
      input.draft.visualQaPageDigests = [];
    }
    input.draft.workflow = {
      state: visualVerification && input.draft.visualQaDigest !== digest ? 'qa-pending' : 'completed',
      checkpointAt: new Date().toISOString(),
      renderedDigest: digest,
    };
    await saveDraft(input.runId, input.draft);

    return {
      ok: true,
      actual: JSON.stringify({
        ...artifact,
        documentId: input.draft.documentId,
        sourceRead: { action: 'readSource', documentId: input.draft.documentId },
        contentRead: { action: 'readContent', artifactId: artifact.artifactId, includeVisuals: false },
        sourceDigest: digest,
        validationEvidence: officeValidationEvidence(input.draft, await currentUnoWorkerDigest()),
        renderedDigest: digest,
        documentChanged: input.documentChanged || false,
        cacheHit: candidate.cacheHit,
        publicationReused,
        availableAssets: candidate.assets.map(describeDocumentAsset),
        generationDiagnostics: candidate.generated.diagnostics,
        automaticValidation: candidate.validation,
        workflow: input.draft.workflow,
        qualityGate: officeQualityGate(
          candidate.validation,
          visualVerification,
          'The selected model does not accept image input; this result is structurally verified only.',
        ),
        visualVerification: visualVerification ? {
          imageCount: visualVerification.imagePaths.length,
          pageCount: visualVerification.pageCount,
          renderedPages: visualVerification.renderedPages,
          renderer: visualVerification.renderer,
          warning: visualVerification.warning,
          automaticChecks: visualVerification.automaticChecks || [],
          automaticCheckScope: 'render-integrity-only: dimensions and near-blank detection; not a visual-quality verdict',
          gateStatus: 'pending-model-review',
          requiredCondition: 'visualQaDigest === renderedDigest, every indexed page has an evidence-backed passed review with all visual checks, and the complete artifact has a passed cross-page consistency review',
        } : {
          status: 'not-performed',
          reason: 'The selected model does not accept image input or the generated format has no page renderer; no visual conclusion was made.',
        },
      }),
      referenceImagePaths: visualVerification?.imagePaths.length ? visualVerification.imagePaths : undefined,
    };
  } catch (error) {
    const workerFailure = input.draft.generator === 'uno' && isUnoWorkerInternalError(error);
    const errorText = error instanceof Error ? error.message : String(error);
    let diagnosticSaveError: string | undefined;
    if (!officeOperationWasInterrupted(error, input.abortSignal)) {
      try {
        // A render failure must replace obsolete saved diagnostics too. Keep
        // the same source; only the evidence from this attempt is refreshed.
        await saveWorkingDraft(input.runId, input.draft);
      } catch (saveError) {
        diagnosticSaveError = saveError instanceof Error ? saveError.message : String(saveError);
      }
    }
    const validationEvidence = officeValidationEvidence(input.draft, await currentUnoWorkerDigest());
    if (workerFailure || (input.draft.generator === 'uno' && isUnoBridgeStartupError(error))) {
      return {
        ok: false,
        actual: JSON.stringify({
          kind: workerFailure ? 'office-render-infrastructure-error' : 'office-render-infrastructure-retry',
          sourceRepairRequired: false,
          sourceValidity: 'unverified',
          retryable: false,
          retryAfter: 'runtime-change-or-confirmed-recovery',
          documentId: input.draft.documentId,
          sourceDigest: sourceDigest(input.draft.program || ''),
          sourceUnchanged: true,
          validationEvidence,
          diagnosticSaveError,
          diagnostics: compactValidationDiagnosticsForTool(diagnoseOfficeProgramRuntimeError(input.draft.program || '', errorText)),
          repairHints: officeValidationRepairHints([], error instanceof Error ? error.message : String(error)),
          error: workerFailure
            ? 'LibreOffice worker failed internally. Preserve the source and report the runtime failure; retry only after the renderer is fixed.'
            : 'LibreOffice could not start after isolated retries. The Office source was unchanged and validation did not complete.',
        }),
      };
    }
    return { ok: false, actual: JSON.stringify({
      kind: 'office-render-failure',
      documentId: input.draft.documentId,
      sourceDigest: sourceDigest(input.draft.program || ''),
      sourceUnchanged: true,
      validation: input.draft.validationStatus || 'pending',
      validationEvidence,
      validationFailureCount: input.draft.validationFailureCount || 0,
      diagnosticSaveError,
      diagnostics: compactValidationDiagnosticsForTool(input.draft.validationDiagnostics),
      repairHints: officeValidationRepairHints(input.draft.validationDiagnostics, errorText),
      error: errorText,
    }) };
  } finally {
    if (publishCandidatePath) await unlink(publishCandidatePath).catch(() => undefined);
  }
}

async function planFileArtifactUnlocked(input: PlanArtifactInput): Promise<FileArtifactOperationResult> {
  try {
    const documentId = String(input.documentId || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(documentId)) {
      return {
        ok: false,
        actual: 'file action=plan requires a stable model-chosen documentId (1-96 ASCII letters, numbers, dot, underscore, or hyphen). Reuse exactly the same documentId for every re-plan, generate, edit, render, and visual correction of this logical document.',
      };
    }
    if (!String(input.fileName || '').trim()) return { ok: false, actual: 'file action=plan requires fileName.' };
    if (!input.documentType) return { ok: false, actual: 'file action=plan requires documentType.' };
    const designResult = input.design === undefined ? undefined : officeDesignBriefSchema.safeParse(input.design);
    if (designResult && !designResult.success) return { ok: false, actual: JSON.stringify({
      kind: 'document-design-invalid', code: 'DESIGN_BRIEF_INVALID', saved: false,
      documentId, issues: designResult.error.issues.map((issue) => ({ field: `design.${issue.path.join('.')}`, message: issue.message })),
      instruction: 'Correct only the initial design brief in plan. No source or file was changed.',
    }) };
    const requestedDesign = designResult?.success ? designResult.data : undefined;
    const requestedFileName = sanitizeFileName(input.fileName, `document-${Date.now()}.pdf`);
    let existing: OfficeDocumentDraft | undefined;
    try {
      existing = await loadDraft(input.runId, documentId);
      if (existing.documentType !== input.documentType) {
        return {
          ok: false,
          actual: `documentId ${documentId} already belongs to a ${existing.documentType} document. Reuse it only for that logical document or choose a different stable documentId for a genuinely different output.`,
        };
      }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code || '')
        : '';
      if (code !== 'ENOENT') throw error;
    }
    // Re-planning an already-authored documentId is idempotent. In particular,
    // a recovery call must not be rejected merely because the model supplied
    // operation=modify without an Office attachment: the existing workspace,
    // source identity, and original operation remain authoritative.
    if (existing?.program || existing?.renderedFileName) {
      return {
        ok: true,
        actual: JSON.stringify({
          kind: 'document-plan',
          documentId: existing.documentId,
          fileName: existing.fileName,
          documentType: existing.documentType,
          operation: existing.operation || 'create',
          generator: existing.generator || 'uno',
          sourceDocument: existing.sourceDocument,
          sourceFileName: path.basename(draftProgramPath(input.runId, existing.documentId, existing.generator)),
          sourceCharacters: existing.program?.length || 0,
          semanticGeneration: semanticGenerationPlan(existing.operation || 'create', existing.generator || 'uno', officeDesignGuidance(existing)),
          design: existing.design,
          designGuidance: officeDesignGuidance(existing),
          workflow: existing.workflow,
          reused: true,
          instruction: input.design ? 'Authored workspace reused without replacing its original design brief or source. Apply user-authorized revisions through edit; do not regenerate merely to change planning metadata.' : undefined,
        }),
      };
    }
    const assets = await syncDocumentAssets(input.runId, input.attachmentBindings);
    const sourcePlan = await plannedSourceDocument(input, assets);
    const generator = configuredOfficeGenerator(requestedFileName, sourcePlan.operation);
    if (existing) {
      existing.fileName = requestedFileName;
      existing.intent = input.intent ?? existing.intent;
      existing.design = requestedDesign ?? existing.design;
      existing.operation = sourcePlan.operation;
      existing.generator = generator;
      existing.sourceDocument = sourcePlan.sourceDocument;
      await saveDraft(input.runId, existing);
      return {
        ok: true,
        actual: JSON.stringify({
          kind: 'document-plan',
          documentId: existing.documentId,
          fileName: existing.fileName,
          documentType: existing.documentType,
          operation: existing.operation || 'create',
          generator: existing.generator || 'uno',
          sourceDocument: existing.sourceDocument,
          sourceFileName: path.basename(draftProgramPath(input.runId, existing.documentId, existing.generator)),
          sourceCharacters: 0,
          semanticGeneration: semanticGenerationPlan(existing.operation || 'create', existing.generator || 'uno', officeDesignGuidance(existing)),
          design: existing.design,
          designGuidance: officeDesignGuidance(existing),
          workflow: existing.workflow,
          reused: true,
        }),
      };
    }
    const now = new Date().toISOString();
    const draft: OfficeDocumentDraft = {
      createdAt: now,
      documentId,
      documentType: input.documentType,
      fileName: requestedFileName,
      intent: input.intent,
      design: requestedDesign,
      operation: sourcePlan.operation,
      generator,
      sourceDocument: sourcePlan.sourceDocument,
      workflow: { state: 'planned', checkpointAt: now },
      updatedAt: now,
    };
    await saveDraft(input.runId, draft);
    return { ok: true, actual: JSON.stringify({
      kind: 'document-plan',
      documentId: draft.documentId,
      fileName: draft.fileName,
      documentType: draft.documentType,
      operation: draft.operation,
      generator: draft.generator,
      sourceDocument: draft.sourceDocument,
      sourceFileName: path.basename(draftProgramPath(input.runId, draft.documentId, draft.generator)),
      sourceCharacters: 0,
      semanticGeneration: semanticGenerationPlan(draft.operation || 'create', draft.generator || 'uno', officeDesignGuidance(draft)),
      design: draft.design,
      designGuidance: officeDesignGuidance(draft),
      workflow: draft.workflow,
      instruction: draft.operation === 'modify'
        ? `Open the existing file through the matching high-level facade with source_name=${JSON.stringify(draft.sourceDocument?.assetName)}. Query the unoApi existing-object module, then copy its selectors and preserve-only policy; raw UNO and job.expert are not model-facing. Do not recreate the document.`
        : undefined,
    }) };
  } catch (error) {
    return { ok: false, actual: `file planning failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function generateUnoFileArtifactUnlocked(input: GenerateUnoProgramInput): Promise<FileArtifactOperationResult> {
  try {
    const documentId = String(input.documentId || '').trim();
    if (!documentId) return { ok: false, actual: 'file action=generate requires documentId from action=plan.' };
    const submittedProgram = String(input.program || '').trim();
    const semanticSpec = input.spec && typeof input.spec === 'object' ? input.spec : undefined;
    if (Boolean(submittedProgram) === Boolean(semanticSpec)) {
      return { ok: false, actual: 'file action=generate requires exactly one of program or spec.' };
    }
    let persistedDraft: OfficeDocumentDraft;
    try {
      persistedDraft = await loadDraft(input.runId, documentId);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code || '')
        : '';
      if (code === 'ENOENT') {
        return { ok: false, actual: `Office draft ${documentId} is not planned. Call action=plan before action=generate.` };
      }
      throw error;
    }
    let program = submittedProgram;
    let semantic: OfficeDocumentDraft['semantic'];
    if (semanticSpec) {
      if ((persistedDraft.operation || 'create') !== 'create') {
        return {
          ok: false,
          actual: 'Semantic generation is available only for new documents. Existing-file modification must preserve the source through the UNO program workflow.',
        };
      }
      if (semanticSpec.documentType && semanticSpec.documentType !== persistedDraft.documentType) {
        return {
          ok: false,
          actual: `Semantic spec documentType=${semanticSpec.documentType} does not match the planned ${persistedDraft.documentType} workspace.`,
        };
      }
      if (semanticSpec.fileName && sanitizeFileName(semanticSpec.fileName, '') !== persistedDraft.fileName) {
        return {
          ok: false,
          actual: `Semantic spec fileName=${semanticSpec.fileName} does not match the planned fileName=${persistedDraft.fileName}.`,
        };
      }
      let compiled: ReturnType<typeof compileOfficeSemanticDocument>;
      try {
        compiled = compileOfficeSemanticDocument({
          ...semanticSpec,
          documentType: persistedDraft.documentType,
          fileName: persistedDraft.fileName,
        }, persistedDraft.generator || 'uno');
      } catch (error) {
        const diagnostics = error && typeof error === 'object' && 'diagnostics' in error
          ? (error as { diagnostics?: unknown }).diagnostics
          : undefined;
        return {
          ok: false,
          actual: JSON.stringify({
            kind: 'semantic-document-validation',
            documentId,
            fileName: persistedDraft.fileName,
            documentType: persistedDraft.documentType,
            saved: false,
            diagnostics,
            error: error instanceof Error ? error.message : String(error),
          }),
        };
      }
      program = compiled.program;
      semantic = {
        schemaVersion: '1.0',
        theme: compiled.theme,
        layout: compiled.layout,
        diagnostics: compiled.diagnostics,
      };
    }
    const existingProgram = persistedDraft.program || '';
    const existingDigest = sourceDigest(existingProgram);
    const removesEntrypoint = /\b(?:async\s+)?(?:def|function)\s+create_document\b/.test(existingProgram)
      && !/\b(?:async\s+)?(?:def|function)\s+create_document\b/.test(program);
    const drasticShrink = existingProgram.length >= 1_000
      && program.length < Math.max(200, Math.floor(existingProgram.length * 0.35));
    const replacingExistingSource = Boolean(existingProgram.trim());
    const replacementAuthorized = input.replaceExisting === true
      && String(input.baseDigest || '').toLowerCase() === existingDigest;
    if (replacingExistingSource && !replacementAuthorized) {
      return {
        ok: false,
        actual: JSON.stringify({
          kind: 'uno-draft-destructive-generate-blocked',
          code: 'DESTRUCTIVE_GENERATE_REQUIRES_CONFIRMATION',
          documentId,
          changed: false,
          saved: false,
          sourceCharacters: existingProgram.length,
          sourceDigest: existingDigest,
          patchBaseDigest: existingDigest,
          error: `action=generate found an existing working source${drasticShrink || removesEntrypoint ? ' and this replacement would discard most of it or its create_document entrypoint' : ''}. Replacing it requires replaceExisting=true with the current baseDigest. A smaller change may instead be submitted through action=edit.`,
        }),
      };
    }
    const draft = structuredClone(persistedDraft);
    draft.program = program;
    delete draft.lastSourceEdit;
    if (semantic) draft.semantic = semantic;
    else delete draft.semantic;
    draft.validationStatus = 'pending';
    draft.validationFailureCount = 0;
    draft.validationDiagnostics = [];
    delete draft.elementMap;
    delete draft.rendererValidation;
    invalidateActiveVisualQa(draft);
    draft.workflow = { state: 'authoring', checkpointAt: new Date().toISOString() };
    // A documentId owns exactly one editable source buffer. An explicitly
    // authorized generate atomically replaces that same buffer.
    return validateDraft({ ...input, draft, documentChanged: true });
  } catch (error) {
    return { ok: false, actual: `Office source generation failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function editUnoFileArtifactUnlocked(input: EditUnoProgramInput): Promise<FileArtifactOperationResult> {
  try {
    const documentId = String(input.documentId || '').trim();
    if (!documentId) return { ok: false, actual: 'file action=edit requires documentId.' };
    if (typeof input.program === 'string' && input.program.trim()) {
      return {
        ok: false,
        actual: 'file action=edit requires exact oldText/newText replacements or a Codex-format patch, not a complete program. Read current source and patchBaseDigest; do not switch to generate after an edit or validation failure.',
      };
    }
    const persistedDraft = await loadDraft(input.runId, documentId);
    if (!persistedDraft.program) return { ok: false, actual: `Office draft ${documentId} has no program yet; call action=generate first.` };
    const requestedPath = input.path ? normalizedSourceUnitPath(input.path) : undefined;
    // Global edits do not need a valid optional source-unit index. Otherwise
    // an unmatched marker prevents the very edit required to repair it.
    const sourceUnits = requestedPath ? sourceUnitsForDraft(persistedDraft.program, persistedDraft) : [];
    const requestedUnit = sourceUnitForRequestedPath(sourceUnits, requestedPath);
    const editableSource = requestedUnit?.content ?? persistedDraft.program;
    const draftDigest = sourceDigest(persistedDraft.program);
    const draft = structuredClone(persistedDraft);
    const patchText = typeof input.patch === 'string' ? input.patch : '';
    const hasPatch = Boolean(patchText.trim());
    const hasReplacements = input.replacements !== undefined;
    if (hasPatch === hasReplacements) {
      return { ok: false, actual: 'file action=edit requires exactly one of patch or replacements (exact oldText/newText pairs). For indentation repairs prefer replacements.' };
    }
    const baseDigest = String(input.baseDigest || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(baseDigest)) {
      return { ok: false, actual: 'file action=edit patch requires baseDigest copied from the latest readSource.patchBaseDigest, not an artifactId or a render digest.' };
    }
    if (hasReplacements && (!Array.isArray(input.replacements) || input.replacements.some((item) => !item || typeof item.oldText !== 'string' || typeof item.newText !== 'string'))) {
      return { ok: false, actual: JSON.stringify({
        kind: 'uno-draft-patch-conflict', code: 'PATCH_INPUT_REJECTED', editStatus: 'rejected',
        documentId, changed: false, saved: false, patchBaseDigest: draftDigest,
        error: 'replacements must be an array of literal oldText/newText string pairs. No source was changed.',
      }) };
    }
    const requestDigest = sourceDigest(JSON.stringify({
      baseDigest, path: requestedPath || null,
      patch: hasPatch ? normalizedDraftSource(patchText).trim() : null,
      replacements: hasReplacements ? input.replacements!.map((item) => ({ oldText: normalizedDraftSource(item.oldText), newText: normalizedDraftSource(item.newText) })) : null,
    }));
    const receipt = persistedDraft.lastSourceEdit;
    if (receipt?.requestDigest === requestDigest && receipt.afterDigest === draftDigest && receipt.beforeDigest === baseDigest) {
      return { ok: persistedDraft.validationStatus !== 'failed', actual: JSON.stringify({
        kind: 'uno-draft-patch-no-changes', code: 'EDIT_REPLAY_CONFIRMED', editStatus: 'already-applied',
        documentId, changed: false, saved: true, patchBaseDigest: draftDigest, sourceUnitPath: requestedPath,
        patchHunks: { applied: 0, alreadyApplied: receipt.totalHunks, failed: [], blocked: [], total: receipt.totalHunks },
        validationStatus: persistedDraft.validationStatus || 'pending',
        diagnostics: compactValidationDiagnosticsForTool(persistedDraft.validationDiagnostics),
        message: 'The identical edit is confirmed by its saved receipt and current source revision. No source write or validation was repeated. Saved source is not proof of successful validation.',
      }) };
    }
    if (baseDigest !== draftDigest) {
      return { ok: false, actual: JSON.stringify({
        kind: 'uno-draft-patch-conflict', code: 'PATCH_BASE_DIGEST_MISMATCH', editStatus: 'rejected',
        documentId, changed: false, saved: false, patchBaseDigest: draftDigest,
        expectedBaseDigest: draftDigest, suppliedBaseDigest: baseDigest, sourceUnitPath: requestedPath,
        error: 'Source revision changed and this request is not a confirmed replay. No automatic rebase or source write was performed. Read only the affected source window and prepare the edit again.',
        nextAction: { action: 'readSource', documentId, ...(requestedUnit ? { path: requestedPath } : {}) },
      }) };
    }
    if (requestedPath && !requestedUnit) {
      return { ok: false, actual: JSON.stringify({
        kind: 'uno-draft-patch-conflict', code: 'SOURCE_UNIT_NOT_FOUND', editStatus: 'rejected',
        documentId, changed: false, saved: false, patchBaseDigest: draftDigest,
        error: `Unknown source unit ${requestedPath}. Read the current source index; do not guess a path.`,
        nextAction: { action: 'readSource', documentId },
      }) };
    }
    let patchResult: UnoDraftPatchResult;
    try {
      patchResult = hasReplacements
        ? applyUnoDraftReplacements(editableSource, input.replacements!)
        : applyUnoDraftPatchHunks(editableSource, patchText);
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      return { ok: false, actual: JSON.stringify({
        kind: 'uno-draft-patch-conflict', code: 'PATCH_INPUT_REJECTED', editStatus: 'rejected', documentId,
        changed: false, saved: false, patchBaseDigest: draftDigest, error: errorText,
        recoverySuggestion: 'No source was changed. Correct the edit format or size using the source already in context; readSource only if the exact target is missing.',
      }) };
    }
    if (patchResult.failedHunks.length) {
      return {
        ok: false,
        actual: JSON.stringify({
          kind: 'uno-draft-patch-conflict',
          code: 'PATCH_ATOMIC_CONFLICT',
          editStatus: 'rejected', changed: false, saved: false, patchBaseDigest: draftDigest,
          documentId,
          sourceUnitPath: requestedUnit?.path,
          expectedBaseDigest: draftDigest,
          suppliedBaseDigest: baseDigest,
          patchHunks: {
            applied: 0,
            alreadyApplied: patchResult.alreadyAppliedHunks,
            failed: patchResult.failedHunks,
            blocked: patchResult.blockedHunks,
            ignored: patchResult.ignoredHunks,
            total: patchResult.totalHunks,
          },
          error: 'Atomic edit rejected: no hunks were saved. Resolve the reported conflicts using the exact sourceContext when available, keep the blocked valid hunks in the corrected batch, and resubmit against the current source. Do not treat blocked hunks as applied. The context is diagnostic evidence, not an automatically matched replacement.',
          nextAction: patchResult.failedHunks.every((failure) => failure.sourceContext)
            ? undefined
            : { action: 'readSource', documentId, ...(requestedPath ? { path: requestedPath } : {}) },
        }),
      };
    }
    const edited = patchResult.source;
    draft.program = requestedUnit ? replaceSourceUnit(persistedDraft.program, requestedUnit, edited) : edited;
    // A raw source patch detaches the executable draft from its compact semantic input.
    // Validation still applies, but stale theme/reflow provenance must not be reported.
    delete draft.semantic;
    if (draft.program === normalizedDraftSource(persistedDraft.program)) {
      return {
        ok: patchResult.failedHunks.length === 0 && persistedDraft.validationStatus !== 'failed',
        actual: JSON.stringify({
          kind: 'uno-draft-patch-no-changes',
          code: 'PATCH_NO_CHANGES',
          editStatus: 'no-change',
          documentId,
          fileName: draft.fileName,
          changed: false,
          saved: true,
          patchHunks: {
            applied: patchResult.appliedHunks,
            alreadyApplied: patchResult.alreadyAppliedHunks,
            failed: patchResult.failedHunks,
            ignored: patchResult.ignoredHunks,
            total: patchResult.totalHunks,
          },
          sourceCharacters: persistedDraft.program.length,
          sourceDigest: sourceDigest(persistedDraft.program),
          patchBaseDigest: draftDigest,
          sourceUnitPath: requestedUnit?.path,
          lineCount: draftSourceLineCount(editableSource),
          validationStatus: persistedDraft.validationStatus || 'pending',
          message: persistedDraft.validationStatus === 'failed'
              ? 'These exact source changes are already present, but validation still fails. Repair the saved diagnostics; do not force byte changes with comments.'
              : 'The patch target is already satisfied. No source bytes needed to change.',
        }),
      };
    }
    draft.validationStatus = 'pending';
    draft.validationDiagnostics = [];
    draft.lastSourceEdit = { requestDigest, beforeDigest: draftDigest, afterDigest: sourceDigest(draft.program), totalHunks: patchResult.totalHunks };
    invalidateActiveVisualQa(draft);
    draft.workflow = { state: 'authoring', checkpointAt: new Date().toISOString() };
    const currentValidationUnit = requestedUnit;
    // The current source is the editor buffer. Validation failures keep that
    // exact buffer and diagnostics so the next edit can repair it in place.
    // A path-scoped patch may execute that source unit in isolation after the
    // complete source passes AST preflight. Final render validates the full source.
    const validationResult = await (currentValidationUnit && currentValidationUnit.kind !== 'symbol'
      ? validateDraftSourceUnit({ ...input, draft, sourceUnitPath: currentValidationUnit.path })
      : validateDraft({ ...input, draft, documentChanged: true }));
    if (!validationResult.ok) {
      let failure: Record<string, unknown> = {};
      try {
        failure = JSON.parse(String(validationResult.actual || '{}')) as Record<string, unknown>;
      } catch {
        failure = { error: validationResult.actual || 'validation failed' };
      }
      const patchWasSaved = failure.saved === true;
      const infrastructureFailure = failure.sourceRepairRequired === false;
      return {
        // Preserve the editor buffer, but do not report a broken document as success.
        ok: false,
        actual: JSON.stringify({
          ...failure,
          editStatus: failure.saved === true ? 'patch-applied' : 'save-failed',
          patchHunks: {
            applied: patchWasSaved ? patchResult.appliedHunks : 0,
            alreadyApplied: patchResult.alreadyAppliedHunks,
            failed: patchResult.failedHunks,
            ignored: patchResult.ignoredHunks,
            total: patchResult.totalHunks,
          },
          changed: patchWasSaved,
          saved: patchWasSaved,
          patchBaseDigest: patchWasSaved ? sourceDigest(draft.program || '') : draftDigest,
          ...(!infrastructureFailure ? { nextAction: { action: 'readSource', documentId, includeDiagnostics: true } } : {}),
          sourceDigest: patchWasSaved ? sourceDigest(draft.program || '') : draftDigest,
          sourceCharacters: draft.program?.length || 0,
          diagnostics: failure.diagnostics || draft.validationDiagnostics || [],
          validation: infrastructureFailure ? 'pending' : 'failed',
          recoverySuggestion: !patchWasSaved ? 'Source save failed. Read the persisted source before retrying; candidate edits are not confirmed as saved.' : failure.recoverySuggestion
            || (infrastructureFailure
              ? 'Validation did not complete because of a renderer failure, not a demonstrated source defect. Preserve the applied edits and follow repairHints; do not change source or replay edits to repair the runtime.'
              : 'Source saved, validation FAILED. Do not replay applied edits or add comments to force a change. Read the failing block and repair it with exact oldText/newText replacements and this patchBaseDigest. Rendering remains blocked.'),
          workflow: compactWorkflowForTool(draft.workflow),
        }),
      };
    }
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(String(validationResult.actual || '{}')) as Record<string, unknown>;
    } catch {
      payload = { actual: validationResult.actual };
    }
    return {
      ...validationResult,
      actual: JSON.stringify({
        ...payload,
        editStatus: 'patch-applied',
        changed: true,
        saved: true,
        patchBaseDigest: sourceDigest(draft.program || ''),
        patchHunks: {
          applied: patchResult.appliedHunks,
          alreadyApplied: patchResult.alreadyAppliedHunks,
          failed: patchResult.failedHunks,
          ignored: patchResult.ignoredHunks,
          total: patchResult.totalHunks,
        },
      }),
    };
  } catch (error) {
    return { ok: false, actual: `Office draft edit failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function renderFileArtifactUnlocked(input: RenderArtifactInput): Promise<FileArtifactOperationResult> {
  try {
    const documentId = String(input.documentId || '').trim();
    if (!documentId) return { ok: false, actual: 'file action=render requires documentId.' };
    const draft = await loadDraft(input.runId, documentId);
    return renderDraft({ ...input, draft });
  } catch (error) {
    return { ok: false, actual: `file rendering failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function readUnoDraft(input: ReadUnoDraftInput): Promise<FileArtifactOperationResult> {
  try {
    const documentId = requireDocumentId(input.documentId, 'readSource');
    return await withDraftLock(input.runId, documentId, () => readUnoDraftUnlocked({ ...input, documentId }), input.abortSignal);
  } catch (error) {
    return { ok: false, actual: `Office draft read failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function planFileArtifact(input: PlanArtifactInput): Promise<FileArtifactOperationResult> {
  const documentId = String(input.documentId || '').trim();
  if (!DOCUMENT_ID_PATTERN.test(documentId)) {
    return { ok: false, actual: 'file action=plan requires a stable model-chosen documentId (1-96 ASCII letters, numbers, dot, underscore, or hyphen).' };
  }
  const result = await withDraftLock(input.runId, documentId, () => planFileArtifactUnlocked({ ...input, documentId }), input.abortSignal);
  if (!result.ok) return result;
  try {
    const payload = JSON.parse(result.actual) as Record<string, unknown>;
    const assets = await syncDocumentAssets(input.runId, input.attachmentBindings);
    return {
      ...result,
      actual: JSON.stringify({
        ...payload,
        availableAssets: assets.map(describeDocumentAsset),
      }),
    };
  } catch {
    return result;
  }
}

export async function generateUnoFileArtifact(input: GenerateUnoProgramInput): Promise<FileArtifactOperationResult> {
  try {
    const documentId = requireDocumentId(input.documentId, 'generate');
    return await withDraftLock(input.runId, documentId, () => generateUnoFileArtifactUnlocked({ ...input, documentId }), input.abortSignal);
  } catch (error) {
    return { ok: false, actual: `Office source generation failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function editUnoFileArtifact(input: EditUnoProgramInput): Promise<FileArtifactOperationResult> {
  try {
    const documentId = await resolveEditDocumentId(input.runId, input.documentId, input.baseDigest);
    return await withDraftLock(input.runId, documentId, () => editUnoFileArtifactUnlocked({ ...input, documentId }), input.abortSignal);
  } catch (error) {
    return { ok: false, actual: `Office draft edit failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function renderFileArtifact(input: RenderArtifactInput): Promise<FileArtifactOperationResult> {
  try {
    const documentId = requireDocumentId(input.documentId, 'render');
    return await withDraftLock(input.runId, documentId, () => renderFileArtifactUnlocked({ ...input, documentId }), input.abortSignal);
  } catch (error) {
    return { ok: false, actual: `file rendering failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function bindNodeFileWorkspaceOperation<TArgs extends unknown[], TResult>(
  host: ResolvedNodeFileWorkspaceHost,
  operation: (...args: TArgs) => TResult,
) {
  return (...args: TArgs) => nodeFileWorkspaceHost.run(host, () => operation(...args));
}

function legacyOperationData(actual: string): unknown {
  try {
    return JSON.parse(actual) as unknown;
  } catch {
    return actual;
  }
}

function structuredOperationErrorCode(data: unknown, fallback: string) {
  const candidate = data && typeof data === 'object' && !Array.isArray(data)
    ? (data as { code?: unknown }).code
    : undefined;
  if (typeof candidate !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(candidate)) return fallback;
  return candidate.trim().toLowerCase().replace(/[_.]+/g, '-');
}

function structuredFileOperationResult(
  result: FileArtifactOperationResult,
  fallbackErrorCode: string,
): FileArtifactOperationResult {
  if (result.data !== undefined || result.error) return result;
  const data = legacyOperationData(result.actual);
  if (result.ok) {
    return { ...result, data };
  }
  return {
    ...result,
    data,
    error: {
      code: structuredOperationErrorCode(data, fallbackErrorCode),
      message: result.actual,
      details: data,
    },
  };
}

function bindNodeFileWorkspaceResultOperation<TArgs extends unknown[]>(
  host: ResolvedNodeFileWorkspaceHost,
  operation: (...args: TArgs) => Promise<FileArtifactOperationResult>,
  fallbackErrorCode: string,
) {
  return (...args: TArgs) => nodeFileWorkspaceHost.run(
    host,
    async () => structuredFileOperationResult(await operation(...args), fallbackErrorCode),
  );
}

/**
 * Creates one host-bound Office draft workspace. The returned operations keep
 * artifact paths, URL mapping, downloads, conversions, and preview rendering
 * scoped to this instance even when multiple agent frameworks share a process.
 */
export function createNodeFileWorkspace(options: NodeFileWorkspaceHost) {
  const host = resolveNodeFileWorkspaceHost(options);
  return Object.freeze({
    artifactsRoot: host.artifactsRoot,
    syncDocumentAssets: bindNodeFileWorkspaceOperation(host, syncDocumentAssets),
    downloadFileArtifact: bindNodeFileWorkspaceResultOperation(host, downloadFileArtifact, 'file-download-failed'),
    convertFileArtifact: bindNodeFileWorkspaceResultOperation(host, convertFileArtifact, 'file-convert-failed'),
    listOfficeDraftCatalog: bindNodeFileWorkspaceOperation(host, listOfficeDraftCatalog),
    listOfficeDrafts: bindNodeFileWorkspaceResultOperation(host, listOfficeDrafts, 'file-list-failed'),
    officeDraftCatalogForPrompt: bindNodeFileWorkspaceOperation(host, officeDraftCatalogForPrompt),
    getUnoApi: bindNodeFileWorkspaceResultOperation(host, getUnoApi, 'file-uno-api-failed'),
    getOfficeJsApi: bindNodeFileWorkspaceResultOperation(host, getOfficeJsApi, 'file-js-api-failed'),
    verifyCurrentUnoRenderedArtifact: bindNodeFileWorkspaceResultOperation(host, verifyCurrentUnoRenderedArtifact, 'file-visual-version-failed'),
    recordOfficeVisualQaProgress: bindNodeFileWorkspaceResultOperation(host, recordOfficeVisualQaProgress, 'file-visual-report-failed'),
    readUnoDraft: bindNodeFileWorkspaceResultOperation(host, readUnoDraft, 'file-read-failed'),
    planFileArtifact: bindNodeFileWorkspaceResultOperation(host, planFileArtifact, 'file-plan-failed'),
    generateUnoFileArtifact: bindNodeFileWorkspaceResultOperation(host, generateUnoFileArtifact, 'file-generate-failed'),
    editUnoFileArtifact: bindNodeFileWorkspaceResultOperation(host, editUnoFileArtifact, 'file-edit-failed'),
    renderFileArtifact: bindNodeFileWorkspaceResultOperation(host, renderFileArtifact, 'file-render-failed'),
    async health() {
      const [download, conversion] = await Promise.all([
        host.downloader.health(),
        host.converter.health(),
      ]);
      if (download.status !== 'healthy') return download;
      if (conversion.status !== 'healthy') return conversion;
      return {
        status: 'healthy' as const,
        details: { download: download.details, conversion: conversion.details },
      };
    },
    dispose: () => host.dispose(),
  });
}

export type NodeFileWorkspace = ReturnType<typeof createNodeFileWorkspace>;
