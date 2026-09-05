import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, type Dirent } from 'node:fs';
import { access, copyFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { raceWithAbort, type CapabilityConfiguration } from '@webpilot/capability-sdk';
import type {
  FileArtifactOperationResult,
  FileAttachmentBinding,
} from '../types.js';
import { generateFileToPaths } from './generate.js';
import {
  createNodeFileConverter,
  type NodeFileConvertInput,
  type NodeFileConvertExecutionOptions,
  type NodeFileConverter,
} from './convert.js';
import {
  createNodeFileDownloader,
  type NodeFileDownloadInput,
  type NodeFileDownloadExecutionOptions,
  type NodeFileDownloader,
} from './download.js';
import { sanitizeNodeArtifactFileName, type NodeArtifactUrlResolver } from './artifacts.js';
import { inspectUnoApi, isUnoBridgeStartupError, isUnoStylePropertyInfoError, isUnoWorkerInternalError } from './office/uno.js';
import { validateOfficeArtifact, type OfficeElementMapEntry } from './office/validation.js';
import { validateOfficeRendererMatrix } from './office/render-validation.js';
import {
  analyzeOfficeProgram,
  diagnoseOfficeProgramRuntimeError,
  type OfficeProgramDiagnostic,
} from './office/program-analysis.js';
import type {
  OfficeDocumentDraft,
  OfficeDocumentKind,
  OfficeSemanticDocumentInput,
  OfficeVisualQaDeckChecks,
  OfficeVisualQaPageChecks,
} from '../office/types.js';
import { registerOfficePreview, renderFilePreview, type FilePreviewResult } from './office/preview.js';
import { officeGenerationRuntimeFingerprint } from './office/runtime-fingerprint.js';
import { beginOfficeValidation, currentUnoWorkerDigest, officeValidationEvidence } from './office/validation-evidence.js';
import { compileOfficeSemanticDocument } from './office/semantic.js';
import { officeDesignBriefSchema, officeDesignGuidance, missingDesignReviewChecks } from '../design-guidance.js';

export type NodeFileWorkspaceHost = {
  artifactsRoot: string;
  artifactUrl?: NodeArtifactUrlResolver;
  configuration?: CapabilityConfiguration;
  converter?: NodeFileConverter;
  downloader?: NodeFileDownloader;
  officeGenerationMode?: 'auto' | 'javascript' | 'uno';
  renderPreview?: (input: Parameters<typeof renderFilePreview>[0]) => Promise<FilePreviewResult>;
};

type ResolvedNodeFileWorkspaceHost = Required<Pick<NodeFileWorkspaceHost, 'artifactsRoot' | 'converter' | 'downloader' | 'renderPreview'>> & {
  artifactUrl: NodeArtifactUrlResolver;
  officeGenerationMode: 'auto' | 'javascript' | 'uno';
  dispose(): Promise<void>;
};

const nodeFileWorkspaceHost = new AsyncLocalStorage<ResolvedNodeFileWorkspaceHost>();
let defaultNodeFileWorkspaceHost: ResolvedNodeFileWorkspaceHost | undefined;

function resolveNodeFileWorkspaceHost(options: NodeFileWorkspaceHost): ResolvedNodeFileWorkspaceHost {
  const artifactsRoot = path.resolve(options.artifactsRoot);
  const artifactUrl = options.artifactUrl || ((input) => pathToFileURL(input.absolutePath).href);
  const renderPreview = options.renderPreview || renderFilePreview;
  const downloader = options.downloader || createNodeFileDownloader({ artifactsRoot, artifactUrl });
  const converter = options.converter || createNodeFileConverter({
    artifactsRoot,
    artifactUrl,
    renderPreview: async (input) => renderPreview(input),
  });
  const configuredOfficeGenerationMode = String(
    options.officeGenerationMode || options.configuration?.OFFICE_GENERATION_MODE || 'uno',
  ).trim().toLowerCase();
  const officeGenerationMode = configuredOfficeGenerationMode === 'auto'
    || configuredOfficeGenerationMode === 'javascript'
    || configuredOfficeGenerationMode === 'uno'
    ? configuredOfficeGenerationMode
    : 'uno';
  return {
    artifactsRoot,
    artifactUrl,
    converter,
    downloader,
    officeGenerationMode,
    renderPreview,
    async dispose() {
      await Promise.all([
        options.downloader ? Promise.resolve() : downloader.dispose(),
        options.converter ? Promise.resolve() : converter.dispose(),
      ]);
    },
  };
}

function currentNodeFileWorkspaceHost() {
  const scoped = nodeFileWorkspaceHost.getStore();
  if (scoped) return scoped;
  const artifactsRoot = path.resolve(
    process.env.CAPABILITY_FILE_ARTIFACTS_DIR
      || process.env.ARTIFACTS_DIR
      || path.join(process.cwd(), 'runtime', 'artifacts'),
  );
  if (!defaultNodeFileWorkspaceHost || defaultNodeFileWorkspaceHost.artifactsRoot !== artifactsRoot) {
    void defaultNodeFileWorkspaceHost?.dispose();
    defaultNodeFileWorkspaceHost = resolveNodeFileWorkspaceHost({ artifactsRoot });
  }
  return defaultNodeFileWorkspaceHost;
}

const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const draftLocks = new Map<string, Promise<void>>();
const DRAFT_LOCK_WAIT_MS = 120_000;
const STALE_DRAFT_LOCK_MS = 10 * 60_000;

function officeOperationWasInterrupted(error: unknown, abortSignal?: AbortSignal) {
  if (abortSignal?.aborted) return true;
  return /(?:AbortError|operation (?:was )?aborted)/i
    .test(error instanceof Error ? error.message : String(error));
}

const TOOL_ERROR_MAX_CHARACTERS = 6_000;
const OFFICE_PIPELINE_VERSION = 'office-pipeline-v13-cjk-shared-preview';
const VISUAL_QA_PAGE_CHECKS = [
  'overlap', 'clipping', 'alignment', 'spacing', 'typography', 'contrast',
  'visualHierarchy', 'chartTableLegibility', 'imageQuality',
] as const;
const VISUAL_QA_DECK_CHECKS = [
  'templateConsistency', 'typographyConsistency', 'colorConsistency',
  'spacingRhythm', 'componentConsistency',
] as const;

function failedPageVisualChecks(checks: OfficeVisualQaPageChecks | undefined) {
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

function failedDeckVisualChecks(checks: OfficeVisualQaDeckChecks | undefined) {
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

export type PlanArtifactInput = {
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
  runId?: string;
  documentId?: string;
  documentType?: OfficeDocumentKind;
  query?: string;
  offset?: number;
  limit?: number;
};

export type ReadUnoDraftInput = {
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

type ArtifactToolPayload = {
  documentType?: OfficeDocumentKind;
  sourceFileName?: string;
  sourceDocument?: OfficeDocumentDraft['sourceDocument'];
  semanticGeneration?: ReturnType<typeof semanticGenerationPlan>;
  design?: OfficeDocumentDraft['design'];
  designGuidance?: ReturnType<typeof officeDesignGuidance>;
  workflow?: OfficeDocumentDraft['workflow'];
  reused?: boolean;
  instruction?: string;
  artifactId?: string;
  kind?: string;
  fileName?: string;
  path?: string;
  url?: string;
  downloadUrl?: string;
  bytes?: number;
  sourceUrl?: string;
  documentId?: string;
  generator?: string;
  operation?: string;
  sourceCharacters?: number;
  cacheHit?: boolean;
  changed?: boolean;
  code?: string;
  expectedBaseDigest?: string;
  suppliedBaseDigest?: string;
  patchBaseDigest?: string;
  sourceDigest?: string;
  sourceUnitPath?: string;
  validation?: string;
  validationStatus?: string;
  validationFailureCount?: number;
  saved?: boolean;
  editStatus?: string;
  patchHunks?: {
    applied: number;
    alreadyApplied?: number;
    failed: UnoDraftPatchHunkFailure[];
    blocked?: number[];
    total: number;
  };
  nextAction?: Record<string, unknown>;
  sourceRepairRequired?: boolean;
  sourceValidity?: string;
  retryable?: boolean;
  retryAfter?: string;
  validationEvidence?: OfficeDocumentDraft['validationEvidence'];
  message?: string;
  error?: string;
  recoverySuggestion?: string;
  repairHints?: string[];
  diagnostics?: Array<{
    code?: string;
    column?: number;
    elementId?: string;
    elementIds?: string[];
    line?: number;
    locator?: Record<string, unknown>;
    message?: string;
    page?: number;
    repairHint?: string;
    severity?: string;
    shapes?: number[];
    sourceExcerpt?: string;
    target?: string;
  }>;
  automaticValidation?: {
    formatChecks?: unknown;
    issues?: Array<{ code?: string; message?: string; severity?: string }>;
    passed?: boolean;
  };
  visualVerification?: {
    gateStatus?: string;
    imageCount?: number;
    pageCount?: number;
    renderedPages?: number[];
    status?: string;
  };
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

function escapeMarkdownLinkLabel(value: string) {
  return value.replace(/[[\]\\]/g, '\\$&');
}

const sanitizeFileName = sanitizeNodeArtifactFileName;

function artifactDir(runId: string | undefined, kind: 'attachment-previews' | 'document-assets' | 'document-drafts' | 'downloads' | 'generated') {
  return path.join(currentNodeFileWorkspaceHost().artifactsRoot, sanitizeFileName(runId, 'adhoc'), kind);
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

function semanticGenerationPlan(
  operation: 'create' | 'modify',
  generator: OfficeDocumentDraft['generator'],
  design: ReturnType<typeof officeDesignGuidance>,
) {
  const available = operation === 'create' && generator === 'uno';
  const recommended = available && design.mode === 'template';
  return {
    available,
    schemaVersion: '1.0',
    defaultTheme: 'clean',
    defaultLayout: { enabled: true, mode: 'repair', overflow: 'split', imageFit: 'contain' },
    recommended,
    ...(available ? {
      nextAction: recommended ? 'generate' : 'unoApi',
      input: recommended ? 'spec' : 'program',
      note: recommended
        ? 'Semantic generation skips API-catalog authoring; theme tokens may be customized. Fixed geometry is a convenience for conventional files, not a requirement for original design.'
        : 'Bespoke design should use a custom program so the compiler does not replace composition with fixed templates. Query only the API modules needed for the selected direction.',
    } : {
      reason: operation === 'modify'
        ? 'Existing files preserve their original layout through the raw UNO editing workflow.'
        : 'This workspace is configured for JavaScript program authoring.',
    }),
  };
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

function compactAutomaticValidation(payload: ArtifactToolPayload) {
  const validation = payload.automaticValidation;
  if (!validation) return '';
  const issues = Array.isArray(validation.issues)
    ? validation.issues.slice(0, 12).map((issue) => {
        const identity = [issue.severity, issue.code].filter(Boolean).join(':') || 'issue';
        const message = String(issue.message || '').replace(/\s+/g, ' ').trim().slice(0, 220);
        return message ? `${identity}=${message}` : identity;
      })
    : [];
  return [
    `Automatic validation passed=${validation.passed === true}`,
    validation.formatChecks === undefined ? '' : `formatChecks=${JSON.stringify(validation.formatChecks)}`,
    `issues=${issues.length ? issues.join(' | ') : 'none'}`,
  ].filter(Boolean).join('; ');
}

function compactVisualVerification(payload: ArtifactToolPayload) {
  const verification = payload.visualVerification;
  if (!verification) return '';
  return [
    `Visual QA=${verification.gateStatus || verification.status || 'unknown'}`,
    typeof verification.pageCount === 'number' ? `pageCount=${verification.pageCount}` : '',
    typeof verification.imageCount === 'number' ? `imageCount=${verification.imageCount}` : '',
    Array.isArray(verification.renderedPages) ? `renderedPages=${verification.renderedPages.join(',')}` : '',
  ].filter(Boolean).join('; ');
}

function compactOfficeFailure(payload: ArtifactToolPayload) {
  type Diagnostic = NonNullable<ArtifactToolPayload['diagnostics']>[number];
  const groupedDiagnostics = new Map<string, {
    affectedCount: number;
    diagnostic: Diagnostic;
    elementIds: Set<string>;
  }>();
  for (const diagnostic of payload.diagnostics || []) {
    const key = diagnostic.line
      ? JSON.stringify([diagnostic.severity, diagnostic.code, diagnostic.line, diagnostic.column])
      : JSON.stringify([
        diagnostic.severity, diagnostic.code, diagnostic.page, diagnostic.target,
        String(diagnostic.message || '').replace(/Affected runtime elements.*$/i, '').trim(),
      ]);
    const existing = groupedDiagnostics.get(key);
    const elementIds = [
      ...(diagnostic.elementIds || []),
      ...(diagnostic.elementId ? [diagnostic.elementId] : []),
    ];
    if (existing) {
      existing.affectedCount += 1;
      elementIds.forEach((elementId) => existing.elementIds.add(elementId));
    } else {
      groupedDiagnostics.set(key, {
        affectedCount: 1,
        diagnostic,
        elementIds: new Set(elementIds),
      });
    }
  }
  const diagnostics = Array.from(groupedDiagnostics.values())
    .map(({ affectedCount, diagnostic, elementIds }) => {
      const location = diagnostic.line
          ? `@${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ''}`
          : diagnostic.page ? `@page-${diagnostic.page}`
            : diagnostic.target ? `@${diagnostic.target}` : '';
        const identity = [diagnostic.severity, diagnostic.code].filter(Boolean).join(':') || 'issue';
        const rawMessage = String(diagnostic.message || '');
        const terminalMessage = diagnostic.code === 'UNO_RUNTIME_ERROR' || rawMessage.startsWith('Traceback (most recent call last):')
          ? rawMessage.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) || rawMessage
          : rawMessage;
        const message = terminalMessage
          .replace(/Affected runtime elements.*$/i, '')
          .replace(/\s+/g, ' ').trim().slice(0, 260);
        const visibleElementIds = Array.from(elementIds).slice(0, 8);
        const elements = visibleElementIds.length
          ? `[elements=${visibleElementIds.join(',')}${elementIds.size > visibleElementIds.length ? `,+${elementIds.size - visibleElementIds.length}` : ''}]`
          : '';
        const affected = affectedCount > 1 ? `[affected=${affectedCount}]` : '';
        const sourceExcerpt = String(diagnostic.sourceExcerpt || '').trim();
        const source = sourceExcerpt
          ? ` [source=${sourceExcerpt.replace(/\s*\n\s*/g, ' ↵ ').slice(0, 700)}]`
          : '';
        return `${identity}${location}${affected}${elements}${message ? `=${message}` : ''}${source}`;
      });
  const rawError = String(payload.error || 'validation failed');
  const error = rawError.includes('__WEBPILOT_LAYOUT_DIAGNOSTICS__')
    ? `${payload.diagnostics?.length || 0} structured layout diagnostics returned by validation.`
    : (rawError.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) || rawError)
      .replace(/\s+/g, ' ').trim().slice(0, 500);
  const repairHints = Array.isArray(payload.repairHints)
    ? payload.repairHints.slice(0, 6).map((hint) => String(hint).replace(/\s+/g, ' ').trim().slice(0, 360)).filter(Boolean)
    : [];
  return [
    `error=${error}`,
    payload.validationFailureCount ? `validationFailureCount=${payload.validationFailureCount} (repair sequence; mixed causes, not bridge retries)` : '',
    diagnostics.length ? `diagnostics=${diagnostics.join(' | ')}` : '',
    repairHints.length ? `repairHints=${repairHints.join(' | ')}` : '',
    payload.recoverySuggestion ? `recovery=${String(payload.recoverySuggestion).replace(/\s+/g, ' ').trim().slice(0, 500)}` : '',
  ].filter(Boolean).join('; ');
}

export function officeValidationRepairHints(
  diagnostics: Array<Partial<OfficeProgramDiagnostic> & { target?: string }> = [],
  errorText = '',
) {
  const codes = new Set(diagnostics.map((diagnostic) => String(diagnostic.code || '')).filter(Boolean));
  const combinedError = [errorText, ...diagnostics.map((diagnostic) => diagnostic.message || '')].join('\n');
  if (codes.has('UNO_WORKER_INTERNAL_ERROR') || codes.has('UNO_STYLE_PROPERTY_INFO_MISSING') || isUnoWorkerInternalError(combinedError)) {
    return ['The renderer failed internally; preserve the current source. Do not edit the draft, query unoApi, or repeat the same render. Report the runtime error and retry only after the renderer is fixed.'];
  }
  const hints: string[] = [];
  if (codes.has('OFFICE_ARTIFACT_REOPEN_FAILED')) {
    hints.push('The file was saved but LibreOffice could not reopen it. A prior DisposedException does not prove a startup failure. Inspect the exported package, relationships and export compatibility; preserve the draft and do not guess source edits or repeatedly restart. Native editability and render validity remain unverified for this output.');
  }
  if (diagnostics.length > 1) {
    hints.push(`The preflight returned ${diagnostics.length} diagnostics. Put every independent, non-overlapping repair into one Codex-format patch with separate @@ hunks; separate only repairs whose context or dependencies conflict.`);
  }
  if (codes.has('PYTHON_SYNTAX')) {
    hints.push('Read every reported syntax block, then patch each smallest complete Python block. Copy context and indentation byte-for-byte from read; the patcher never adds or removes indentation implicitly. Do not replace the complete source for local syntax errors.');
  }
  if (codes.has('PYTHON_UNDEFINED_NAME')) {
    hints.push('Define the reported name before first use or replace it with the intended existing variable. Repair the exact sourceExcerpt; do not use numbered batch replacement for a local name error.');
  }
  if (codes.has('PYTHON_INDEX_OUT_OF_RANGE')) {
    hints.push('This is a source indexing error, not a UNO bridge startup failure. Compare the data length, loop bounds, and allocated grid/stack cell count. stack(n) returns n cells; grid(columns, rows) returns columns*rows cells. Fix the allocation and dependent geometry together; do not truncate data or suppress the exception.');
  }
  if (codes.has('PRESENTATION_TABLE_CELL_OUT_OF_RANGE')) {
    hints.push('table.set_cell uses zero-based (column, row), while table.merge uses existing A1 addresses. Check both dimensions and preserve the intended data; merging populated cells is a real data/layout change, not a no-op demo.');
  }
  if (codes.has('PRESENTATION_ANIMATION_TARGET_INVALID')) {
    hints.push('animate is supported. Pass the shape object returned by add_shape/select_shape, or an exact selector dictionary; do not pass a bare elementId and do not delete the requested animation.');
  }
  if (codes.has('PRESENTATION_MASTER_SELECTOR_INVALID') || codes.has('PRESENTATION_CUSTOM_SHOW_INDEX_INVALID')) {
    hints.push('Master and custom-show slide indices are one-based, unlike table cell coordinates. Use deck.masters() for exact master selectors and [1] for the first slide in a show. Correct indices without deleting these supported features.');
  }
  if (codes.has('UNO_PYTHON_IMPORT_UNSUPPORTED')) {
    hints.push('Remove the raw UNO import and replace the affected block with a method copied from the corresponding queried facade module. Never substitute enums, structs, constants, or service calls.');
  }
  if (codes.has('MODEL_RAW_UNO_FORBIDDEN')) {
    hints.push('Raw UNO is worker-owned. Keep the current document facade and replace only the reported raw block with a supported call from the already-loaded manifest; preserve-only/unsupported features must not be recreated.');
  }
  if (codes.has('DRAFT_ENTRYPOINT_CALLED_DIRECTLY')) {
    hints.push('Delete the direct create_document(...) call. The LibreOffice worker invokes create_document(job) with the real job object; the draft must only define that function.');
  }
  if (codes.has('PRESENTATION_GEOMETRY_INVALID')) {
    hints.push('Move the reported element into a named slide slot, or repair only its explicit semantic box. Prefer deck.slide(...).add_* with slot=... over hand-calculated coordinates.');
  }
  if (codes.has('PRESENTATION_TEXT_OVERFLOW')) {
    hints.push('Increase the reported text box, shorten its copy, or redesign that local block. Use deck.text_height()/estimate_text_box() or add_text_box/card/footer so pt text is converted to 1/100 mm geometry safely. Do not auto-grow a shared helper without reflowing its dependent layout.');
  }
  if (codes.has('PRESENTATION_TEXT_BOX_TOO_SHORT')) {
    hints.push('The source mixes point font sizes with an undersized 1/100 mm geometry box. Replace the hand-sized height with deck.text_height()/estimate_text_box(), or use add_text_box/card/footer; keep min_font_size readable.');
  }
  if (codes.has('PRESENTATION_OVERLAP')) {
    hints.push('The layout preflight returned the complete overlap set. Repair every independent pair in one patch by reallocating real space: move/resize image and text boxes together, or use a content-specific composition. Do not merely add allow_overlap, relabel content as background/decoration, fade imagery into an unrequested watermark, or shrink important copy to bypass checks. Intentional overlays must belong to the design brief and remain visibly legible in actual QA.');
  }
  if (codes.has('FACADE_METHOD_ON_RAW_UNO_DOCUMENT')) {
    hints.push('Replace the raw document receiver with job.presentation/job.writer/job.spreadsheet and keep every operation on its returned slide, flow-document, or A1 worksheet facade.');
  }
  if (codes.has('FACADE_COMPONENT_ACCESS_UNSUPPORTED')) {
    hints.push('Do not inspect facade internals. Query the corresponding unoApi module and use its installed signatures and examples.');
  }
  if (codes.has('ELEMENT_ID_AUTO_DISAMBIGUATED')) {
    hints.push('The artifact was kept valid by deterministic runtime ID disambiguation. On the next relevant edit, update the shared helper namespace once instead of renaming only the last reported object or rewriting the complete source.');
  }
  if (codes.has('UNO_BRIDGE_DISPOSED')) {
    hints.push('The runtime already retried once with a fresh isolated LibreOffice profile. The disposed LibreOffice process prevented validation from completing and does not by itself identify a source defect.');
  }
  if (codes.has('UNO_BRIDGE_STARTUP')) {
    hints.push('LibreOffice failed before the document source could run. Validation did not produce evidence of a source defect.');
  }
  if (codes.has('RAW_CONNECTOR_SHAPE_UNSTABLE')) {
    hints.push('Replace only the reported raw connector with slide.connect(elementId, sourceBox, targetBox, ...). Keep the existing named slide layout and child IDs.');
  }
  if (codes.has('HELPER_CALL_SIGNATURE_MISMATCH')) {
    hints.push('The local helper definition and its callers disagree. Read the helper symbol and update its signature plus every affected call together; this is not a UNO facade API error.');
  }
  if (codes.has('HELPER_OVERLAP_DEFAULT_ENABLED')) {
    hints.push('Default reusable layout helpers to allow_overlap=False. Pass True only at explicit background, container, or decorative call sites so content overlap remains detectable.');
  }
  if (codes.has('UNO_API_METHOD_UNKNOWN') || codes.has('UNO_API_SIGNATURE_MISMATCH') || codes.has('UNO_API_ARGUMENT_INVALID')) {
    hints.push('The AST preflight rejected a guessed facade method, signature, or nested value. Query the module named by the diagnostic and copy its installed signature and complete registered examples before editing every affected call site together.');
  }
  if (codes.has('UNO_REQUIRED_CAPABILITY_MISSING')) {
    hints.push('Query presentation.shape and copy its specialized-shape example. Add each missing real facade capability with a unique elementId; do not infer semantic coverage from a lookalike, from visual QA, or from another shape type. Revalidate until every explicitly requested capability has a non-zero generated featureCounts entry.');
  }
  if (codes.has('PPTX_ELEMENT_ID_MISSING')) {
    hints.push('A serialized slide object lacks its stable element marker. Recreate only that object through the PresentationSlide facade; raw objects and expert tagging are not model-facing.');
  }
  if (codes.has('PPTX_OBJECT_OUT_OF_BOUNDS')) {
    hints.push('Repair only the reported elementId geometry using deck.bounds(); keep x/y non-negative and x+width/y+height inside those bounds with a small edge margin. Full-slide backgrounds must use bounds["width"] and bounds["height"].');
  }
  if (codes.has('RUNTIME_TEXT_OUT_OF_BOUNDS')) {
    hints.push('Move or resize only the reported text element inside deck.bounds(). The stable facade now keeps text boxes at their requested size, so do not compensate with guessed page dimensions.');
  }
  if (codes.has('RUNTIME_TEXT_OVERLAP')) {
    hints.push('Repair every independent reported text-overlap pair in one patch. Separate or resize only those local blocks; do not change a shared layout helper unless every caller is intentionally reflowed.');
  }
  if (codes.has('RUNTIME_IMAGE_OVERLAP')) {
    hints.push('Move or resize every independently reported image-overlap pair in one patch. If a collage is intentional, compose it as one image asset before placing it.');
  }
  if (codes.has('ELEMENT_MAPPING_NOT_EMBEDDED')) {
    hints.push('The registered element ID was not written onto the serialized artifact object. Tag the actual saved object rather than a wrapper, page collection, or temporary value.');
  }
  if (codes.has('EXPERT_ELEMENTS_NOT_TAGGED')) {
    hints.push('Expert mode is not model-facing. Replace the raw block with a returned facade call or versioned feature recipe.');
  }
  if (/unexpected keyword argument/i.test(errorText) && !/create_document\.<locals>\.[A-Za-z_][A-Za-z0-9_]*\(\)/i.test(errorText)) {
    hints.push('The facade rejected a guessed keyword. Query that facade module and copy its exact installed signature and example.');
  }
  if (/create_document\.<locals>\.([A-Za-z_][A-Za-z0-9_]*)\(\).*unexpected keyword argument/i.test(errorText)) {
    hints.push('A locally defined helper rejected the keyword. Update that helper signature and all of its callers together; querying unoApi will not change a user-defined Python function.');
  }
  if (/Direct job\.(?:new_document|open_document)\(\) is expert-only/i.test(errorText)) {
    hints.push('Use the matching job.writer/job.presentation/job.spreadsheet facade. For existing files, pass source_name directly to that facade; never open a raw document.');
  }
  const missingName = combinedError.match(/NameError:\s*name ['"]([^'"]+)['"] is not defined/i)?.[1];
  if (missingName) {
    hints.push(`Python name ${missingName} is undefined. Read the reported line and replace it with an existing declared identifier or define it before first use; do not batch numbered replacements.`);
  }
  const missingAsset = combinedError.match(/FileNotFoundError:\s*Asset ['"]([^'"]+)['"] is not in this conversation workspace\.\s*Available assets:\s*([^\n]+)/i);
  if (missingAsset) {
    hints.push(`Asset ${missingAsset[1]} is unavailable. Use one exact available asset name: ${missingAsset[2].trim()}. Unique case/download-prefix differences are resolved automatically.`);
  }
  if (/Presentation geometry (?:requires non-negative position and positive size|exceeds slide bounds)/i.test(combinedError)) {
    hints.push('Presentation objects require x/y >= 0, width/height > 0, and their far edge inside deck.bounds(). To remove an object, delete its call instead of replacing it with a zero-size placeholder.');
  }
  return hints;
}

export function formatFileArtifactResult(toolName: string, actual?: string) {
  if (toolName !== 'file') return undefined;
  try {
    const payload = JSON.parse(actual || '{}') as ArtifactToolPayload;
    // Edit receipts and conflicts are a protocol, not a prose success summary.
    // Keep historical partial results readable too; never hide their failed hunks.
    if (payload.editStatus || payload.patchHunks || payload.kind === 'uno-draft-patch-conflict' || payload.kind === 'uno-draft-patch-no-changes') {
      return JSON.stringify({
        kind: payload.kind, code: payload.code, documentId: payload.documentId,
        editStatus: payload.editStatus, changed: payload.changed, saved: payload.saved,
        sourceUnitPath: payload.sourceUnitPath, patchBaseDigest: payload.patchBaseDigest,
        expectedBaseDigest: payload.expectedBaseDigest, suppliedBaseDigest: payload.suppliedBaseDigest,
        patchHunks: payload.patchHunks, validation: payload.validation || payload.validationStatus,
        validationEvidence: payload.validationEvidence, sourceRepairRequired: payload.sourceRepairRequired,
        sourceValidity: payload.sourceValidity, retryable: payload.retryable, retryAfter: payload.retryAfter,
        diagnostics: payload.diagnostics, repairHints: payload.repairHints,
        // Diagnostics already contain the actionable errors. Repeating the
        // same exception as error + workflow.error can exceed the realtime
        // limit, break its JSON and hide the saved/validation distinction.
        // The original full result remains in the trace/detail endpoint.
        workflow: payload.workflow ? { ...payload.workflow, error: undefined } : undefined,
        message: payload.message, error: payload.diagnostics?.length ? undefined : payload.error,
        recoverySuggestion: payload.recoverySuggestion,
        nextAction: payload.nextAction,
      });
    }
    if (payload.kind === 'document-plan') {
      const assets = Array.isArray((payload as Record<string, unknown>).availableAssets)
        ? ((payload as Record<string, unknown>).availableAssets as Array<Record<string, unknown>>)
          .map((asset) => typeof asset.assetName === 'string' ? asset.assetName : '')
          .filter(Boolean)
        : [];
      // Routing and design decisions must survive the model-facing compaction.
      // Do not turn this back into an identity-only string or include the draft source.
      return JSON.stringify({
        kind: payload.kind, documentId: payload.documentId, fileName: payload.fileName,
        documentType: payload.documentType, operation: payload.operation || 'create',
        generator: payload.generator || 'uno', sourceCharacters: payload.sourceCharacters || 0,
        sourceFileName: payload.sourceFileName, sourceDocument: payload.sourceDocument,
        semanticGeneration: payload.semanticGeneration, design: payload.design,
        designGuidance: payload.designGuidance, workflow: payload.workflow,
        reused: payload.reused, instruction: payload.instruction, availableAssets: assets,
      });
    }
    if (payload.kind === 'uno-program' || payload.kind === 'office-program') {
      return `Office source updated: ${payload.fileName || 'artifact'}; Document ID: ${payload.documentId}; generator=${payload.generator || 'uno'}; sourceCharacters=${payload.sourceCharacters || 0}`;
    }
    if (payload.kind === 'uno-draft-validation') {
      if (payload.validation === 'failed' || payload.validationStatus === 'failed') {
        return `Office source validation failed: ${payload.fileName || 'artifact'}; Document ID: ${payload.documentId}; workingSourceSaved=${payload.saved === true}; ${compactOfficeFailure(payload)}`;
      }
      return [
        `Office source validated: ${payload.fileName || 'artifact'}; Document ID: ${payload.documentId}; sourceCharacters=${payload.sourceCharacters || 0}; cacheHit=${payload.cacheHit === true}`,
        compactAutomaticValidation(payload),
      ].filter(Boolean).join('; ');
    }
    if (payload.kind === 'office-source-unit-validation' && payload.validation === 'failed') {
      return `Office source-unit validation failed: Document ID: ${payload.documentId}; workingSourceSaved=${payload.saved === true}; ${compactOfficeFailure(payload)}`;
    }
    if (payload.kind === 'office-source-unit-validation' && payload.validation === 'passed') {
      return [
        `Office source unit validated: Document ID: ${payload.documentId}; sourceUnitPath=${String((payload as Record<string, unknown>).sourceUnitPath || '')}`,
        compactAutomaticValidation(payload),
      ].filter(Boolean).join('; ');
    }
    if (payload.kind !== 'download' && payload.kind !== 'generated') return undefined;
    const label = payload.kind === 'download'
      ? 'File downloaded'
      : 'File generated';
    const fileName = payload.fileName || 'artifact';
    const target = payload.downloadUrl || payload.url || payload.path || '';
    const targetLine = target
      ? `Download: [${escapeMarkdownLinkLabel(fileName)}](${target})`
      : `Path: ${payload.path || fileName}`;
    return [
      `${label}: ${fileName}`,
      payload.artifactId ? `Artifact ID: ${payload.artifactId}` : '',
      targetLine,
      payload.url && payload.url !== target ? `Open: ${payload.url}` : '',
      typeof payload.bytes === 'number' ? `size=${payload.bytes} bytes` : '',
      payload.kind === 'download' && /\.(?:png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(fileName)
        ? `Asset identity is NOT verified by its filename or a successful download. Before placing it, call readContent with artifactId=${payload.artifactId}, includeVisuals=true, and inspect the pixels. Verify subject/brand and aspect ratio; never label a generic or unrelated image as the requested product.`
        : payload.kind === 'download' && /\.pdf$/i.test(fileName)
          ? `Document text has not been read. Use readContent with artifactId=${payload.artifactId} for extracted evidence; do not decode PDF bytes as source text.`
          : '',
      compactAutomaticValidation(payload),
      compactVisualVerification(payload),
    ].filter(Boolean).join('; ');
  } catch {
    return actual;
  }
}

function draftPath(runId: string | undefined, documentId: string) {
  return path.join(artifactDir(runId, 'document-drafts'), `${sanitizeFileName(documentId, 'document')}.json`);
}

function draftProgramPath(runId: string | undefined, documentId: string, generator: OfficeDocumentDraft['generator'] = 'uno') {
  return path.join(
    artifactDir(runId, 'document-drafts'),
    `${sanitizeFileName(documentId, 'document')}${generator === 'javascript' ? '.mjs' : '.py'}`,
  );
}

function draftTransactionPath(runId: string | undefined, documentId: string) {
  return path.join(artifactDir(runId, 'document-drafts'), `${sanitizeFileName(documentId, 'document')}.transaction.json`);
}

function draftLockPath(runId: string | undefined, documentId: string) {
  return path.join(artifactDir(runId, 'document-drafts'), `${sanitizeFileName(documentId, 'document')}.lock`);
}

function requireDocumentId(value: string | undefined, action: 'readSource' | 'generate' | 'edit' | 'render') {
  const documentId = String(value || '').trim();
  if (!DOCUMENT_ID_PATTERN.test(documentId)) {
    throw new Error(`file action=${action} requires the stable documentId returned by action=plan.`);
  }
  return documentId;
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

async function acquireFilesystemDraftLock(runId: string | undefined, documentId: string, abortSignal?: AbortSignal) {
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

/** Serializes a draft's lifecycle both locally and across server processes. */
async function withDraftLock<T>(runId: string | undefined, documentId: string, operation: () => Promise<T>, abortSignal?: AbortSignal) {
  const key = `${sanitizeFileName(runId, 'adhoc')}::${documentId}`;
  const previous = draftLocks.get(key) || Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  draftLocks.set(key, tail);
  let releaseFilesystemLock: (() => Promise<void>) | undefined;
  try {
    await raceWithAbort(previous, abortSignal);
    releaseFilesystemLock = await acquireFilesystemDraftLock(runId, documentId, abortSignal);
    return await operation();
  } finally {
    await releaseFilesystemLock?.();
    release?.();
    if (draftLocks.get(key) === tail) draftLocks.delete(key);
  }
}

async function writeDraftJsonAtomically(target: string, draft: OfficeDocumentDraft) {
  const candidate = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(candidate, JSON.stringify(draft, null, 2), { encoding: 'utf8', flag: 'wx' });
    await rename(candidate, target);
  } finally {
    await unlink(candidate).catch(() => undefined);
  }
}

/** Complete or discard a crash-interrupted two-file workspace save deterministically. */
async function recoverDraftTransaction(runId: string | undefined, documentId: string) {
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

async function loadDraft(runId: string | undefined, documentId: string) {
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

async function writeDraftWorkspace(runId: string | undefined, draft: OfficeDocumentDraft) {
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

async function saveDraft(runId: string | undefined, draft: OfficeDocumentDraft) {
  const dir = artifactDir(runId, 'document-drafts');
  await mkdir(dir, { recursive: true });
  draft.updatedAt = new Date().toISOString();
  draft.sourceDigest = draft.program ? sourceDigest(draft.program) : undefined;
  if (draft.program) synchronizeSourceUnits(draft);
  await writeDraftWorkspace(runId, draft);
}

/** Save the one editable source buffer after a failed validation. */
async function saveWorkingDraft(runId: string | undefined, draft: OfficeDocumentDraft) {
  draft.updatedAt = new Date().toISOString();
  draft.sourceDigest = draft.program ? sourceDigest(draft.program) : undefined;
  await writeDraftWorkspace(runId, draft);
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

function sourceDigest(source: string) {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

function normalizedDraftSource(source: string) {
  return source.replace(/\r\n?/g, '\n');
}

type ParsedSourceUnit = {
  content: string;
  endLine: number;
  inferred?: boolean;
  kind?: 'explicit' | 'page' | 'sheet' | 'symbol';
  path: string;
  startLine: number;
  symbolName?: string;
};

// Office generators often contain dense Python statements. Large source
// windows can consume tens of thousands of model tokens and trigger a loop in
// which context compaction discards the source before the edit is submitted.
// Keep reads small and stream repairs as one bounded read followed by one edit.
const LARGE_SOURCE_LINE_THRESHOLD = 120;
const MAX_SOURCE_READ_LINES = 80;
const SOURCE_UNIT_START = /^\s*(?:#|\/\/)\s*@webpilot-unit\s+([A-Za-z0-9][A-Za-z0-9._/-]{0,159})\s*$/;
const SOURCE_UNIT_END = /^\s*(?:#|\/\/)\s*@webpilot-endunit\s*$/;

function normalizedSourceUnitPath(value: string | undefined) {
  const unitPath = String(value || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!unitPath || unitPath.includes('..') || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(unitPath)) {
    throw new Error('Office source unit path must be a relative path using letters, numbers, dot, underscore, slash, or hyphen.');
  }
  return unitPath;
}

function sourceUnitForRequestedPath(units: ParsedSourceUnit[], requestedPath: string | undefined) {
  if (!requestedPath) return undefined;
  return units.find((unit) => unit.path === requestedPath);
}

function parseSourceUnits(source: string): ParsedSourceUnit[] {
  const lines = normalizedDraftSource(source).split('\n');
  const units: ParsedSourceUnit[] = [];
  const names = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const match = SOURCE_UNIT_START.exec(lines[index]);
    if (!match) continue;
    const unitPath = normalizedSourceUnitPath(match[1]);
    if (names.has(unitPath)) throw new Error(`Duplicate Office source unit path: ${unitPath}.`);
    const endMarker = lines.findIndex((line, candidate) => candidate > index && SOURCE_UNIT_END.test(line));
    if (endMarker < 0) throw new Error(`Office source unit ${unitPath} is missing @webpilot-endunit.`);
    const nested = lines.slice(index + 1, endMarker).find((line) => SOURCE_UNIT_START.test(line));
    if (nested) throw new Error(`Office source unit ${unitPath} contains a nested unit marker.`);
    units.push({ path: unitPath, startLine: index + 2, endLine: endMarker, content: lines.slice(index + 1, endMarker).join('\n'), kind: 'explicit' });
    names.add(unitPath);
    index = endMarker;
  }
  return units;
}

function inferredUnitSegment(value: string, fallback: string) {
  const normalized = value.trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return (normalized || fallback).slice(0, 100);
}

function inferredPythonSymbolSourceUnits(source: string): ParsedSourceUnit[] {
  const lines = normalizedDraftSource(source).split('\n');
  const candidates = lines.flatMap((line, index) => {
    const match = /^(\s*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
    return match ? [{ index, indent: match[1].length, name: match[2] }] : [];
  }).map((candidate) => {
    let endIndex = lines.length - 1;
    for (let index = candidate.index + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const indent = line.match(/^\s*/)?.[0].length || 0;
      if (indent <= candidate.indent) {
        endIndex = index - 1;
        break;
      }
    }
    while (endIndex > candidate.index && !lines[endIndex].trim()) endIndex -= 1;
    return { ...candidate, endIndex };
  });
  const reusable = candidates.filter((candidate) => candidate.name !== 'create_document' && !candidates.some((parent) => (
    parent !== candidate
    && parent.name !== 'create_document'
    && parent.index < candidate.index
    && parent.endIndex >= candidate.endIndex
  )));
  const names = new Set<string>();
  return reusable.map((candidate) => {
    const baseName = inferredUnitSegment(candidate.name, `function-line-${candidate.index + 1}`);
    let unitName = baseName;
    let suffix = 2;
    while (names.has(unitName)) unitName = `${baseName}-${suffix++}`;
    names.add(unitName);
    return {
      content: lines.slice(candidate.index, candidate.endIndex + 1).join('\n'),
      endLine: candidate.endIndex + 1,
      inferred: true,
      kind: 'symbol' as const,
      path: `symbols/${unitName}`,
      startLine: candidate.index + 1,
      symbolName: candidate.name,
    };
  });
}

function pythonCallEndIndex(lines: string[], startIndex: number) {
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = startIndex; index < lines.length; index += 1) {
    for (const character of lines[index]) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (quote) {
        if (character === quote) quote = '';
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === '(') depth += 1;
      else if (character === ')') depth -= 1;
    }
    if (depth <= 0) return index;
  }
  return startIndex;
}

function inferredPythonSlideFactoryCallUnits(source: string, symbols: ParsedSourceUnit[]) {
  const lines = normalizedDraftSource(source).split('\n');
  const factories = symbols.filter((symbol) => symbol.symbolName && /\.add_slide\s*\(/.test(symbol.content));
  const starts = factories.flatMap((factory) => {
    const escaped = factory.symbolName!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^\\s*${escaped}\\s*\\(`);
    return lines.flatMap((line, index) => {
      const insideSymbol = symbols.some((symbol) => index + 1 >= symbol.startLine && index + 1 <= symbol.endLine);
      return !insideSymbol && pattern.test(line) ? [{ factory, index }] : [];
    });
  }).sort((left, right) => left.index - right.index);
  const names = new Set<string>();
  return starts.map(({ factory, index }) => {
    const endIndex = pythonCallEndIndex(lines, index);
    const call = lines.slice(index, endIndex + 1).join('\n');
    const firstArgument = new RegExp(`^\\s*${factory.symbolName}\\s*\\(\\s*(?:(\\d+)|['\"]([^'\"]+)['\"])`).exec(call);
    const numeric = firstArgument?.[1];
    const authored = firstArgument?.[2];
    const authoredNumeric = authored?.match(/^slide[-_/]?(\d+)$/i)?.[1];
    const baseName = numeric || authoredNumeric
      ? `slide-${String(Number(numeric || authoredNumeric)).padStart(3, '0')}`
      : authored
        ? inferredUnitSegment(authored, `${factory.symbolName}-call-line-${index + 1}`)
        : `${inferredUnitSegment(factory.symbolName || 'slide-factory', 'slide-factory')}-call-line-${index + 1}`;
    let unitName = baseName;
    let suffix = 2;
    while (names.has(unitName)) unitName = `${baseName}-${suffix++}`;
    names.add(unitName);
    return {
      content: call,
      endLine: endIndex + 1,
      inferred: true,
      kind: 'page' as const,
      path: `pages/${unitName}`,
      startLine: index + 1,
    };
  });
}

function uniqueInferredSourceUnitPaths(units: ParsedSourceUnit[]) {
  const paths = new Set<string>();
  return units.map((unit) => {
    if (!paths.has(unit.path)) {
      paths.add(unit.path);
      return unit;
    }
    let suffix = 2;
    let path = `${unit.path}-${suffix}`;
    while (paths.has(path)) path = `${unit.path}-${++suffix}`;
    paths.add(path);
    return { ...unit, path };
  });
}

function inferredPresentationSourceUnits(
  source: string,
  generator: OfficeDocumentDraft['generator'],
  symbols: ParsedSourceUnit[] = [],
  additionalBoundaries: ParsedSourceUnit[] = [],
): ParsedSourceUnit[] {
  const lines = normalizedDraftSource(source).split('\n');
  const slidePattern = generator === 'javascript'
    ? /^(\s*)(?:(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.addSlide\s*\(/
    : /^(\s*)(?:[A-Za-z_][A-Za-z0-9_]*\s*=\s*)?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\.(?:add_slide|slide)\s*\(/;
  const starts = lines.flatMap((line, index) => {
    const match = slidePattern.exec(line);
    const insideSymbol = symbols.some((symbol) => index + 1 >= symbol.startLine && index + 1 <= symbol.endLine);
    return match && !insideSymbol ? [{ index, indent: match[1].length, line }] : [];
  });
  if (!starts.length) return [];
  const names = new Set<string>();
  return starts.map((start, index) => {
    const nextStart = [
      starts[index + 1]?.index,
      ...symbols.filter((symbol) => symbol.startLine - 1 > start.index).map((symbol) => symbol.startLine - 1),
      ...additionalBoundaries.filter((unit) => unit.startLine - 1 > start.index).map((unit) => unit.startLine - 1),
    ].filter((value): value is number => value !== undefined).sort((left, right) => left - right)[0];
    let endIndex = nextStart === undefined ? lines.length - 1 : nextStart - 1;
    if (nextStart === undefined) {
      const terminal = lines.findIndex((line, candidate) => (
        candidate > start.index
        && (line.match(/^\s*/)?.[0].length || 0) <= start.indent
        && /\.(?:save|close)\s*\(/.test(line)
      ));
      if (terminal > start.index) endIndex = terminal - 1;
    }
    while (endIndex > start.index && !lines[endIndex].trim()) endIndex -= 1;
    const authoredId = /\.(?:add_slide|addSlide|slide)\s*\(\s*['"]([^'"]+)['"]/.exec(start.line)?.[1];
    const numericId = authoredId?.match(/^slide[-_/]?(\d+)$/i)?.[1];
    const baseName = numericId
      ? `slide-${String(Number(numericId)).padStart(3, '0')}`
      : authoredId
        ? inferredUnitSegment(authoredId, `slide-call-line-${start.index + 1}`)
        : `slide-call-line-${start.index + 1}`;
    let unitName = baseName;
    let suffix = 2;
    while (names.has(unitName)) unitName = `${baseName}-${suffix++}`;
    names.add(unitName);
    return {
      content: lines.slice(start.index, endIndex + 1).join('\n'),
      endLine: endIndex + 1,
      inferred: true,
      kind: 'page' as const,
      path: `pages/${unitName}`,
      startLine: start.index + 1,
    };
  });
}

function inferredWriterSourceUnits(source: string): ParsedSourceUnit[] {
  const lines = normalizedDraftSource(source).split('\n');
  const writerAssignment = lines.flatMap((line, index) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*job\.writer\s*\(/.exec(line);
    return match ? [{ index, variable: match[1] }] : [];
  }).at(-1);
  if (!writerAssignment) return [];
  const escaped = writerAssignment.variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const contentPattern = new RegExp(`^\\s*${escaped}\\.(?:add_heading|add_inline_image|add_page_break|add_paragraph|add_table)\\s*\\(`);
  const firstContent = lines.findIndex((line, index) => index > writerAssignment.index && contentPattern.test(line));
  if (firstContent < 0) return [];
  const pageBreakPattern = new RegExp(`^\\s*${escaped}\\.add_page_break\\s*\\(`);
  const starts = [firstContent, ...lines.flatMap((line, index) => (
    index > firstContent && pageBreakPattern.test(line) ? [index] : []
  ))];
  if (starts.length < 2) return [];
  return starts.map((start, index) => {
    const nextStart = starts[index + 1];
    let endIndex = nextStart === undefined ? lines.length - 1 : nextStart - 1;
    if (nextStart === undefined) {
      const terminal = lines.findIndex((line, candidate) => (
        candidate > start && new RegExp(`^\\s*${escaped}\\.(?:save|close)\\s*\\(`).test(line)
      ));
      if (terminal > start) endIndex = terminal - 1;
    }
    while (endIndex > start && !lines[endIndex].trim()) endIndex -= 1;
    return {
      content: lines.slice(start, endIndex + 1).join('\n'),
      endLine: endIndex + 1,
      inferred: true,
      kind: 'page' as const,
      path: `pages/page-${String(index + 1).padStart(3, '0')}`,
      startLine: start + 1,
    };
  });
}

function inferredCalcSourceUnits(source: string): ParsedSourceUnit[] {
  const lines = normalizedDraftSource(source).split('\n');
  const declarations = lines.flatMap((line, index) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*[A-Za-z_][A-Za-z0-9_]*\.add_worksheet\s*\(/.exec(line);
    return match ? [{ index, variable: match[1] }] : [];
  });
  if (declarations.length < 2) return [];
  const lastDeclaration = declarations.at(-1)!.index;
  const starts = declarations.flatMap((declaration, declarationIndex) => {
    const escaped = declaration.variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const usePattern = new RegExp(`\\b${escaped}\\b`);
    const index = lines.findIndex((line, candidate) => (
      candidate > lastDeclaration && !/^\s*#/.test(line) && usePattern.test(line)
    ));
    return index < 0 ? [] : [{ declarationIndex, index }];
  }).sort((left, right) => left.index - right.index);
  if (starts.length < 2 || new Set(starts.map((start) => start.index)).size !== starts.length) return [];
  return starts.map((start, index) => {
    const nextStart = starts[index + 1]?.index;
    let endIndex = nextStart === undefined ? lines.length - 1 : nextStart - 1;
    if (nextStart === undefined) {
      const terminal = lines.findIndex((line, candidate) => (
        candidate > start.index && /^\s*[A-Za-z_][A-Za-z0-9_]*\.(?:save|close)\s*\(/.test(line)
      ));
      if (terminal > start.index) endIndex = terminal - 1;
    }
    while (endIndex > start.index && !lines[endIndex].trim()) endIndex -= 1;
    return {
      content: lines.slice(start.index, endIndex + 1).join('\n'),
      endLine: endIndex + 1,
      inferred: true,
      kind: 'sheet' as const,
      path: `sheets/sheet-${String(start.declarationIndex + 1).padStart(3, '0')}`,
      startLine: start.index + 1,
    };
  });
}

export function sourceUnitsForDraft(source: string, draft: Pick<OfficeDocumentDraft, 'documentType' | 'generator'>) {
  const explicit = parseSourceUnits(source);
  if (explicit.length) return explicit;
  if (draft.documentType === 'presentation') {
    const symbols = draft.generator === 'uno' ? inferredPythonSymbolSourceUnits(source) : [];
    const factoryCalls = draft.generator === 'uno' ? inferredPythonSlideFactoryCallUnits(source, symbols) : [];
    return uniqueInferredSourceUnitPaths([
      ...symbols,
      ...factoryCalls,
      ...inferredPresentationSourceUnits(source, draft.generator, symbols, factoryCalls),
    ].sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine));
  }
  if (draft.generator !== 'uno') return [];
  if (draft.documentType === 'word') return inferredWriterSourceUnits(source);
  if (draft.documentType === 'spreadsheet') return inferredCalcSourceUnits(source);
  return [];
}

function replaceSourceUnit(source: string, unit: ParsedSourceUnit, content: string) {
  const lines = normalizedDraftSource(source).split('\n');
  lines.splice(unit.startLine - 1, Math.max(0, unit.endLine - unit.startLine + 1), ...normalizedDraftSource(content).split('\n'));
  return lines.join('\n');
}

function isolateSourceUnit(
  source: string,
  requestedPath: string,
  generator: OfficeDocumentDraft['generator'],
  units: ParsedSourceUnit[],
) {
  const lines = normalizedDraftSource(source).split('\n');
  for (const unit of [...units].reverse()) {
    if (unit.path === requestedPath || unit.kind === 'symbol') continue;
    const current = lines.slice(unit.startLine - 1, unit.endLine);
    const contentIndent = current.find((line) => line.trim())?.match(/^\s*/)?.[0];
    const markerIndent = lines[unit.startLine - 2]?.match(/^\s*/)?.[0] || '';
    const indent = contentIndent ?? `${markerIndent}${generator === 'javascript' ? '  ' : '    '}`;
    const replacement = generator === 'javascript' ? `${indent}// unchanged source unit skipped during isolated validation` : `${indent}pass`;
    lines.splice(unit.startLine - 1, Math.max(0, unit.endLine - unit.startLine + 1), replacement);
  }
  return lines.join('\n');
}

function synchronizeSourceUnits(draft: OfficeDocumentDraft, validation?: 'failed' | 'passed') {
  const previous = new Map((draft.sourceUnits || []).map((unit) => [unit.path, unit]));
  const units = sourceUnitsForDraft(draft.program || '', draft);
  draft.sourceUnits = units.map((unit) => {
    const digest = sourceDigest(unit.content);
    const prior = previous.get(unit.path);
    const alreadyValidated = prior?.validatedDigest === digest;
    return {
      path: unit.path,
      sourceDigest: digest,
      validatedDigest: validation === 'passed' ? digest : alreadyValidated ? digest : undefined,
      status: validation === 'passed' || alreadyValidated
        ? 'passed' as const
        : validation === 'failed' || (prior?.sourceDigest === digest && prior.status === 'failed')
          ? 'failed' as const
          : 'pending' as const,
    };
  });
}

function draftSourceLineCount(source: string) {
  const normalized = normalizedDraftSource(source);
  return (normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized).split('\n').length;
}

// TypeScript port of OpenAI Codex's Apache-2.0 apply-patch algorithm:
// codex-rs/apply-patch/src/{parser,seek_sequence,file_update}.rs. The Office
// tool retains the grammar, but requires unique exact matches on one snapshot.
type CodexDraftPatchChunk = {
  changeContext?: string;
  contextLineIndices: Array<[number, number]>;
  isEndOfFile: boolean;
  newLines: string[];
  oldLines: string[];
};

function emptyCodexDraftPatchChunk(changeContext?: string): CodexDraftPatchChunk {
  return { changeContext, contextLineIndices: [], isEndOfFile: false, newLines: [], oldLines: [] };
}

/** Port of Codex apply-patch's file-oriented grammar for one staged draft.py. */
function parseCodexDraftPatch(patchText: string) {
  const lines = normalizedDraftSource(String(patchText || '')).trim().split('\n');
  if (lines[0]?.trim() !== '*** Begin Patch') {
    throw new Error("The first line of the patch must be '*** Begin Patch'.");
  }
  if (lines.at(-1)?.trim() !== '*** End Patch') {
    throw new Error("The last line of the patch must be '*** End Patch'.");
  }
  const updates: CodexDraftPatchChunk[][] = [];
  let chunks: CodexDraftPatchChunk[] | undefined;
  const currentChunk = () => {
    if (!chunks) throw new Error("Expected an '*** Update File: draft.py' header before patch lines.");
    if (!chunks.length) chunks.push(emptyCodexDraftPatchChunk());
    return chunks[chunks.length - 1];
  };

  for (let index = 1; index < lines.length - 1; index += 1) {
    const line = lines[index].replace(/\r$/, '');
    const updatePath = line.startsWith('*** Update File: ')
      ? line.slice('*** Update File: '.length).trim().replace(/^\.\//, '')
      : undefined;
    if (updatePath !== undefined) {
      if (updatePath !== 'draft.py') throw new Error("Codex patch may update only the staged file named 'draft.py'.");
      chunks = [];
      updates.push(chunks);
      continue;
    }
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Move to: ')) {
      throw new Error("Office draft patches may only use '*** Update File: draft.py'.");
    }
    if (line === '@@') {
      if (!chunks) throw new Error("Expected an '*** Update File: draft.py' header before '@@'.");
      chunks.push(emptyCodexDraftPatchChunk());
      continue;
    }
    if (line.startsWith('@@ ')) {
      if (!chunks) throw new Error("Expected an '*** Update File: draft.py' header before '@@'.");
      chunks.push(emptyCodexDraftPatchChunk(line.slice(3)));
      continue;
    }
    if (line === '*** End of File') {
      currentChunk().isEndOfFile = true;
      continue;
    }
    const chunk = currentChunk();
    if (chunk.isEndOfFile && line === '') continue;
    if (chunk.isEndOfFile) throw new Error("Expected a new '@@' context marker after '*** End of File'.");
    if (line === '') {
      chunk.contextLineIndices.push([chunk.oldLines.length, chunk.newLines.length]);
      chunk.oldLines.push('');
      chunk.newLines.push('');
      continue;
    }
    const marker = line[0];
    const content = line.slice(1);
    if (marker === ' ') {
      chunk.contextLineIndices.push([chunk.oldLines.length, chunk.newLines.length]);
      chunk.oldLines.push(content);
      chunk.newLines.push(content);
    } else if (marker === '+') chunk.newLines.push(content);
    else if (marker === '-') chunk.oldLines.push(content);
    else if (line.startsWith('*** ') || line.startsWith('@@')) {
      throw new Error(`Unexpected patch control line ${index + 1}. Use one Codex-format Update File section with @@ hunks.`);
    } else {
      // Models occasionally omit the one-character context marker while
      // preserving the exact source line. Inside a hunk, an otherwise bare
      // non-control line is unambiguously unchanged context, so normalize it
      // instead of failing the entire edit and encouraging a full rewrite.
      chunk.contextLineIndices.push([chunk.oldLines.length, chunk.newLines.length]);
      chunk.oldLines.push(line);
      chunk.newLines.push(line);
    }
  }
  if (!updates.length) throw new Error("Patch requires at least one '*** Update File: draft.py' section.");
  if (updates.some((update) => !update.length)) throw new Error("Update patch for 'draft.py' is empty.");
  const allChunks = updates.flat();
  if (!allChunks.length || allChunks.some((chunk) => !chunk.oldLines.length && !chunk.newLines.length)) {
    throw new Error('Update patch contains an empty hunk.');
  }
  if (allChunks.length > 100) throw new Error('Office draft patch is limited to 100 atomic hunks.');
  return updates;
}

function codexDraftPatchChunkHasChange(chunk: CodexDraftPatchChunk) {
  return chunk.oldLines.length !== chunk.newLines.length
    || chunk.oldLines.some((line, index) => line !== chunk.newLines[index]);
}

/** Whitespace and punctuation are source, not normalization opportunities. */
function seekCodexPatchSequence(lines: string[], pattern: string[], start: number, eof: boolean, end = lines.length) {
  if (!pattern.length) return start;
  const upper = end - pattern.length;
  const searchStart = eof ? Math.max(start, lines.length - pattern.length) : start;
  let found: number | undefined;
  for (let index = searchStart; index <= upper; index += 1) {
    if (pattern.every((line, offset) => lines[index + offset] === line)) {
      if (found !== undefined) {
        throw new Error(`PATCH_TARGET_AMBIGUOUS: exact matches on lines ${found + 1} and ${index + 1}. Include more unchanged context or use a readSource source-unit path. Nothing was saved.`);
      }
      found = index;
    }
  }
  return found;
}

type CodexDraftReplacement = [start: number, oldLength: number, newLines: string[]];

function codexDraftPatchReplacements(originalLines: string[], chunks: CodexDraftPatchChunk[]) {
  const replacements: CodexDraftReplacement[] = [];
  for (const chunk of chunks) {
    let lineIndex = 0;
    let scopeEnd = originalLines.length;
    if (chunk.changeContext !== undefined) {
      const contextIndex = seekCodexPatchSequence(originalLines, [chunk.changeContext], lineIndex, false);
      if (contextIndex === undefined) throw new Error(`Failed to find patch context '${chunk.changeContext}' in draft.py.`);
      lineIndex = contextIndex + 1;
      // A Python function/class anchor cannot drift into a later declaration.
      if (/^\s*(?:async\s+def|def|class)\s/.test(chunk.changeContext)) {
        const indent = chunk.changeContext.match(/^[\t ]*/)?.[0].length || 0;
        for (let index = lineIndex; index < originalLines.length; index += 1) {
          const line = originalLines[index];
          if (line.trim() && !line.trimStart().startsWith('#') && (line.match(/^[\t ]*/)?.[0].length || 0) <= indent) {
            scopeEnd = index;
            break;
          }
        }
      }
    }
    if (!chunk.oldLines.length) {
      if (chunk.changeContext !== undefined) {
        throw new Error('PATCH_INSERTION_ANCHOR_REQUIRED: include the exact anchor as an unchanged hunk line for an insertion. A context-free insertion only appends at EOF.');
      }
      replacements.push([originalLines.length, 0, [...chunk.newLines]]);
      continue;
    }
    let pattern = chunk.oldLines;
    let newLines = chunk.newLines;
    let startIndex = seekCodexPatchSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile, scopeEnd);
    if (startIndex === undefined && pattern.length > 1 && pattern.at(-1) === '') {
      pattern = pattern.slice(0, -1);
      if (newLines.at(-1) === '') newLines = newLines.slice(0, -1);
      // An EOF newline is not an extra blank source line. Never drop a blank in the middle.
      startIndex = seekCodexPatchSequence(originalLines, pattern, lineIndex, true, scopeEnd);
    }
    if (startIndex === undefined) {
      throw new Error('PATCH_TARGET_NOT_FOUND: copy the exact current program, including indentation and punctuation. No fuzzy match or already-applied guess was used.');
    }

    // Leave unchanged context in place so neighboring hunks may share context.
    let oldStart = 0;
    let newStart = 0;
    for (const [oldContext, newContext] of chunk.contextLineIndices) {
      if (oldContext >= pattern.length || newContext >= newLines.length) break;
      if (oldStart !== oldContext || newStart !== newContext) {
        replacements.push([
          startIndex + oldStart,
          oldContext - oldStart,
          newLines.slice(newStart, newContext),
        ]);
      }
      oldStart = oldContext + 1;
      newStart = newContext + 1;
    }
    if (oldStart !== pattern.length || newStart !== newLines.length) {
      replacements.push([startIndex + oldStart, pattern.length - oldStart, newLines.slice(newStart)]);
    }
  }
  return replacements.sort((left, right) => left[0] - right[0]);
}

/** Strict atomic wrapper, also used by direct callers. */
export function applyUnoDraftPatch(source: string, patchText: string) {
  const result = applyUnoDraftPatchHunks(source, patchText);
  if (result.failedHunks.length) throw new Error(result.failedHunks.map((failure) => `hunk ${failure.hunk}: ${failure.error}`).join('\n'));
  return result.source;
}

export type UnoDraftPatchHunkFailure = {
  hunk: number;
  error: string;
  sourceContext?: { startLine: number; endLine: number; lineNumberBasis: string; content: string };
};

/** Diagnostic only: a unique unchanged line can locate a small recovery window,
 * but it must never authorize an approximate source replacement. */
function replacementConflictSourceContext(source: string, oldText: string) {
  const lines = source.split('\n');
  const requested = oldText.split('\n');
  for (const [offset, line] of requested.entries()) {
    const anchor = line.trim();
    if (anchor.length < 16) continue;
    const matches = lines.flatMap((candidate, index) => candidate.trim() === anchor ? [index] : []);
    if (matches.length !== 1) continue;
    const start = Math.max(0, matches[0] - Math.min(offset, 4));
    const window: string[] = [];
    for (const candidate of lines.slice(start, start + 12)) {
      if (window.join('\n').length + candidate.length > 1800) break;
      window.push(candidate);
    }
    if (!window.length) return undefined;
    return { startLine: start + 1, endLine: start + window.length,
      lineNumberBasis: '1-based within the requested source unit, or the full draft when no path was supplied',
      content: window.join('\n') };
  }
  return undefined;
}

export type UnoDraftPatchResult = {
  source: string;
  appliedHunks: number;
  alreadyAppliedHunks: number;
  failedHunks: UnoDraftPatchHunkFailure[];
  ignoredHunks: number;
  totalHunks: number;
  blockedHunks: number[];
};

function sourceEditRangesOverlap(a: { start: number; end: number }, b: { start: number; end: number }) {
  // Insertions on a replacement boundary have ambiguous ordering; require one combined edit.
  if (a.start === a.end) return a.start >= b.start && a.start <= b.end;
  if (b.start === b.end) return b.start >= a.start && b.start <= a.end;
  return a.start < b.end && b.start < a.end;
}

/** Locate ALL hunks on the original snapshot, then commit ALL or NONE. */
export function applyUnoDraftPatchHunks(source: string, patchText: string): UnoDraftPatchResult {
  const normalized = normalizedDraftSource(source);
  const hasFinalNewline = normalized.endsWith('\n');
  const lines = normalized ? (hasFinalNewline ? normalized.slice(0, -1) : normalized).split('\n') : [];
  const candidates: Array<{ start: number; end: number; newLines: string[]; hunk: number }> = [];
  const failedHunks: UnoDraftPatchHunkFailure[] = [];
  const parsedChunks = parseCodexDraftPatch(patchText).flat();
  const changedChunks = parsedChunks
    .map((chunk, index) => ({ chunk, hunk: index + 1 }))
    .filter(({ chunk }) => codexDraftPatchChunkHasChange(chunk));
  if (changedChunks.length !== parsedChunks.length) {
    const hunk = parsedChunks.findIndex((chunk) => !codexDraftPatchChunkHasChange(chunk)) + 1;
    throw new Error(
      `PATCH_MISSING_CHANGE_MARKERS: hunk ${hunk} has no source change. No hunks were saved. `
      + "Use '-old' and '+new' in the SAME @@ hunk, followed by the full source indentation. "
      + 'Two context-only @@ blocks are NOT an old/new replacement. '
      + 'For indentation repairs use replacements: [{oldText: exact current source, newText: corrected source}] instead of patch. '
      + 'Do not add comments just to force a byte change.',
    );
  }
  changedChunks.forEach(({ chunk, hunk }) => {
    try {
      for (const [start, oldLength, newLines] of codexDraftPatchReplacements(lines, [chunk])) {
        candidates.push({ start, end: start + oldLength, newLines, hunk });
      }
    } catch (error) {
      failedHunks.push({
        hunk,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  const overlapping = new Set<number>();
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      if (sourceEditRangesOverlap(candidates[i], candidates[j])) {
        overlapping.add(candidates[i].hunk);
        overlapping.add(candidates[j].hunk);
      }
    }
  }
  for (const hunk of overlapping) failedHunks.push({ hunk, error: 'PATCH_TARGET_OVERLAP: combine changes to the same source range into one hunk. No hunks were saved.' });
  if (failedHunks.length) return {
    source: normalized, appliedHunks: 0, alreadyAppliedHunks: 0, failedHunks, ignoredHunks: 0, totalHunks: parsedChunks.length,
    blockedHunks: changedChunks.filter(({ hunk }) => !failedHunks.some((failure) => failure.hunk === hunk)).map(({ hunk }) => hunk),
  };
  const changedLineCount = candidates.reduce((sum, item) => sum + Math.max(item.end - item.start, item.newLines.length), 0);
  if (changedLineCount >= 100 && changedLineCount / Math.max(1, draftSourceLineCount(normalized)) >= 0.6) {
    throw new Error('Near-complete source replacement through one edit is blocked. Keep the same draft and split the repair into focused Codex-format hunks based on the latest read.');
  }
  for (const item of candidates.sort((a, b) => b.start - a.start)) lines.splice(item.start, item.end - item.start, ...item.newLines);
  return {
    source: `${lines.join('\n')}${hasFinalNewline ? '\n' : ''}`,
    appliedHunks: changedChunks.length,
    alreadyAppliedHunks: 0,
    failedHunks,
    ignoredHunks: 0,
    totalHunks: parsedChunks.length,
    blockedHunks: [],
  };
}

/** Exact replacements avoid diff-marker/indentation ambiguity. Match one snapshot. */
export function applyUnoDraftReplacements(
  source: string,
  replacements: Array<{ oldText: string; newText: string }>,
): UnoDraftPatchResult {
  const normalized = normalizedDraftSource(source);
  if (!Array.isArray(replacements) || !replacements.length || replacements.length > 50
    || replacements.some((item) => !item || typeof item.oldText !== 'string' || !item.oldText.length || typeof item.newText !== 'string')
    || replacements.reduce((sum, item) => sum + item.oldText.length + item.newText.length, 0) > 200_000) {
    throw new Error('replacements requires 1-50 oldText/newText pairs, nonempty oldText, at most 200000 total characters.');
  }
  const positions = (text: string) => {
    const found: number[] = [];
    for (let start = 0; text && start <= normalized.length - text.length;) {
      const index = normalized.indexOf(text, start);
      if (index < 0) break;
      start = index + 1;
      // Three leading spaces must not match inside a four-space indent.
      const lineStart = normalized.lastIndexOf('\n', index - 1) + 1;
      if (/^[\t ]/.test(text) && index > lineStart && /^[\t ]*$/.test(normalized.slice(lineStart, index))) continue;
      found.push(index);
      if (found.length > 1) break;
    }
    return found;
  };
  const failedHunks: UnoDraftPatchHunkFailure[] = [];
  let alreadyAppliedHunks = 0;
  const candidates: Array<{ start: number; end: number; text: string; hunk: number }> = [];
  replacements.forEach((item, index) => {
    const hunk = index + 1;
    const oldText = normalizedDraftSource(item.oldText);
    const newText = normalizedDraftSource(item.newText);
    const found = positions(oldText);
    if (found.length !== 1) {
      const sourceContext = failedHunks.length < 3 ? replacementConflictSourceContext(normalized, oldText) : undefined;
      failedHunks.push({ hunk, error: found.length
        ? 'OLD_TEXT_AMBIGUOUS: include surrounding unchanged source until oldText matches exactly once.'
        : 'OLD_TEXT_NOT_FOUND: copy oldText from the exact source, preserving indentation and quote/backslash characters. JSON transport escapes are not extra characters in the Python source. Use sourceContext below when sufficient; otherwise read only the missing local window. No fuzzy matching is performed.',
        ...(sourceContext ? { sourceContext } : {}) });
    } else if (oldText === newText) {
      alreadyAppliedHunks += 1;
    } else {
      candidates.push({ start: found[0], end: found[0] + oldText.length, text: newText, hunk });
    }
  });
  const overlapping = new Set<number>();
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      if (sourceEditRangesOverlap(candidates[i], candidates[j])) {
        overlapping.add(candidates[i].hunk);
        overlapping.add(candidates[j].hunk);
      }
    }
  }
  for (const hunk of overlapping) failedHunks.push({ hunk, error: 'OVERLAPPING_REPLACEMENTS: combine overlapping changes into a single oldText/newText pair.' });
  if (failedHunks.length) return {
    source: normalized, appliedHunks: 0, alreadyAppliedHunks, failedHunks, ignoredHunks: 0, totalHunks: replacements.length,
    blockedHunks: candidates.filter((item) => !overlapping.has(item.hunk)).map((item) => item.hunk),
  };
  const applicable = candidates;
  let edited = normalized;
  let changedLines = 0;
  for (const item of applicable.sort((a, b) => b.start - a.start)) {
    changedLines += Math.max(draftSourceLineCount(normalized.slice(item.start, item.end)), draftSourceLineCount(item.text));
    edited = edited.slice(0, item.start) + item.text + edited.slice(item.end);
  }
  if (changedLines >= 100 && changedLines / draftSourceLineCount(normalized) >= 0.6) {
    throw new Error('Near-complete source replacement is blocked. Use focused replacements from the latest readSource.');
  }
  if (!applicable.length && !alreadyAppliedHunks) {
    throw new Error(failedHunks.map((item) => `replacement ${item.hunk}: ${item.error}`).join('\n'));
  }
  return { source: edited, appliedHunks: applicable.length, alreadyAppliedHunks, failedHunks, ignoredHunks: 0, totalHunks: replacements.length, blockedHunks: [] };
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
    return await withDraftLock(input.runId, documentId, () => getUnoApiUnlocked({ ...input, documentId }));
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

function versionedRenderedArtifact(artifactId: string) {
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
    return await withDraftLock(input.runId, documentId, () => readUnoDraftUnlocked({ ...input, documentId }));
  } catch (error) {
    return { ok: false, actual: `Office draft read failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function planFileArtifact(input: PlanArtifactInput): Promise<FileArtifactOperationResult> {
  const documentId = String(input.documentId || '').trim();
  if (!DOCUMENT_ID_PATTERN.test(documentId)) {
    return { ok: false, actual: 'file action=plan requires a stable model-chosen documentId (1-96 ASCII letters, numbers, dot, underscore, or hyphen).' };
  }
  const result = await withDraftLock(input.runId, documentId, () => planFileArtifactUnlocked({ ...input, documentId }));
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

export async function disposeDefaultNodeFileWorkspace() {
  const host = defaultNodeFileWorkspaceHost;
  defaultNodeFileWorkspaceHost = undefined;
  await host?.dispose();
}
