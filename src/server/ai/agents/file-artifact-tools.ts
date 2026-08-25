import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, type Dirent } from 'node:fs';
import { access, copyFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import sharp from 'sharp';
import { artifactApiUrl, artifactApiUrlFromRelative } from '@/lib/artifacts';
import type { BrowserActionResult } from '@/server/browser/browser-session';
import { artifactPath, artifactsRoot } from '@/server/storage/paths';
import { fileFormatForExtension, fileFormatForMimeType, normalizedFileExtension } from '@/server/files/file-format-registry';
import {
  generateFileToPaths,
} from './document-artifact-generators';
import { inspectUnoApi, type UnoApiTarget } from '@/server/files/uno-program';
import { convertOfficeFile } from '@/server/files/libreoffice';
import { validateOfficeArtifact } from '@/server/files/office-artifact-validator';
import { analyzeOfficeProgram, type OfficeProgramDiagnostic } from '@/server/files/office-program-analysis';
import type {
  OfficeDocumentDraft,
  OfficeDocumentKind,
} from '@/server/files/office-document-spec';
import {
  fillDocxTemplateBuffer,
  type DocxTemplateFillOperation,
} from './docx-template-filler';
import { renderBrowserChatAttachmentVisuals } from './browser-chat-attachment-visuals';
import type { BrowserCodeAttachmentBinding } from '@/server/browser/browser-code-runner';
import { racePromiseWithAbort } from './browser-chat-interrupt-state';

const FILE_DOWNLOAD_TIMEOUT_MS = 120_000;
const FILE_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;
const FILE_DOWNLOAD_RETRY_DELAYS_MS = [750, 1_500, 3_000] as const;
const FILE_DOWNLOAD_CACHE_VERSION = 'mime-extension-v1';
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const draftLocks = new Map<string, Promise<void>>();
const activeDownloads = new Map<string, Promise<BrowserActionResult>>();
const downloadDomainQueues = new Map<string, Promise<void>>();
const downloadDomainCooldowns = new Map<string, number>();
const DRAFT_LOCK_WAIT_MS = 120_000;
const STALE_DRAFT_LOCK_MS = 10 * 60_000;
const OFFICE_PIPELINE_VERSION = 'office-pipeline-v4-units-preflight-recovery';

type DownloadArtifactInput = {
  runId?: string;
  url?: string;
  path?: string;
  urlOrPath?: string;
  sourcePageUrl?: string;
  fileName?: string | null;
  fileType?: string | null;
};

type PlanArtifactInput = {
  runId?: string;
  documentId?: string;
  fileName?: string | null;
  documentType?: OfficeDocumentKind;
  intent?: string;
  operation?: 'create' | 'modify';
  sourceAttachmentId?: string;
  attachmentBindings?: BrowserCodeAttachmentBinding[];
};

type GenerateUnoProgramInput = {
  runId?: string;
  documentId?: string;
  program?: string;
  render?: boolean;
  includeVisualVerification?: boolean;
  attachmentBindings?: BrowserCodeAttachmentBinding[];
  abortSignal?: AbortSignal;
  onProgress?: (progress: FileGenerationProgress) => void | Promise<void>;
};

export type FileGenerationProgress = {
  phase: string;
  message: string;
  current?: number;
  total?: number;
};

export type UnoDraftLineEdit = {
  /** Defaults to replaceRange for compatibility with existing calls. */
  kind?: 'deleteRange' | 'insertAfter' | 'insertBefore' | 'replaceRange' | 'replaceText';
  /** One-based, inclusive source line range from action=read. */
  startLine?: number;
  endLine?: number;
  /** One-based anchor line for insertBefore/insertAfter. */
  line?: number;
  /** Exact current source text for replaceText. */
  oldText?: string;
  /** One-based occurrence for replaceText; omitted requires a unique match. */
  occurrence?: number;
  newText: string;
};

type EditUnoProgramInput = {
  runId?: string;
  documentId?: string;
  /** Optional @webpilot-unit path. Edits are scoped to that page/section source unit. */
  path?: string;
  /** Optional legacy digest. A single chat owns its draft, so edits use the current source. */
  baseDigest?: string;
  edits?: UnoDraftLineEdit[];
  patch?: string;
  restoreRevision?: number;
  program?: string;
  render?: boolean;
  includeVisualVerification?: boolean;
  attachmentBindings?: BrowserCodeAttachmentBinding[];
  abortSignal?: AbortSignal;
  onProgress?: (progress: FileGenerationProgress) => void | Promise<void>;
};

type UnoApiInput = {
  runId?: string;
  documentId?: string;
  documentType?: OfficeDocumentKind;
  target?: UnoApiTarget;
  query?: string;
  offset?: number;
  limit?: number;
};

type ReadUnoDraftInput = {
  runId?: string;
  documentId?: string;
  path?: string;
};

type RenderArtifactInput = {
  runId?: string;
  documentId?: string;
  includeVisualVerification?: boolean;
  attachmentBindings?: BrowserCodeAttachmentBinding[];
  abortSignal?: AbortSignal;
  onProgress?: (progress: FileGenerationProgress) => void | Promise<void>;
};

type ConvertArtifactInput = {
  runId?: string;
  sourceArtifactId?: string;
  fileName?: string | null;
  includeVisualVerification?: boolean;
};

type FillDocumentTemplateArtifactInput = {
  runId?: string;
  templateAttachmentId?: string;
  fileName?: string | null;
  includeVisualVerification?: boolean;
  operations?: DocxTemplateFillOperation[];
  attachmentBindings?: BrowserCodeAttachmentBinding[];
};

type ArtifactToolPayload = {
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
  validation?: string;
  validationStatus?: string;
  rolledBack?: boolean;
  currentRevision?: number | null;
  lastSuccessfulRevision?: number | null;
  error?: string;
};

export type FileArtifactToolResult = {
  name: string;
  result?: unknown;
};

export type FileArtifactDownload = {
  artifactId: string;
  downloadUrl: string;
  fileName: string;
};

function escapeMarkdownLinkLabel(value: string) {
  return value.replace(/[[\]\\]/g, '\\$&');
}

function sanitizeFileName(value: string | undefined | null, fallback: string) {
  const cleaned = String(value || '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 160);
  return cleaned || fallback;
}

function artifactDir(runId: string | undefined, kind: 'attachment-previews' | 'document-assets' | 'document-drafts' | 'downloads' | 'generated') {
  return artifactPath(sanitizeFileName(runId, 'adhoc'), kind);
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
  const configured = String(process.env.OFFICE_GENERATION_MODE || 'javascript').trim().toLowerCase();
  const extension = path.extname(fileName).toLowerCase();
  if (configured === 'javascript') {
    if (!javascriptOfficeExtensions.has(extension)) {
      throw new Error('JavaScript Office generation supports .pptx, .docx, .xlsx, and PDF converted from the matching Office source. Select UNO mode for legacy Office or OpenDocument output.');
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
  attachmentBindings: BrowserCodeAttachmentBinding[] = [],
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

async function uniqueArtifactPath(dir: string, requestedFileName: string) {
  const parsed = path.parse(requestedFileName);
  const base = sanitizeFileName(parsed.name, 'artifact');
  const ext = parsed.ext.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '').slice(0, 32);
  for (let index = 0; index < 1000; index += 1) {
    const fileName = index === 0 ? `${base}${ext}` : `${base}-${index + 1}${ext}`;
    const filePath = path.join(dir, fileName);
    try {
      await access(filePath);
    } catch {
      return { fileName, filePath };
    }
  }
  const fileName = `${base}-${randomUUID().slice(0, 8)}${ext}`;
  return { fileName, filePath: path.join(dir, fileName) };
}

function artifactResultPayload(input: {
  filePath: string;
  fileName: string;
  bytes: number;
  sourceUrl?: string;
  kind: 'download' | 'generated';
}) {
  const root = artifactsRoot();
  const relative = path.relative(root, input.filePath).replace(/\\/g, '/');
  const url = relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? artifactApiUrlFromRelative(relative)
    : artifactApiUrl(input.filePath, { artifactsRoot: root });
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

export function formatFileArtifactResult(toolName: string, actual?: string) {
  if (toolName !== 'file' && toolName !== 'downloadFile' && toolName !== 'generateFile' && toolName !== 'fillDocumentTemplate') return undefined;
  try {
    const payload = JSON.parse(actual || '{}') as ArtifactToolPayload;
    if (payload.kind === 'document-plan') {
      const assets = Array.isArray((payload as Record<string, unknown>).availableAssets)
        ? ((payload as Record<string, unknown>).availableAssets as Array<Record<string, unknown>>)
          .map((asset) => typeof asset.assetName === 'string' ? asset.assetName : '')
          .filter(Boolean)
        : [];
      return `Document planned: ${payload.fileName || 'artifact'}; Document ID: ${payload.documentId}; operation=${payload.operation || 'create'}; generator=${payload.generator || 'javascript'}; sourceCharacters=${payload.sourceCharacters || 0}; Mounted conversation assets: ${assets.length ? assets.join(', ') : '(none)'}. Use only these exact names with the returned cookbook asset API.`;
    }
    if (payload.kind === 'uno-program' || payload.kind === 'office-program') {
      return `Office source updated: ${payload.fileName || 'artifact'}; Document ID: ${payload.documentId}; generator=${payload.generator || 'javascript'}; sourceCharacters=${payload.sourceCharacters || 0}`;
    }
    if (payload.kind === 'uno-draft-validation') {
      if (payload.validation === 'failed' || payload.validationStatus === 'failed' || payload.rolledBack) {
        return `Office source validation failed: ${payload.fileName || 'artifact'}; Document ID: ${payload.documentId}; editRolledBack=${payload.rolledBack === true}; currentRevision=${payload.currentRevision ?? 'none'}; lastSuccessfulRevision=${payload.lastSuccessfulRevision ?? 'none'}; error=${payload.error || 'validation failed'}`;
      }
      return `Office source validated: ${payload.fileName || 'artifact'}; Document ID: ${payload.documentId}; sourceCharacters=${payload.sourceCharacters || 0}; cacheHit=${payload.cacheHit === true}`;
    }
    if (payload.kind === 'office-source-unit-validation' && payload.validation === 'failed') {
      return `Office source-unit validation failed: Document ID: ${payload.documentId}; editRolledBack=${payload.rolledBack === true}; currentRevision=${payload.currentRevision ?? 'none'}; lastSuccessfulRevision=${payload.lastSuccessfulRevision ?? 'none'}; error=${payload.error || 'validation failed'}`;
    }
    if (payload.kind !== 'download' && payload.kind !== 'generated') return undefined;
    const label = toolName === 'downloadFile' || (toolName === 'file' && payload.kind === 'download')
      ? 'File downloaded'
      : toolName === 'fillDocumentTemplate'
        ? 'Document template filled'
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
    ].filter(Boolean).join('; ');
  } catch {
    return actual;
  }
}

function parseContentDispositionFileName(value: string | null) {
  if (!value) return undefined;
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.replace(/^"|"$/g, ''));
    } catch {
      return encoded.replace(/^"|"$/g, '');
    }
  }
  return value.match(/filename="?([^";]+)"?/i)?.[1];
}

function fileNameFromUrl(value: string) {
  try {
    const url = new URL(value);
    const name = path.basename(decodeURIComponent(url.pathname));
    return name && name !== '/' ? name : undefined;
  } catch {
    return undefined;
  }
}

function normalizedDownloadFileType(value: string | undefined | null) {
  const fileType = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9]{1,10}$/.test(fileType)) {
    throw new Error('downloadFile requires fileType as a file extension without a dot, for example jpg, pdf, or docx.');
  }
  return `.${fileType}`;
}

function sameRegisteredFileType(left: string, right: string) {
  const leftMime = fileFormatForExtension(left)?.mimeType.split(';')[0].trim().toLowerCase();
  const rightMime = fileFormatForExtension(right)?.mimeType.split(';')[0].trim().toLowerCase();
  return Boolean(leftMime && rightMime && leftMime === rightMime);
}

function fileNameWithResponseExtension(fileName: string, requestedExtension: string, contentType: string | null) {
  const normalizedContentType = String(contentType || '').split(';')[0].trim().toLowerCase();
  const responseExtension = normalizedContentType && normalizedContentType !== 'application/octet-stream'
    ? fileFormatForMimeType(normalizedContentType)?.extension
    : undefined;
  const effectiveExtension = !responseExtension || sameRegisteredFileType(requestedExtension, responseExtension)
    ? requestedExtension
    : responseExtension;
  const currentExtension = normalizedFileExtension(fileName);
  if (!currentExtension) return `${fileName}${effectiveExtension}`;
  if (currentExtension === effectiveExtension || sameRegisteredFileType(currentExtension, effectiveExtension)) return fileName;
  return `${fileName.slice(0, -currentExtension.length)}${effectiveExtension}`;
}

function resolveDownloadUrl(input: DownloadArtifactInput) {
  const raw = String(input.url || input.urlOrPath || input.path || '').trim();
  if (!raw) throw new Error('downloadFile requires url, path, or urlOrPath.');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;

  const sourcePageUrl = String(input.sourcePageUrl || '').trim();
  if (!sourcePageUrl) {
    throw new Error('downloadFile needs the current page URL to resolve relative paths; provide an absolute URL instead.');
  }
  try {
    return new URL(raw, sourcePageUrl).toString();
  } catch {
    throw new Error(`downloadFile cannot resolve "${raw}" against current page URL "${sourcePageUrl}".`);
  }
}

async function writeLimitedResponse(response: Response, filePath: string, maxBytes: number) {
  const contentLength = Number(response.headers.get('content-length') || '');
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Download is too large: ${contentLength} bytes exceeds ${maxBytes} bytes.`);
  }

  if (!response.body) {
    await writeFile(filePath, Buffer.alloc(0), { flag: 'wx' });
    return 0;
  }
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        callback(new Error(`Download is too large: received more than ${maxBytes} bytes.`));
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    limiter,
    createWriteStream(filePath, { flags: 'wx' }),
  );
  return bytes;
}

async function downloadFileArtifactUnlocked(input: DownloadArtifactInput, url: string, cacheKey: string): Promise<BrowserActionResult> {
  try {
    const dir = artifactDir(input.runId, 'downloads');
    const cacheDirectory = path.join(dir, '.url-cache');
    const cachePath = path.join(cacheDirectory, `${cacheKey}.json`);
    try {
      const cached = JSON.parse(await readFile(cachePath, 'utf8')) as ArtifactToolPayload;
      const cachedPath = path.resolve(String(cached.path || ''));
      const relative = path.relative(path.resolve(dir), cachedPath);
      const metadata = relative && !relative.startsWith('..') && !path.isAbsolute(relative)
        ? await stat(cachedPath)
        : undefined;
      if (metadata?.isFile()) {
        return { ok: true, actual: JSON.stringify({ ...cached, bytes: metadata.size, cacheHit: true }) };
      }
    } catch {
      // A missing or stale URL cache is a normal cache miss.
    }
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(new Error(`Download timed out after ${FILE_DOWNLOAD_TIMEOUT_MS}ms`)), FILE_DOWNLOAD_TIMEOUT_MS);

    try {
      const { response, resolvedUrl } = await fetchDownloadResponseWithRetry(url, abortController.signal);
      if (!response.ok) {
        return { ok: false, actual: `downloadFile failed: HTTP ${response.status} ${response.statusText} for ${resolvedUrl}` };
      }
      const suggestedName = input.fileName
        || parseContentDispositionFileName(response.headers.get('content-disposition'))
        || fileNameFromUrl(resolvedUrl)
        || `download-${Date.now()}.bin`;
      const sanitizedName = sanitizeFileName(suggestedName, `download-${Date.now()}.bin`);
      const fileName = fileNameWithResponseExtension(
        sanitizedName,
        normalizedDownloadFileType(input.fileType),
        response.headers.get('content-type'),
      );
      await mkdir(dir, { recursive: true });
      const target = await uniqueArtifactPath(dir, fileName);
      let bytes = 0;
      try {
        bytes = await writeLimitedResponse(response, target.filePath, FILE_DOWNLOAD_MAX_BYTES);
      } catch (error) {
        await unlink(target.filePath).catch(() => undefined);
        throw error;
      }

      const payload = {
        ...artifactResultPayload({
          kind: 'download',
          fileName: target.fileName,
          filePath: target.filePath,
          bytes,
          sourceUrl: resolvedUrl,
        }),
        cacheHit: false,
      };
      await mkdir(cacheDirectory, { recursive: true });
      await writeFile(cachePath, JSON.stringify(payload), 'utf8');
      return { ok: true, actual: JSON.stringify(payload) };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return { ok: false, actual: `downloadFile failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function draftPath(runId: string | undefined, documentId: string) {
  return path.join(artifactDir(runId, 'document-drafts'), `${sanitizeFileName(documentId, 'document')}.json`);
}

function draftProgramPath(runId: string | undefined, documentId: string, generator: OfficeDocumentDraft['generator'] = 'javascript') {
  return path.join(
    artifactDir(runId, 'document-drafts'),
    `${sanitizeFileName(documentId, 'document')}${generator === 'javascript' ? '.mjs' : '.py'}`,
  );
}

function draftRevisionDirectory(runId: string | undefined, documentId: string) {
  return path.join(artifactDir(runId, 'document-drafts'), `${sanitizeFileName(documentId, 'document')}.revisions`);
}

function draftRevisionFileName(revision: number, generator: OfficeDocumentDraft['generator'] = 'javascript') {
  return `${String(revision).padStart(6, '0')}${generator === 'javascript' ? '.mjs' : '.py'}`;
}

function draftTransactionPath(runId: string | undefined, documentId: string) {
  return path.join(artifactDir(runId, 'document-drafts'), `${sanitizeFileName(documentId, 'document')}.transaction.json`);
}

function draftLockPath(runId: string | undefined, documentId: string) {
  return path.join(artifactDir(runId, 'document-drafts'), `${sanitizeFileName(documentId, 'document')}.lock`);
}

function requireDocumentId(value: string | undefined, action: 'read' | 'generate' | 'edit' | 'render') {
  const documentId = String(value || '').trim();
  if (!DOCUMENT_ID_PATTERN.test(documentId)) {
    throw new Error(`file action=${action} requires the stable documentId returned by action=plan.`);
  }
  return documentId;
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
      await racePromiseWithAbort(new Promise((resolve) => setTimeout(resolve, 50)), abortSignal);
    }
  }
}

export async function downloadFileArtifact(input: DownloadArtifactInput): Promise<BrowserActionResult> {
  let requestedExtension: string;
  try {
    requestedExtension = normalizedDownloadFileType(input.fileType);
  } catch (error) {
    return { ok: false, actual: `downloadFile failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const explicitExtension = normalizedFileExtension(String(input.fileName || ''));
  if (explicitExtension && explicitExtension !== requestedExtension && !sameRegisteredFileType(explicitExtension, requestedExtension)) {
    return { ok: false, actual: `downloadFile failed: fileName extension ${explicitExtension} does not match fileType ${input.fileType}.` };
  }
  let url: string;
  try {
    url = resolveDownloadUrl(input);
  } catch (error) {
    return { ok: false, actual: `downloadFile failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const cacheKey = downloadCacheKey(input, url);
  const activeKey = `${sanitizeFileName(input.runId, 'adhoc')}:${cacheKey}`;
  const existing = activeDownloads.get(activeKey);
  if (existing) return existing;
  const pending = downloadFileArtifactUnlocked(input, url, cacheKey);
  activeDownloads.set(activeKey, pending);
  try {
    return await pending;
  } finally {
    if (activeDownloads.get(activeKey) === pending) activeDownloads.delete(activeKey);
  }
}

export async function convertFileArtifact(input: ConvertArtifactInput): Promise<BrowserActionResult> {
  try {
    const sourceArtifactId = String(input.sourceArtifactId || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
    if (!sourceArtifactId) return { ok: false, actual: 'file action=convert requires sourceArtifactId from a prior artifact result.' };
    const root = path.resolve(artifactsRoot());
    const sourcePath = path.resolve(root, sourceArtifactId);
    const relativeSource = path.relative(root, sourcePath);
    if (!relativeSource || relativeSource.startsWith('..') || path.isAbsolute(relativeSource)) {
      return { ok: false, actual: 'file action=convert sourceArtifactId must resolve inside the artifact workspace.' };
    }
    const sourceMetadata = await stat(sourcePath);
    if (!sourceMetadata.isFile()) return { ok: false, actual: 'file action=convert sourceArtifactId does not identify a file.' };
    const sourceExtension = path.extname(sourcePath).toLowerCase();
    const convertible = new Set(['.doc', '.docx', '.odt', '.xls', '.xlsx', '.ods', '.ppt', '.pptx', '.odp']);
    if (!convertible.has(sourceExtension)) {
      return { ok: false, actual: `file action=convert supports Office source files only; received ${sourceExtension || 'no extension'}.` };
    }
    const requestedName = sanitizeFileName(input.fileName, `${path.basename(sourcePath, sourceExtension)}.pdf`);
    if (path.extname(requestedName).toLowerCase() !== '.pdf') {
      return { ok: false, actual: 'file action=convert currently requires a .pdf fileName.' };
    }
    const converted = await convertOfficeFile({ absolutePath: sourcePath, sourceExtension, targetExtension: '.pdf' });
    if (!converted?.length) throw new Error('LibreOffice did not return converted PDF bytes.');
    const directory = path.join(artifactDir(input.runId, 'generated'), 'conversions');
    await mkdir(directory, { recursive: true });
    const target = await uniqueArtifactPath(directory, requestedName);
    await writeFile(target.filePath, converted, { flag: 'wx' });
    const artifact = artifactResultPayload({
      filePath: target.filePath,
      fileName: target.fileName,
      bytes: converted.length,
      kind: 'generated',
    });
    const visualVerification = input.includeVisualVerification
      ? await renderBrowserChatAttachmentVisuals({
          absolutePath: target.filePath,
          cacheKey: `${await sha256File(target.filePath)}:conversion`,
          extension: '.pdf',
          name: target.fileName,
          previewRoot: artifactDir(input.runId, 'attachment-previews'),
        })
      : undefined;
    return {
      ok: true,
      actual: JSON.stringify({
        ...artifact,
        sourceArtifactId,
        convertedFrom: sourceExtension,
        convertedTo: '.pdf',
        qualityGate: visualVerification ? {
          structural: true,
          visual: { previewPages: visualVerification.renderedPages, modelReviewRequired: true },
        } : { structural: true, visual: { status: 'not-performed' } },
      }),
      referenceImagePaths: visualVerification?.imagePaths.length ? visualVerification.imagePaths : undefined,
    };
  } catch (error) {
    return { ok: false, actual: `Office conversion failed: ${error instanceof Error ? error.message : String(error)}` };
  }
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
    await racePromiseWithAbort(previous, abortSignal);
    releaseFilesystemLock = await acquireFilesystemDraftLock(runId, documentId, abortSignal);
    return await operation();
  } finally {
    await releaseFilesystemLock?.();
    release?.();
    if (draftLocks.get(key) === tail) draftLocks.delete(key);
  }
}

function canonicalWikimediaOriginalUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'upload.wikimedia.org') return undefined;
    const match = parsed.pathname.match(/^(\/wikipedia\/commons)\/thumb\/(.+)\/\d+px-[^/]+$/i);
    if (!match) return undefined;
    const segments = match[2].split('/');
    if (segments.length < 3) return undefined;
    const originalPath = match[2].replace(/^(.*)\/\d+px-[^/]+$/, '$1');
    return `${parsed.origin}${match[1]}/${originalPath}${parsed.search}`;
  } catch {
    return undefined;
  }
}

async function fetchDownloadResponse(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal, redirect: 'follow' });
  if (response.ok || response.status !== 400) return { response, resolvedUrl: url };
  // Commons rejects made-up thumbnail widths. The original asset has the same
  // stable hash/file path, independent of a guessed `Npx-` segment.
  const canonical = canonicalWikimediaOriginalUrl(url);
  if (!canonical || canonical === url) return { response, resolvedUrl: url };
  await response.body?.cancel().catch(() => undefined);
  return { response: await fetch(canonical, { signal, redirect: 'follow' }), resolvedUrl: canonical };
}

function downloadCacheKey(input: DownloadArtifactInput, url: string) {
  return createHash('sha256')
    .update(`${FILE_DOWNLOAD_CACHE_VERSION}\n${url}\n${String(input.fileName || '')}\n${String(input.fileType || '')}`, 'utf8')
    .digest('hex');
}

function downloadRetryDelay(response: Response, attempt: number) {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, seconds * 1_000);
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay) && dateDelay > 0) return Math.min(30_000, dateDelay);
  }
  return FILE_DOWNLOAD_RETRY_DELAYS_MS[Math.min(attempt, FILE_DOWNLOAD_RETRY_DELAYS_MS.length - 1)];
}

async function waitForDownloadRetry(delayMs: number, signal: AbortSignal) {
  await racePromiseWithAbort(new Promise<void>((resolve) => setTimeout(resolve, delayMs)), signal);
}

function downloadHostname(url: string) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

async function waitForDownloadDomainCooldown(hostname: string, signal: AbortSignal) {
  const cooldownUntil = downloadDomainCooldowns.get(hostname) || 0;
  const delayMs = cooldownUntil - Date.now();
  if (delayMs > 0) await waitForDownloadRetry(delayMs, signal);
  if ((downloadDomainCooldowns.get(hostname) || 0) <= Date.now()) downloadDomainCooldowns.delete(hostname);
}

async function withDownloadDomainQueue<T>(url: string, operation: (hostname: string) => Promise<T>) {
  const hostname = downloadHostname(url);
  if (!hostname) return operation('');
  const previous = downloadDomainQueues.get(hostname) || Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  downloadDomainQueues.set(hostname, tail);
  try {
    await previous;
    return await operation(hostname);
  } finally {
    release?.();
    if (downloadDomainQueues.get(hostname) === tail) downloadDomainQueues.delete(hostname);
  }
}

async function fetchDownloadResponseWithRetry(url: string, signal: AbortSignal) {
  return withDownloadDomainQueue(url, async (hostname) => {
    const retryable = new Set([429, 502, 503, 504]);
    for (let attempt = 0; ; attempt += 1) {
      if (hostname) await waitForDownloadDomainCooldown(hostname, signal);
      const result = await fetchDownloadResponse(url, signal);
      if (!retryable.has(result.response.status) || attempt >= FILE_DOWNLOAD_RETRY_DELAYS_MS.length) return result;
      const delayMs = downloadRetryDelay(result.response, attempt);
      if (hostname && result.response.status === 429) {
        downloadDomainCooldowns.set(hostname, Math.max(
          downloadDomainCooldowns.get(hostname) || 0,
          Date.now() + delayMs,
        ));
      }
      await result.response.body?.cancel().catch(() => undefined);
      await waitForDownloadRetry(delayMs, signal);
    }
  });
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
  const parsed = JSON.parse(await readFile(draftPath(runId, documentId), 'utf8')) as OfficeDocumentDraft & { revision?: unknown };
  // Migrate metadata written by the retired caller-visible revision protocol.
  delete parsed.revision;
  parsed.generator ||= 'javascript';
  parsed.operation ||= parsed.sourceDocument ? 'modify' : 'create';
  parsed.renderedDigest ||= parsed.renderedSourceDigest;
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
        throw new Error('Workspace source file does not match its saved source metadata. Read the draft again or restore it before editing.');
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
  revision: number | null;
  sourceDigest: string | null;
  renderedDigest: string | null;
  visualQaDigest: string | null;
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
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.') || !entry.name.endsWith('.json')) continue;
    const documentId = entry.name.slice(0, -'.json'.length);
    if (!DOCUMENT_ID_PATTERN.test(documentId)) continue;
    try {
      const draft = await loadDraft(runId, documentId);
      catalog.push({
        documentId: draft.documentId,
        documentType: draft.documentType,
        fileName: draft.fileName,
        generator: draft.generator || 'javascript',
        revision: draft.currentRevision || null,
        sourceDigest: draft.sourceDigest || null,
        renderedDigest: draft.renderedDigest || draft.renderedSourceDigest || null,
        visualQaDigest: draft.visualQaDigest || null,
        state: draft.workflow?.state || (draft.program ? 'authoring' : 'planned'),
        updatedAt: draft.updatedAt,
      });
    } catch {
      // A corrupt sidecar is reported when addressed directly; it must not hide healthy drafts.
    }
  }
  return catalog.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function listOfficeDrafts(input: { runId?: string }): Promise<BrowserActionResult> {
  try {
    const drafts = await listOfficeDraftCatalog(input.runId);
    return { ok: true, actual: JSON.stringify({ kind: 'office-draft-catalog', drafts }) };
  } catch (error) {
    return { ok: false, actual: `Office draft list failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function officeDraftCatalogForPrompt(runId: string | undefined) {
  const drafts = await listOfficeDraftCatalog(runId);
  if (!drafts.length) return '';
  return [
    '[Current Office draft catalog - trusted runtime metadata]',
    'Resume an existing logical document with its exact documentId. Do not guess an ID or create a replacement unless the user explicitly requests a new document.',
    ...drafts.slice(0, 100).map((draft) => `- documentId=${draft.documentId} | type=${draft.documentType} | file=${JSON.stringify(draft.fileName)} | revision=${draft.revision ?? 'none'} | state=${draft.state} | sourceDigest=${draft.sourceDigest || 'none'} | renderedDigest=${draft.renderedDigest || 'none'} | visualQaDigest=${draft.visualQaDigest || 'none'} | updatedAt=${draft.updatedAt}`),
  ].join('\n');
}

export async function pendingOfficeDocumentWork(
  runId: string | undefined,
  documentIds: Set<string>,
  options: { requireVisualQa?: boolean } = {},
) {
  const catalog = await listOfficeDraftCatalog(runId);
  return catalog.filter((draft) => documentIds.has(draft.documentId)).reduce<Array<OfficeDraftCatalogEntry & {
    requiredNextAction: 'generate' | 'render' | 'fileVisual';
  }>>((pending, draft) => {
    if (!draft.sourceDigest) pending.push({ ...draft, requiredNextAction: 'generate' });
    else if (draft.renderedDigest !== draft.sourceDigest) pending.push({ ...draft, requiredNextAction: 'render' });
    else if (draft.state === 'qa-pending' && options.requireVisualQa !== false) {
      pending.push({ ...draft, requiredNextAction: 'fileVisual' });
    }
    return pending;
  }, []);
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
  if (draft.program && draft.sourceDigest) {
    const revisions = Array.isArray(draft.revisions) ? [...draft.revisions] : [];
    const latest = revisions.at(-1);
    if (!latest || latest.sourceDigest !== draft.sourceDigest) {
      const revision = Math.max(0, ...revisions.map((item) => Number(item.revision) || 0)) + 1;
      const sourceFileName = draftRevisionFileName(revision, draft.generator);
      const revisionDirectory = draftRevisionDirectory(runId, draft.documentId);
      const revisionTarget = path.join(revisionDirectory, sourceFileName);
      const revisionCandidate = path.join(revisionDirectory, `.${sourceFileName}.${randomUUID()}.tmp`);
      await mkdir(revisionDirectory, { recursive: true });
      try {
        await writeFile(revisionCandidate, draft.program, { encoding: 'utf8', flag: 'wx' });
        await rename(revisionCandidate, revisionTarget);
      } finally {
        await unlink(revisionCandidate).catch(() => undefined);
      }
      revisions.push({ revision, sourceDigest: draft.sourceDigest, createdAt: draft.updatedAt, sourceFileName });
      draft.currentRevision = revision;
      draft.revisions = revisions;
    } else {
      draft.currentRevision = latest.revision;
      draft.revisions = revisions;
    }
  }
  await writeDraftWorkspace(runId, draft);
}

async function restoreDraftSnapshot(
  runId: string | undefined,
  snapshot: OfficeDocumentDraft,
  rejectedDraft: OfficeDocumentDraft,
) {
  const keep = new Set((snapshot.revisions || []).map((revision) => revision.sourceFileName));
  const rejectedOnly = (rejectedDraft.revisions || []).filter((revision) => !keep.has(revision.sourceFileName));
  await Promise.all(rejectedOnly.map((revision) => unlink(path.join(
    draftRevisionDirectory(runId, snapshot.documentId),
    path.basename(revision.sourceFileName),
  )).catch(() => undefined)));
  await writeDraftWorkspace(runId, structuredClone(snapshot));
}

function invalidateActiveVisualQa(draft: OfficeDocumentDraft) {
  draft.visualQaArtifactId = undefined;
  draft.visualQaDigest = undefined;
  draft.visualQaPageCount = undefined;
  draft.visualQaSeenPages = [];
  draft.visualQaReviews = [];
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
  path: string;
  startLine: number;
};

const SOURCE_UNIT_START = /^\s*(?:#|\/\/)\s*@webpilot-unit\s+([A-Za-z0-9][A-Za-z0-9._/-]{0,159})\s*$/;
const SOURCE_UNIT_END = /^\s*(?:#|\/\/)\s*@webpilot-endunit\s*$/;

function normalizedSourceUnitPath(value: string | undefined) {
  const unitPath = String(value || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!unitPath || unitPath.includes('..') || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(unitPath)) {
    throw new Error('Office source unit path must be a relative path using letters, numbers, dot, underscore, slash, or hyphen.');
  }
  return unitPath;
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
    units.push({ path: unitPath, startLine: index + 2, endLine: endMarker, content: lines.slice(index + 1, endMarker).join('\n') });
    names.add(unitPath);
    index = endMarker;
  }
  return units;
}

function replaceSourceUnit(source: string, unit: ParsedSourceUnit, content: string) {
  const lines = normalizedDraftSource(source).split('\n');
  lines.splice(unit.startLine - 1, Math.max(0, unit.endLine - unit.startLine + 1), ...normalizedDraftSource(content).split('\n'));
  return lines.join('\n');
}

function isolateSourceUnit(source: string, requestedPath: string, generator: OfficeDocumentDraft['generator']) {
  const lines = normalizedDraftSource(source).split('\n');
  const units = parseSourceUnits(source);
  for (const unit of [...units].reverse()) {
    if (unit.path === requestedPath) continue;
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
  const units = parseSourceUnits(draft.program || '');
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

/**
 * Apply Code-Editor-style line replacements. Ranges are one-based and always
 * refer to the same source returned by action=read, so a batch cannot shift
 * the location of a later edit. Replacing from the last line upward keeps
 * those original coordinates stable.
 */
export function applyUnoDraftLineEdits(source: string, edits: UnoDraftLineEdit[]) {
  if (!Array.isArray(edits) || !edits.length) {
    throw new Error('file action=edit requires at least one line edit.');
  }
  const normalized = normalizedDraftSource(source);
  const textEdits = edits.filter((edit) => edit.kind === 'replaceText');
  if (textEdits.length) {
    if (textEdits.length !== edits.length) throw new Error('replaceText edits cannot be mixed with line edits in one atomic batch.');
    const replacements = textEdits.map((edit, editIndex) => {
      const oldText = normalizedDraftSource(String(edit.oldText || ''));
      if (!oldText) throw new Error(`source edit ${editIndex + 1} replaceText requires non-empty oldText.`);
      const offsets: number[] = [];
      let cursor = 0;
      while (cursor <= normalized.length - oldText.length) {
        const found = normalized.indexOf(oldText, cursor);
        if (found < 0) break;
        offsets.push(found);
        cursor = found + Math.max(1, oldText.length);
      }
      const occurrence = edit.occurrence === undefined ? undefined : Number(edit.occurrence);
      if (occurrence !== undefined && (!Number.isInteger(occurrence) || occurrence < 1)) {
        throw new Error(`source edit ${editIndex + 1} occurrence must be a positive integer.`);
      }
      if (!offsets.length) throw new Error(`source edit ${editIndex + 1} could not find oldText in the current source.`);
      if (occurrence === undefined && offsets.length !== 1) {
        throw new Error(`source edit ${editIndex + 1} oldText matched ${offsets.length} locations; provide occurrence or a larger exact source region.`);
      }
      const start = offsets[(occurrence || 1) - 1];
      if (start === undefined) throw new Error(`source edit ${editIndex + 1} occurrence ${occurrence} does not exist; found ${offsets.length} matches.`);
      return { start, end: start + oldText.length, newText: normalizedDraftSource(edit.newText), editIndex };
    });
    const ordered = [...replacements].sort((left, right) => left.start - right.start);
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index].start < ordered[index - 1].end) {
        throw new Error(`source edits ${ordered[index - 1].editIndex + 1} and ${ordered[index].editIndex + 1} overlap.`);
      }
    }
    let result = normalized;
    for (const edit of replacements.sort((left, right) => right.start - left.start)) {
      result = `${result.slice(0, edit.start)}${edit.newText}${result.slice(edit.end)}`;
    }
    return result;
  }
  const hasFinalNewline = normalized.endsWith('\n');
  const lines = hasFinalNewline ? normalized.slice(0, -1).split('\n') : normalized.split('\n');
  const lineCount = lines.length;
  const ordered = edits.map((edit, editIndex) => {
    const kind = edit.kind || 'replaceRange';
    const anchorLine = Number(edit.line);
    const startLine = kind === 'insertBefore' || kind === 'insertAfter' ? anchorLine : Number(edit?.startLine);
    const endLine = kind === 'insertBefore' || kind === 'insertAfter' ? anchorLine : Number(edit?.endLine);
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
      throw new Error(`source edit ${editIndex + 1} requires integer startLine and endLine from action=read.`);
    }
    if (startLine < 1 || endLine < startLine || endLine > lineCount) {
      throw new Error(`source edit ${editIndex + 1} range ${startLine}-${endLine} is outside the current 1-${lineCount} source lines. Read the draft again.`);
    }
    if (typeof edit.newText !== 'string') {
      throw new Error(`source edit ${editIndex + 1} requires string newText.`);
    }
    const currentLine = lines[startLine - 1];
    const newText = kind === 'deleteRange'
      ? ''
      : kind === 'insertBefore'
        ? `${edit.newText}${edit.newText.endsWith('\n') ? '' : '\n'}${currentLine}`
        : kind === 'insertAfter'
          ? `${currentLine}\n${edit.newText}`
          : edit.newText;
    return { ...edit, startLine, endLine, newText, editIndex };
  });
  const ascending = [...ordered].sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
  for (let index = 1; index < ascending.length; index += 1) {
    if (ascending[index].startLine <= ascending[index - 1].endLine) {
      throw new Error(`source edits ${ascending[index - 1].editIndex + 1} and ${ascending[index].editIndex + 1} overlap. Combine them into one line range.`);
    }
  }
  for (const edit of ordered.sort((left, right) => right.startLine - left.startLine)) {
    const replacement = normalizedDraftSource(edit.newText);
    const replacementLines = replacement === '' ? [] : replacement.split('\n');
    lines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...replacementLines);
  }
  return `${lines.join('\n')}${hasFinalNewline ? '\n' : ''}`;
}

export function applyUnoDraftPatch(source: string, patchText: string) {
  const normalized = normalizedDraftSource(source);
  const hasFinalNewline = normalized.endsWith('\n');
  const sourceLines = (hasFinalNewline ? normalized.slice(0, -1) : normalized).split('\n');
  const patchLines = normalizedDraftSource(String(patchText || '')).split('\n');
  const output: string[] = [];
  let sourceIndex = 0;
  let patchIndex = 0;
  let hunkCount = 0;
  while (patchIndex < patchLines.length) {
    const header = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(patchLines[patchIndex]);
    if (!header) {
      patchIndex += 1;
      continue;
    }
    hunkCount += 1;
    const oldStart = Number(header[1]) - 1;
    if (oldStart < sourceIndex || oldStart > sourceLines.length) throw new Error(`patch hunk ${hunkCount} has an invalid or overlapping source range.`);
    output.push(...sourceLines.slice(sourceIndex, oldStart));
    sourceIndex = oldStart;
    patchIndex += 1;
    while (patchIndex < patchLines.length && !patchLines[patchIndex].startsWith('@@ ')) {
      const line = patchLines[patchIndex];
      patchIndex += 1;
      if (line.startsWith('\\ No newline at end of file')) continue;
      const marker = line[0];
      const text = line.slice(1);
      if (marker === ' ' || marker === '-') {
        if (sourceLines[sourceIndex] !== text) {
          throw new Error(`patch hunk ${hunkCount} no longer matches source line ${sourceIndex + 1}. Read the current draft and regenerate the patch.`);
        }
        if (marker === ' ') output.push(text);
        sourceIndex += 1;
      } else if (marker === '+') {
        output.push(text);
      } else if (line === '') {
        // A trailing empty line outside a hunk is harmless.
      } else {
        throw new Error(`patch hunk ${hunkCount} contains an invalid line marker.`);
      }
    }
  }
  if (!hunkCount) throw new Error('file action=edit patch requires at least one unified diff hunk.');
  output.push(...sourceLines.slice(sourceIndex));
  return `${output.join('\n')}${hasFinalNewline ? '\n' : ''}`;
}

function numberedDraftSource(source: string) {
  const normalized = normalizedDraftSource(source);
  const lines = (normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized)
    .split('\n');
  return lines
    .map((line, index) => `${String(index + 1).padStart(5, ' ')} | ${line}`)
    .join('\n');
}

async function readUnoDraftUnlocked(input: ReadUnoDraftInput): Promise<BrowserActionResult> {
  try {
    const documentId = String(input.documentId || '').trim();
    if (!documentId) return { ok: false, actual: 'file action=read requires documentId when reading an Office source draft.' };
    const draft = await loadDraft(input.runId, documentId);
    if (!draft.program) return { ok: false, actual: `Office draft ${documentId} has no source yet; call action=generate first.` };
    const units = parseSourceUnits(draft.program);
    const requestedPath = input.path ? normalizedSourceUnitPath(input.path) : undefined;
    const requestedUnit = requestedPath ? units.find((unit) => unit.path === requestedPath) : undefined;
    if (requestedPath && !requestedUnit) {
      return { ok: false, actual: `Office source unit ${requestedPath} does not exist. Read the document without path to list available source units.` };
    }
    const readableSource = requestedUnit?.content ?? draft.program;
    return {
      ok: true,
      actual: JSON.stringify({
        kind: 'uno-draft',
        documentId: draft.documentId,
        documentType: draft.documentType,
        fileName: draft.fileName,
        operation: draft.operation || 'create',
        generator: draft.generator || 'javascript',
        sourceFileName: path.basename(draftProgramPath(input.runId, documentId, draft.generator)),
        sourceDocument: draft.sourceDocument ? {
          attachmentId: draft.sourceDocument.attachmentId,
          assetName: draft.sourceDocument.assetName,
          fileName: draft.sourceDocument.fileName,
        } : undefined,
        sourceDigest: sourceDigest(readableSource),
        documentSourceDigest: sourceDigest(draft.program),
        currentRevision: draft.currentRevision || null,
        validatedRevision: draft.validatedRevision || null,
        validatedSourceDigest: draft.validatedSourceDigest || null,
        validationStatus: draft.validationStatus || 'pending',
        validationDiagnostics: draft.validationDiagnostics || [],
        workflow: draft.workflow,
        revisions: (draft.revisions || []).map((revision) => ({
          revision: revision.revision,
          sourceDigest: revision.sourceDigest,
          createdAt: revision.createdAt,
        })),
        sourceUnitPath: requestedUnit?.path,
        sourceUnitGlobalLines: requestedUnit ? { startLine: requestedUnit.startLine, endLine: requestedUnit.endLine } : undefined,
        sourceUnits: units.map((unit) => ({
          path: unit.path,
          sourceDigest: sourceDigest(unit.content),
          lineCount: draftSourceLineCount(unit.content),
          status: draft.sourceUnits?.find((state) => state.path === unit.path)?.status || 'pending',
        })),
        lineCount: draftSourceLineCount(readableSource),
        program: numberedDraftSource(readableSource),
      }),
    };
  } catch (error) {
    return { ok: false, actual: `Office draft read failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function getUnoApi(input: UnoApiInput): Promise<BrowserActionResult> {
  try {
    const documentId = String(input.documentId || '').trim();
    if (!documentId) {
      return { ok: false, actual: 'file action=unoApi requires the documentId returned by action=plan, so the selected generator can be verified.' };
    }
    const draft = await loadDraft(input.runId, documentId);
    if ((draft.generator || 'javascript') === 'javascript') {
      return {
        ok: false,
        actual: `Document ${documentId} uses JavaScript generation. UNO API guidance is unavailable for this draft; call action=jsApi for ${draft.documentType} instead.`,
      };
    }
    if (!input.documentType || !input.target) return { ok: false, actual: 'file action=unoApi requires documentType and target.' };
    return {
      ok: true,
      actual: JSON.stringify({ kind: 'uno-api', sourceUnitGuidance: 'For large sources, optional # @webpilot-unit pages/slide-001 and # @webpilot-endunit markers allow path-scoped read/edit with local line numbers. Keep shared helpers outside page units.', ...(await inspectUnoApi({
        documentType: input.documentType,
        target: input.target,
        query: input.query,
        offset: input.offset,
        limit: input.limit,
      })) }),
    };
  } catch (error) {
    return { ok: false, actual: `UNO API inspection failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function getOfficeJsApi(
  input: Pick<UnoApiInput, 'runId' | 'documentId' | 'documentType'>,
): Promise<BrowserActionResult> {
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
  if ((draft.generator || 'javascript') !== 'javascript') {
    return {
      ok: false,
      actual: `Document ${documentId} uses UNO generation. JavaScript API guidance is unavailable for this draft; call action=unoApi instead.`,
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
        'For large sources, optional // @webpilot-unit pages/slide-001 and // @webpilot-endunit markers let later file read/edit calls use path="pages/slide-001" and local line numbers. Keep shared theme/helpers outside page units.',
        'Write the final editable Office file to job.outputPath, or use await job.writeOutput(buffer) for docx buffers.',
        'job.listAssets() returns objects shaped exactly as { name, bytes }, never strings. Read asset.name; never call split() on an asset object.',
        'Use the exact availableAssets/listAssets name without URL encoding, decoding, basename guessing, or invented prefixes, then call await job.assetPath(exactName).',
        'For DOCX images, read local bytes from await job.assetPath(exactName) and pass them to ImageRun. Do not pass a path string as ImageRun data.',
        'DOCX Table.rows must contain TableRow instances, and each TableRow.children must contain TableCell instances; plain nested arrays are invalid.',
        'Insert a DOCX page break with a PageBreak child inside a Paragraph.',
        'To inspect an already-downloaded image asset, call file action=read with its exact artifactId. That result reports dimensions and aspect ratio from the saved bytes; do not probe a remote thumbnail URL with browserCode.',
        'Do not fetch remote URLs from the draft; download assets with the file tool first.',
        'JavaScript mode creates PPTX, DOCX, or XLSX directly. A .pdf target is supported by creating the matching Office source for documentType and converting it with local LibreOffice.',
        'For PDF, still write to job.outputPath exactly as shown; its temporary extension is already the correct .pptx, .docx, or .xlsx source format.',
        'Existing-file modification remains UNO-based.',
        'A rejected action=edit candidate is rolled back to the previous working source. Use the returned lastSuccessfulRevision/recoverySuggestion, make a focused edit, and call action=read only when fresh line numbers are needed.',
      ],
      recipes,
      completeDocument: examples[documentType],
    }),
  };
}

type ValidatedDraftCandidate = {
  assets: DocumentAsset[];
  cacheHit: boolean;
  validation: Awaited<ReturnType<typeof validateOfficeArtifact>>;
  generated: {
    bytes: number;
    diagnostics?: unknown;
    extension: string;
    outputPath: string;
    previewPath?: string;
  };
};

function validationCachePaths(runId: string | undefined, draft: OfficeDocumentDraft, extension: string) {
  const digest = sourceDigest(draft.program || '');
  const base = path.join(
    artifactDir(runId, 'document-drafts'),
    `.${sanitizeFileName(draft.documentId, 'document')}.${digest}.validation`,
  );
  return {
    artifactPath: `${base}${extension}`,
    metadataPath: `${base}.json`,
    previewPath: `${base}.preview.pdf`,
  };
}

function documentAssetsFingerprint(assets: DocumentAsset[]) {
  return createHash('sha256').update(JSON.stringify({
    pipelineVersion: OFFICE_PIPELINE_VERSION,
    assets: assets.map((asset) => ({
    assetName: asset.assetName,
    bytes: asset.bytes,
    sha256: asset.sha256,
    origin: asset.origin,
    ref: asset.ref,
    })),
  }), 'utf8').digest('hex');
}

async function prepareValidatedDraftLegacy(input: {
  runId?: string;
  draft: OfficeDocumentDraft;
  attachmentBindings?: BrowserCodeAttachmentBinding[];
  abortSignal?: AbortSignal;
  onProgress?: (progress: FileGenerationProgress) => void | Promise<void>;
}): Promise<Omit<ValidatedDraftCandidate, 'validation'>> {
  if (!input.draft.program) throw new Error(`Office draft ${input.draft.documentId} has no source yet; call action=generate first.`);
  // Execute the candidate from an isolated source file. The committed
  // workspace is only replaced after every validation gate succeeds.
  await input.onProgress?.({ phase: 'assets', message: '正在同步文件素材' });
  const assets = await syncDocumentAssets(input.runId, input.attachmentBindings);
  const assetFingerprint = documentAssetsFingerprint(assets);
  const extension = path.extname(input.draft.fileName).toLowerCase();
  const cache = validationCachePaths(input.runId, input.draft, extension);
  try {
    const metadata = JSON.parse(await readFile(cache.metadataPath, 'utf8')) as { assetFingerprint?: string };
    if (metadata.assetFingerprint === assetFingerprint) {
      const artifactMetadata = await stat(cache.artifactPath);
      const previewMetadata = await stat(cache.previewPath).catch(() => undefined);
      return {
        assets,
        cacheHit: true,
        generated: {
          bytes: artifactMetadata.size,
          extension,
          outputPath: cache.artifactPath,
          previewPath: previewMetadata?.isFile() ? cache.previewPath : undefined,
        },
      };
    }
  } catch {
    // A missing or interrupted cache is not a document failure; regenerate it.
  }
  await input.onProgress?.({ phase: 'execute', message: '正在执行文档脚本' });
  const candidateSourcePath = path.join(
    artifactDir(input.runId, 'document-drafts'),
    `.candidate-${sanitizeFileName(input.draft.documentId, 'document')}-${randomUUID()}${input.draft.generator === 'javascript' ? '.mjs' : '.py'}`,
  );
  await writeFile(candidateSourcePath, input.draft.program, { encoding: 'utf8', flag: 'wx' });
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
    await writeFile(cache.metadataPath, JSON.stringify({ assetFingerprint }), 'utf8');
    return { assets, cacheHit: false, generated };
  } finally {
    await unlink(candidateSourcePath).catch(() => undefined);
  }
}

async function prepareValidatedDraft(input: {
  runId?: string;
  draft: OfficeDocumentDraft;
  attachmentBindings?: BrowserCodeAttachmentBinding[];
  abortSignal?: AbortSignal;
  onProgress?: (progress: FileGenerationProgress) => void | Promise<void>;
}): Promise<ValidatedDraftCandidate> {
  if (!input.draft.program) throw new Error(`Office draft ${input.draft.documentId} has no source yet; call action=generate first.`);
  try {
    input.draft.validationStatus = 'pending';
    input.draft.workflow = { state: 'validating', checkpointAt: new Date().toISOString() };
    await input.onProgress?.({ phase: 'static-analysis', message: '正在检查脚本语法和确定性错误' });
    const staticAnalysis = await analyzeOfficeProgram(input.draft.program, input.draft.generator || 'javascript');
    const parsedUnits = parseSourceUnits(input.draft.program);
    const staticDiagnostics = staticAnalysis.diagnostics.map((diagnostic) => {
      const unit = diagnostic.line
        ? parsedUnits.find((candidate) => diagnostic.line! >= candidate.startLine && diagnostic.line! <= candidate.endLine)
        : undefined;
      return unit ? { ...diagnostic, unitPath: unit.path } : diagnostic;
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
    let candidate = await prepareValidatedDraftLegacy(input);
    await input.onProgress?.({ phase: 'artifact-validation', message: '正在执行统一 Office、字体和嵌入图片检查' });
    let validation = await validateOfficeArtifact({
      absolutePath: candidate.generated.outputPath,
      extension: candidate.generated.extension,
    });
    if (!validation.passed && candidate.cacheHit) {
      const cache = validationCachePaths(input.runId, input.draft, candidate.generated.extension);
      await Promise.all([
        unlink(cache.artifactPath).catch(() => undefined),
        unlink(cache.metadataPath).catch(() => undefined),
        unlink(cache.previewPath).catch(() => undefined),
      ]);
      candidate = await prepareValidatedDraftLegacy(input);
      validation = await validateOfficeArtifact({
        absolutePath: candidate.generated.outputPath,
        extension: candidate.generated.extension,
      });
    }
    if (!validation.passed) {
      const error = new Error(validation.issues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => issue.message)
        .join('\n'));
      Object.assign(error, { diagnostics: validation.issues });
      throw error;
    }
    input.draft.validationStatus = 'passed';
    input.draft.validatedSourceDigest = sourceDigest(input.draft.program);
    input.draft.validationDiagnostics = [
      ...staticDiagnostics,
      ...validation.issues.map((issue) => ({ code: issue.code, message: issue.message, severity: issue.severity })),
    ];
    synchronizeSourceUnits(input.draft, 'passed');
    input.draft.workflow = { state: 'render-ready', checkpointAt: new Date().toISOString() };
    await saveDraft(input.runId, input.draft);
    input.draft.validatedRevision = input.draft.currentRevision;
    await writeDraftWorkspace(input.runId, input.draft);
    return { ...candidate, validation };
  } catch (error) {
    const diagnostics = error && typeof error === 'object' && 'diagnostics' in error
      ? (error as { diagnostics?: OfficeProgramDiagnostic[] }).diagnostics
      : undefined;
    input.draft.validationStatus = 'failed';
    input.draft.validationDiagnostics = diagnostics || [{
      message: error instanceof Error ? error.message : String(error),
      severity: 'error',
    }];
    synchronizeSourceUnits(input.draft, 'failed');
    input.draft.workflow = {
      state: 'authoring',
      checkpointAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
    throw error;
  }
}

async function validateDraft(input: {
  runId?: string;
  draft: OfficeDocumentDraft;
  includeVisualVerification?: boolean;
  documentChanged?: boolean;
  attachmentBindings?: BrowserCodeAttachmentBinding[];
  abortSignal?: AbortSignal;
  onProgress?: (progress: FileGenerationProgress) => void | Promise<void>;
}): Promise<BrowserActionResult> {
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
      ? await renderBrowserChatAttachmentVisuals({
          absolutePath: candidate.generated.previewPath!,
          cacheKey: `${sourceDigest(input.draft.program || '')}:validation`,
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
        fileName: input.draft.fileName,
        generator: input.draft.generator || 'javascript',
        sourceDigest: sourceDigest(input.draft.program || ''),
        sourceCharacters: input.draft.program?.length || 0,
        currentRevision: input.draft.currentRevision || null,
        validatedRevision: input.draft.validatedRevision || null,
        validationStatus: input.draft.validationStatus,
        documentChanged: input.documentChanged || false,
        cacheHit: candidate.cacheHit,
        generationDiagnostics: candidate.generated.diagnostics,
        automaticValidation: candidate.validation,
        workflow: input.draft.workflow,
        qualityGate: {
          structural: true,
          visual: visualVerification ? {
            previewGenerated: visualVerification.imagePaths.length > 0,
            modelReviewRequired: true,
            previewPages: visualVerification.renderedPages,
            fullReviewStatus: 'pending',
          } : { status: 'not-performed' },
        },
      }),
      referenceImagePaths: visualVerification?.imagePaths.length ? visualVerification.imagePaths : undefined,
    };
  } catch (error) {
    const source = input.draft.program || '';
    return {
      ok: false,
      actual: JSON.stringify({
        kind: 'uno-draft-validation',
        documentId: input.draft.documentId,
        fileName: input.draft.fileName,
        generator: input.draft.generator || 'javascript',
        changed: input.documentChanged || false,
        saved: false,
        sourceDigest: sourceDigest(source),
        sourceCharacters: source.length,
        currentRevision: input.draft.currentRevision || null,
        validatedRevision: input.draft.validatedRevision || null,
        lineCount: draftSourceLineCount(source),
        validation: 'failed',
        requiredNextAction: 'read',
        diagnostics: input.draft.validationDiagnostics || [],
        error: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}

async function validateDraftSourceUnit(input: {
  runId?: string;
  draft: OfficeDocumentDraft;
  sourceUnitPath: string;
  includeVisualVerification?: boolean;
  attachmentBindings?: BrowserCodeAttachmentBinding[];
  abortSignal?: AbortSignal;
  onProgress?: (progress: FileGenerationProgress) => void | Promise<void>;
}): Promise<BrowserActionResult> {
  const extension = path.extname(input.draft.fileName).toLowerCase();
  const suffix = randomUUID();
  const directory = artifactDir(input.runId, 'document-drafts');
  const sourcePath = path.join(directory, `.unit-${suffix}${input.draft.generator === 'javascript' ? '.mjs' : '.py'}`);
  const outputPath = path.join(directory, `.unit-${suffix}${extension}`);
  const previewPath = path.join(directory, `.unit-${suffix}.preview.pdf`);
  try {
    if (!input.draft.program) throw new Error('The Office draft has no working source.');
    const unit = parseSourceUnits(input.draft.program).find((candidate) => candidate.path === input.sourceUnitPath);
    if (!unit) throw new Error(`Office source unit ${input.sourceUnitPath} does not exist.`);
    const isolatedSource = isolateSourceUnit(input.draft.program, input.sourceUnitPath, input.draft.generator);
    await input.onProgress?.({ phase: 'unit-static-analysis', message: `正在检查 ${input.sourceUnitPath}` });
    const staticAnalysis = await analyzeOfficeProgram(isolatedSource, input.draft.generator || 'javascript');
    if (!staticAnalysis.passed) {
      const error = new Error(staticAnalysis.diagnostics.filter((item) => item.severity === 'error').map((item) => item.message).join('\n'));
      Object.assign(error, { diagnostics: staticAnalysis.diagnostics });
      throw error;
    }
    await mkdir(directory, { recursive: true });
    await writeFile(sourcePath, isolatedSource, 'utf8');
    const assets = await syncDocumentAssets(input.runId, input.attachmentBindings);
    await input.onProgress?.({ phase: 'unit-execute', message: `正在隔离执行 ${input.sourceUnitPath}` });
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
    const validation = await validateOfficeArtifact({ absolutePath: generated.outputPath, extension: generated.extension });
    if (!validation.passed) {
      const error = new Error(validation.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message).join('\n'));
      Object.assign(error, { diagnostics: validation.issues });
      throw error;
    }
    const needsVisuals = Boolean(input.includeVisualVerification && generated.previewPath);
    const visualVerification = needsVisuals
      ? await renderBrowserChatAttachmentVisuals({
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
    input.draft.validationDiagnostics = [
      ...staticAnalysis.diagnostics.map((diagnostic) => ({ ...diagnostic, unitPath: input.sourceUnitPath })),
      ...validation.issues.map((issue) => ({ code: issue.code, message: issue.message, severity: issue.severity, unitPath: input.sourceUnitPath })),
    ];
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
        renderable: input.draft.validatedSourceDigest === sourceDigest(input.draft.program),
        currentRevision: input.draft.currentRevision || null,
        assets: assets.map(describeDocumentAsset),
        automaticValidation: validation,
        automaticVisualChecks: visualVerification?.automaticChecks || [],
        requiredNextAction: 'Continue editing other units, or call render for final full-document validation and publication.',
      }),
      referenceImagePaths: visualVerification?.imagePaths.length ? visualVerification.imagePaths : undefined,
    };
  } catch (error) {
    const state = input.draft.sourceUnits?.find((item) => item.path === input.sourceUnitPath);
    if (state) {
      state.validatedDigest = undefined;
      state.status = 'failed';
    }
    const diagnostics = error && typeof error === 'object' && 'diagnostics' in error
      ? (error as { diagnostics?: OfficeProgramDiagnostic[] }).diagnostics
      : undefined;
    input.draft.validationStatus = 'failed';
    input.draft.validationDiagnostics = (diagnostics || [{ message: error instanceof Error ? error.message : String(error), severity: 'error' as const }])
      .map((diagnostic) => ({ ...diagnostic, unitPath: input.sourceUnitPath }));
    input.draft.workflow = { state: 'authoring', checkpointAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) };
    return {
      ok: false,
      actual: JSON.stringify({
        kind: 'office-source-unit-validation',
        documentId: input.draft.documentId,
        sourceUnitPath: input.sourceUnitPath,
        validation: 'failed',
        saved: false,
        renderable: false,
        diagnostics: input.draft.validationDiagnostics,
        error: error instanceof Error ? error.message : String(error),
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
  attachmentBindings?: BrowserCodeAttachmentBinding[];
  abortSignal?: AbortSignal;
  onProgress?: (progress: FileGenerationProgress) => void | Promise<void>;
}): Promise<BrowserActionResult> {
  let publishCandidatePath: string | undefined;
  try {
    const candidate = await prepareValidatedDraft(input);
    const digest = sourceDigest(input.draft.program || '');
    if (input.draft.validatedSourceDigest !== digest || input.draft.validationStatus !== 'passed') {
      throw new Error('The working source has not passed validation and cannot be rendered. Continue editing the saved working revision until validation passes.');
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
      ? await renderBrowserChatAttachmentVisuals({
          absolutePath: candidate.generated.previewPath!,
          cacheKey: `${digest}:render`,
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
    await input.onProgress?.({ phase: 'publish', message: '正在发布最终文件' });
    publishCandidatePath = path.join(dir, `.render-${randomUUID()}${candidate.generated.extension}`);
    await copyFile(candidate.generated.outputPath, publishCandidatePath);
    await rename(publishCandidatePath, target.filePath);
    publishCandidatePath = undefined;
    const artifact = artifactResultPayload({
      kind: 'generated',
      fileName: target.fileName,
      filePath: target.filePath,
      bytes: candidate.generated.bytes,
    });
    input.draft.renderedArtifactId = artifact.artifactId;
    input.draft.renderedFileName = target.fileName;
    input.draft.renderedSourceDigest = digest;
    input.draft.renderedDigest = digest;
    input.draft.visualQaArtifactId = undefined;
    input.draft.visualQaDigest = undefined;
    input.draft.visualQaPageCount = undefined;
    input.draft.visualQaSeenPages = [];
    input.draft.visualQaReviews = [];
    input.draft.visualQaPageDigests = [];
    input.draft.workflow = {
      state: visualVerification ? 'qa-pending' : 'completed',
      checkpointAt: new Date().toISOString(),
      renderedDigest: digest,
    };
    await saveDraft(input.runId, input.draft);

    return {
      ok: true,
      actual: JSON.stringify({
        ...artifact,
        documentId: input.draft.documentId,
        sourceDigest: digest,
        renderedDigest: digest,
        currentRevision: input.draft.currentRevision || null,
        documentChanged: input.documentChanged || false,
        cacheHit: candidate.cacheHit,
        availableAssets: candidate.assets.map(describeDocumentAsset),
        generationDiagnostics: candidate.generated.diagnostics,
        automaticValidation: candidate.validation,
        workflow: input.draft.workflow,
        qualityGate: {
          structural: true,
          visual: visualVerification ? {
            previewGenerated: visualVerification.imagePaths.length > 0,
            modelReviewRequired: true,
            previewPages: visualVerification.renderedPages,
            fullReviewStatus: 'pending',
          } : {
            status: 'not-performed',
            reason: 'The selected model does not accept image input; this result is structurally verified only.',
          },
        },
        visualVerification: visualVerification ? {
          imageCount: visualVerification.imagePaths.length,
          pageCount: visualVerification.pageCount,
          renderedPages: visualVerification.renderedPages,
          renderer: visualVerification.renderer,
          warning: visualVerification.warning,
          automaticChecks: visualVerification.automaticChecks || [],
          gateStatus: 'pending-model-review',
          requiredCondition: 'visualQaDigest === renderedDigest, every indexed page has been read, and every page has an explicit passed review',
        } : {
          status: 'not-performed',
          reason: 'The selected model does not accept image input or the generated format has no page renderer; no visual conclusion was made.',
        },
      }),
      referenceImagePaths: visualVerification?.imagePaths.length ? visualVerification.imagePaths : undefined,
    };
  } catch (error) {
    return { ok: false, actual: `file rendering failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (publishCandidatePath) await unlink(publishCandidatePath).catch(() => undefined);
  }
}

async function planFileArtifactUnlocked(input: PlanArtifactInput): Promise<BrowserActionResult> {
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
    const requestedFileName = sanitizeFileName(input.fileName, `document-${Date.now()}.pdf`);
    const assets = await syncDocumentAssets(input.runId, input.attachmentBindings);
    const sourcePlan = await plannedSourceDocument(input, assets);
    const generator = configuredOfficeGenerator(requestedFileName, sourcePlan.operation);
    try {
      const existing = await loadDraft(input.runId, documentId);
      if (existing.documentType !== input.documentType) {
        return {
          ok: false,
          actual: `documentId ${documentId} already belongs to a ${existing.documentType} document. Reuse it only for that logical document or choose a different stable documentId for a genuinely different output.`,
        };
      }
      if (!existing.program && !existing.renderedFileName) {
        existing.fileName = requestedFileName;
        existing.intent = input.intent ?? existing.intent;
        existing.operation = sourcePlan.operation;
        existing.generator = generator;
        existing.sourceDocument = sourcePlan.sourceDocument;
        await saveDraft(input.runId, existing);
      }
      return {
        ok: true,
        actual: JSON.stringify({
          kind: 'document-plan',
          documentId: existing.documentId,
          fileName: existing.fileName,
          documentType: existing.documentType,
          operation: existing.operation || 'create',
          generator: existing.generator || 'javascript',
          sourceDocument: existing.sourceDocument,
          sourceFileName: path.basename(draftProgramPath(input.runId, existing.documentId, existing.generator)),
          sourceCharacters: existing.program?.length || 0,
          workflow: existing.workflow,
          reused: true,
        }),
      };
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code || '')
        : '';
      if (code !== 'ENOENT') throw error;
    }
    const now = new Date().toISOString();
    const draft: OfficeDocumentDraft = {
      createdAt: now,
      documentId,
      documentType: input.documentType,
      fileName: requestedFileName,
      intent: input.intent,
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
      workflow: draft.workflow,
      instruction: draft.operation === 'modify'
        ? `Open the existing file with job.open_document(${JSON.stringify(draft.sourceDocument?.assetName)}), edit that component in place, and save it to job.output_url. Do not recreate the document.`
        : undefined,
    }) };
  } catch (error) {
    return { ok: false, actual: `file planning failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function generateUnoFileArtifactUnlocked(input: GenerateUnoProgramInput): Promise<BrowserActionResult> {
  try {
    const documentId = String(input.documentId || '').trim();
    if (!documentId) return { ok: false, actual: 'file action=generate requires documentId from action=plan.' };
    const program = String(input.program || '').trim();
    if (!program) return { ok: false, actual: 'file action=generate requires a runnable source draft in program. A small validated skeleton followed by action=edit is recommended, but a complete runnable initial program is also allowed.' };
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
    if (persistedDraft.program) {
      return {
        ok: false,
        actual: `Office draft ${documentId} already has source. Do not send another complete program. Use action=read only when the current source is unknown, then action=edit with line-range edits=[{startLine,endLine,newText}]. The edit is saved and validated before action=render publishes it.`,
      };
    }
    const draft = structuredClone(persistedDraft);
    draft.program = program;
    draft.validationStatus = 'pending';
    draft.validationDiagnostics = [];
    draft.workflow = { state: 'authoring', checkpointAt: new Date().toISOString() };
    // Generation is a candidate transaction. A failed first program leaves the
    // committed draft in its planned state so a retry starts from clean data.
    return validateDraft({ ...input, draft, documentChanged: true });
  } catch (error) {
    return { ok: false, actual: `Office source generation failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function editUnoFileArtifactUnlocked(input: EditUnoProgramInput): Promise<BrowserActionResult> {
  try {
    const documentId = String(input.documentId || '').trim();
    if (!documentId) return { ok: false, actual: 'file action=edit requires documentId.' };
    if (typeof input.program === 'string' && input.program.trim()) {
      return {
        ok: false,
        actual: 'file action=edit does not accept a complete source replacement. Read the current line-numbered draft when needed and send edits=[{startLine,endLine,newText}].',
      };
    }
    const persistedDraft = await loadDraft(input.runId, documentId);
    if (!persistedDraft.program) return { ok: false, actual: `Office draft ${documentId} has no program yet; call action=generate first.` };
    const requestedPath = input.path ? normalizedSourceUnitPath(input.path) : undefined;
    const sourceUnits = parseSourceUnits(persistedDraft.program);
    const requestedUnit = requestedPath ? sourceUnits.find((unit) => unit.path === requestedPath) : undefined;
    if (requestedPath && !requestedUnit) {
      return { ok: false, actual: `Office source unit ${requestedPath} does not exist. Read the document without path to list available units.` };
    }
    if (requestedPath && input.restoreRevision !== undefined) {
      return { ok: false, actual: 'restoreRevision restores the complete document source and cannot be scoped to one source unit path.' };
    }
    const editableSource = requestedUnit?.content ?? persistedDraft.program;
    const currentDigest = sourceDigest(editableSource);
    const draft = structuredClone(persistedDraft);
    if (input.restoreRevision !== undefined) {
      const revisionNumber = Number(input.restoreRevision);
      const revision = persistedDraft.revisions?.find((item) => item.revision === revisionNumber);
      if (!Number.isInteger(revisionNumber) || revisionNumber < 1 || !revision) {
        return {
          ok: false,
          actual: `Office draft ${documentId} has no revision ${input.restoreRevision}. Read the draft to obtain the available revision numbers.`,
        };
      }
      const revisionPath = path.join(draftRevisionDirectory(input.runId, documentId), path.basename(revision.sourceFileName));
      draft.program = await readFile(revisionPath, 'utf8');
    } else {
      if (typeof input.patch === 'string' && input.patch.trim()) {
        if (input.edits?.length) return { ok: false, actual: 'file action=edit accepts patch or edits, not both in one atomic call.' };
        const edited = applyUnoDraftPatch(editableSource, input.patch);
        draft.program = requestedUnit ? replaceSourceUnit(persistedDraft.program, requestedUnit, edited) : edited;
      } else {
        if (!Array.isArray(input.edits) || !input.edits.length) {
          return { ok: false, actual: 'file action=edit requires edits, patch, or restoreRevision.' };
        }
        const edited = applyUnoDraftLineEdits(editableSource, input.edits);
        draft.program = requestedUnit ? replaceSourceUnit(persistedDraft.program, requestedUnit, edited) : edited;
      }
    }
    if (draft.program === normalizedDraftSource(persistedDraft.program)) {
      return {
        ok: true,
        actual: JSON.stringify({
          kind: 'uno-draft-edit',
          documentId,
          fileName: draft.fileName,
          changed: false,
          saved: false,
          sourceCharacters: draft.program.length,
          sourceDigest: currentDigest,
          sourceUnitPath: requestedUnit?.path,
          lineCount: draftSourceLineCount(editableSource),
          validation: 'unchanged',
        }),
      };
    }
    draft.validationStatus = 'pending';
    draft.validationDiagnostics = [];
    invalidateActiveVisualQa(draft);
    draft.workflow = { state: 'authoring', checkpointAt: new Date().toISOString() };
    // Validate a candidate transactionally. A rejected edit must not poison
    // the next edit with broken syntax or stale line coordinates.
    const validationResult = await (requestedUnit
      ? validateDraftSourceUnit({ ...input, draft, sourceUnitPath: requestedUnit.path })
      : validateDraft({ ...input, draft, documentChanged: true }));
    if (!validationResult.ok) {
      const rejectedSourceDigest = sourceDigest(draft.program || '');
      const rejectedDiagnostics = draft.validationDiagnostics || [];
      await restoreDraftSnapshot(input.runId, persistedDraft, draft);
      let failure: Record<string, unknown> = {};
      try {
        failure = JSON.parse(String(validationResult.actual || '{}')) as Record<string, unknown>;
      } catch {
        failure = { error: validationResult.actual || 'validation failed' };
      }
      return {
        ok: false,
        actual: JSON.stringify({
          ...failure,
          changed: false,
          candidateChanged: true,
          saved: false,
          rolledBack: true,
          rejectedSourceDigest,
          rejectedRevision: null,
          sourceDigest: sourceDigest(persistedDraft.program || ''),
          sourceCharacters: persistedDraft.program?.length || 0,
          currentRevision: persistedDraft.currentRevision || null,
          lastSuccessfulRevision: persistedDraft.validatedRevision || persistedDraft.currentRevision || null,
          diagnostics: failure.diagnostics || rejectedDiagnostics,
          validation: 'failed',
          requiredNextAction: 'edit',
          recoverySuggestion: 'The rejected candidate was rolled back. Continue from the current draft with a smaller focused edit; call action=read only if you need fresh line numbers, or use restoreRevision from the returned revision history.',
          workflow: persistedDraft.workflow,
        }),
      };
    }
    return validationResult;
  } catch (error) {
    return { ok: false, actual: `Office draft edit failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function verifyCurrentUnoRenderedArtifact(input: {
  runId?: string;
  artifactId: string;
}): Promise<BrowserActionResult> {
  try {
    const normalized = String(input.artifactId || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const segments = normalized.split('/').filter(Boolean);
    const generatedIndex = segments.indexOf('generated');
    // Downloads, template fills, and legacy flat generated artifacts do not
    // carry a UNO source version in their Artifact ID.
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
          renderedSourceDigest: renderedDigest,
          currentSourceDigest: currentDigest,
          requiredNextAction: 'render',
          error: 'This artifact does not represent the current source draft. Render the current documentId and use the new Artifact ID.',
        }),
      };
    }
    return { ok: true, actual: JSON.stringify({ kind: 'current-file-visual-artifact', documentId, sourceDigest: currentDigest }) };
  } catch (error) {
    return { ok: false, actual: `fileVisual version check failed: ${error instanceof Error ? error.message : String(error)}` };
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
  result: BrowserActionResult;
}): Promise<BrowserActionResult> {
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
        issues?: Array<{ type?: string; description?: string; region?: string; severity?: 'error' | 'warning' }>;
      }>;
    };
    return await withDraftLock(input.runId, identity.documentId, async () => {
      const draft = await loadDraft(input.runId, identity.documentId);
      if (draft.renderedArtifactId !== identity.artifactId || (draft.renderedDigest || draft.renderedSourceDigest) !== identity.renderedDigest) {
        return { ok: false, actual: 'fileVisual QA progress rejected because the rendered artifact is no longer current.' };
      }
      if (draft.visualQaArtifactId !== identity.artifactId) {
        draft.visualQaArtifactId = identity.artifactId;
        draft.visualQaDigest = undefined;
        draft.visualQaPageCount = undefined;
        draft.visualQaSeenPages = [];
        draft.visualQaReviews = [];
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
              if (cached?.status === 'passed') reviewed.set(page, { pageNumber: page, status: 'passed', issues: [] });
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
            return { ok: false, actual: `fileVisual review rejected: page ${pageNumber || '?'} has not been read from the current artifact.` };
          }
          const issues = (review.issues || []).map((issue) => ({
            type: String(issue.type || '').trim(),
            description: String(issue.description || '').trim(),
            ...(issue.region ? { region: String(issue.region).trim() } : {}),
            ...(issue.severity ? { severity: issue.severity } : {}),
          })).filter((issue) => issue.type && issue.description);
          if (review.status === 'passed' && issues.length) return { ok: false, actual: `fileVisual review rejected: passed page ${pageNumber} contains issues.` };
          if (review.status === 'failed' && !issues.length) return { ok: false, actual: `fileVisual review rejected: failed page ${pageNumber} requires issue details.` };
          if (review.status !== 'passed' && review.status !== 'failed') return { ok: false, actual: `fileVisual review rejected: page ${pageNumber} requires status passed or failed.` };
          reviewed.set(pageNumber, { pageNumber, status: review.status, issues });
        }
        draft.visualQaReviews = [...reviewed.values()].sort((left, right) => left.pageNumber - right.pageNumber);
        const cache = new Map((draft.visualQaReviewCache || []).map((review) => [review.screenshotDigest, review]));
        const pageDigests = new Map((draft.visualQaPageDigests || []).map((item) => [item.pageNumber, item.screenshotDigest]));
        for (const review of draft.visualQaReviews) {
          const screenshotDigest = pageDigests.get(review.pageNumber);
          if (screenshotDigest) cache.set(screenshotDigest, { screenshotDigest, status: review.status, issues: review.issues });
        }
        draft.visualQaReviewCache = [...cache.values()].slice(-1_000);
      }
      const pageCount = draft.visualQaPageCount || 0;
      const completeCoverage = pageCount > 0
        && Array.from({ length: pageCount }, (_, index) => index + 1).every((page) => draft.visualQaSeenPages?.includes(page));
      const reviews = new Map((draft.visualQaReviews || []).map((review) => [review.pageNumber, review]));
      const completePassingReview = pageCount > 0
        && Array.from({ length: pageCount }, (_, index) => reviews.get(index + 1)?.status === 'passed');
      draft.visualQaDigest = completeCoverage && completePassingReview ? identity.renderedDigest : undefined;
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
            complete: draft.visualQaDigest === identity.renderedDigest && completeCoverage && completePassingReview,
          },
        }),
      };
    });
  } catch (error) {
    return { ok: false, actual: `fileVisual QA state update failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function pendingOfficeVisualQa(runId?: string, artifactIds?: ReadonlySet<string>) {
  const directory = artifactDir(runId, 'document-drafts');
  const entries = await visibleFiles(directory);
  const pending: Array<{
    documentId: string;
    artifactId: string;
    renderedDigest: string;
    visualQaDigest?: string;
    pageCount: number;
    seenPageCount: number;
    reviewedPageCount: number;
    failedPages: number[];
  }> = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.json') || entry.name.endsWith('.transaction.json')) continue;
    try {
      const draft = JSON.parse(await readFile(path.join(directory, entry.name), 'utf8')) as OfficeDocumentDraft;
      const renderedDigest = draft.renderedDigest || draft.renderedSourceDigest;
      if (!draft.renderedArtifactId || !renderedDigest) continue;
      if (artifactIds && !artifactIds.has(draft.renderedArtifactId)) continue;
      const pageCount = draft.visualQaPageCount || 0;
      const seen = new Set(draft.visualQaSeenPages || []);
      const completeCoverage = pageCount > 0 && Array.from({ length: pageCount }, (_, index) => seen.has(index + 1));
      const reviews = new Map((draft.visualQaReviews || []).map((review) => [review.pageNumber, review]));
      const completePassingReview = pageCount > 0
        && Array.from({ length: pageCount }, (_, index) => reviews.get(index + 1)?.status === 'passed');
      if (draft.visualQaArtifactId !== draft.renderedArtifactId
        || draft.visualQaDigest !== renderedDigest
        || !completeCoverage
        || !completePassingReview) {
        pending.push({
          documentId: draft.documentId,
          artifactId: draft.renderedArtifactId,
          renderedDigest,
          visualQaDigest: draft.visualQaDigest,
          pageCount,
          seenPageCount: seen.size,
          reviewedPageCount: reviews.size,
          failedPages: Array.from(reviews.values())
            .filter((review) => review.status === 'failed')
            .map((review) => review.pageNumber),
        });
      }
    } catch {
      // Ignore unrelated/corrupt sidecars; loadDraft reports them when addressed.
    }
  }
  return pending;
}

async function renderFileArtifactUnlocked(input: RenderArtifactInput): Promise<BrowserActionResult> {
  try {
    const documentId = String(input.documentId || '').trim();
    if (!documentId) return { ok: false, actual: 'file action=render requires documentId.' };
    const draft = await loadDraft(input.runId, documentId);
    return renderDraft({ ...input, draft });
  } catch (error) {
    return { ok: false, actual: `file rendering failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function readUnoDraft(input: ReadUnoDraftInput): Promise<BrowserActionResult> {
  try {
    const documentId = requireDocumentId(input.documentId, 'read');
    return await withDraftLock(input.runId, documentId, () => readUnoDraftUnlocked({ ...input, documentId }));
  } catch (error) {
    return { ok: false, actual: `Office draft read failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function planFileArtifact(input: PlanArtifactInput): Promise<BrowserActionResult> {
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

export async function generateUnoFileArtifact(input: GenerateUnoProgramInput): Promise<BrowserActionResult> {
  try {
    const documentId = requireDocumentId(input.documentId, 'generate');
    return await withDraftLock(input.runId, documentId, () => generateUnoFileArtifactUnlocked({ ...input, documentId }), input.abortSignal);
  } catch (error) {
    return { ok: false, actual: `Office source generation failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function editUnoFileArtifact(input: EditUnoProgramInput): Promise<BrowserActionResult> {
  try {
    const documentId = requireDocumentId(input.documentId, 'edit');
    return await withDraftLock(input.runId, documentId, () => editUnoFileArtifactUnlocked({ ...input, documentId }), input.abortSignal);
  } catch (error) {
    return { ok: false, actual: `Office draft edit failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function renderFileArtifact(input: RenderArtifactInput): Promise<BrowserActionResult> {
  try {
    const documentId = requireDocumentId(input.documentId, 'render');
    return await withDraftLock(input.runId, documentId, () => renderFileArtifactUnlocked({ ...input, documentId }), input.abortSignal);
  } catch (error) {
    return { ok: false, actual: `file rendering failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function fillDocumentTemplateArtifact(input: FillDocumentTemplateArtifactInput): Promise<BrowserActionResult> {
  try {
    const templateAttachmentId = String(input.templateAttachmentId || '').trim();
    const binding = input.attachmentBindings?.find((item) => item.ref === templateAttachmentId);
    if (!binding) {
      return { ok: false, actual: 'fillDocumentTemplate failed: templateAttachmentId is not a registered attachment in this conversation.' };
    }
    if (path.extname(binding.name).toLowerCase() !== '.docx') {
      return { ok: false, actual: 'fillDocumentTemplate failed: the registered template must be a .docx file.' };
    }
    const operations = Array.isArray(input.operations) ? input.operations : [];
    if (!operations.length) {
      return { ok: false, actual: 'fillDocumentTemplate failed: at least one fill operation is required.' };
    }
    const metadata = await stat(binding.path);
    if (metadata.size > FILE_DOWNLOAD_MAX_BYTES) {
      return { ok: false, actual: `fillDocumentTemplate failed: template exceeds ${FILE_DOWNLOAD_MAX_BYTES} bytes.` };
    }
    const requestedName = sanitizeFileName(
      input.fileName || binding.name.replace(/\.docx$/i, '-filled.docx'),
      `filled-document-${Date.now()}.docx`,
    );
    if (path.extname(requestedName).toLowerCase() !== '.docx') {
      return { ok: false, actual: 'fillDocumentTemplate failed: fileName must end with .docx.' };
    }
    const filled = await fillDocxTemplateBuffer(await readFile(binding.path), operations);
    const dir = artifactDir(input.runId, 'generated');
    await mkdir(dir, { recursive: true });
    const target = await uniqueArtifactPath(dir, requestedName);
    await writeFile(target.filePath, filled.buffer);
    const visualVerification = input.includeVisualVerification
      ? await renderBrowserChatAttachmentVisuals({
          absolutePath: target.filePath,
          buffer: filled.buffer,
          extension: '.docx',
          name: target.fileName,
          previewRoot: artifactDir(input.runId, 'attachment-previews'),
        })
      : undefined;
    return {
      ok: true,
      actual: JSON.stringify({
        ...artifactResultPayload({
          kind: 'generated',
          fileName: target.fileName,
          filePath: target.filePath,
          bytes: filled.buffer.byteLength,
        }),
        templateValidation: {
          changedParts: filled.changedParts,
          filledOperations: filled.filledOperations,
          preservedParts: filled.preservedParts,
        },
        visualVerification: visualVerification ? {
          imageCount: visualVerification.imagePaths.length,
          pageCount: visualVerification.pageCount,
          renderedPages: visualVerification.renderedPages,
          renderer: visualVerification.renderer,
          warning: visualVerification.warning,
        } : {
          status: 'not-performed',
          reason: 'The selected model does not accept image input; no visual conclusion was made.',
        },
      }),
      referenceImagePaths: visualVerification?.imagePaths.length ? visualVerification.imagePaths : undefined,
    };
  } catch (error) {
    return { ok: false, actual: `fillDocumentTemplate failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function verifiedArtifactDownloadUrl(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value, 'http://webpilot.local');
    if (!url.pathname.includes('/api/artifacts/') || url.searchParams.get('download') !== '1') return undefined;
    return value.trim();
  } catch {
    return undefined;
  }
}

export function fileArtifactDownloadFromToolResult(tool: FileArtifactToolResult): FileArtifactDownload | undefined {
  if (tool.name !== 'file' && tool.name !== 'downloadFile' && tool.name !== 'generateFile' && tool.name !== 'fillDocumentTemplate') return undefined;
  if (!tool.result || typeof tool.result !== 'object' || !('ok' in tool.result) || tool.result.ok !== true) return undefined;
  try {
    const actual = 'actual' in tool.result && typeof tool.result.actual === 'string'
      ? tool.result.actual
      : '{}';
    const payload = JSON.parse(actual) as ArtifactToolPayload;
    const artifactId = String(payload.artifactId || '').trim();
    const fileName = String(payload.fileName || '').trim();
    const downloadUrl = verifiedArtifactDownloadUrl(payload.downloadUrl);
    if (
      !artifactId
      || !fileName
      || !downloadUrl
      || artifactId.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    ) return undefined;
    return { artifactId, downloadUrl, fileName };
  } catch {
    return undefined;
  }
}

function artifactMarkdownUrl(value: string) {
  try {
    const url = new URL(value, 'http://webpilot.local');
    return url.pathname.includes('/api/artifacts/');
  } catch {
    return false;
  }
}

function normalizedMarkdownLinkLabel(value: string) {
  return value
    .replace(/\\([\[\]\\])/g, '$1')
    .replace(/[*_`]/g, '')
    .trim();
}

function repairArtifactDownloadLinks(reply: string, downloads: FileArtifactDownload[]) {
  if (!downloads.length) return reply;
  return reply.replace(/(!?)\[([^\]\r\n]*)\]\(([^)\s]+)([^)\r\n]*)\)/g, (full, imagePrefix, label, href) => {
    if (imagePrefix || !artifactMarkdownUrl(href)) return full;
    const normalizedLabel = normalizedMarkdownLinkLabel(label);
    const exactUrl = downloads.find((item) => item.downloadUrl === href);
    const labelMatches = downloads.filter((item) => (
      normalizedLabel === item.fileName || normalizedLabel.endsWith(item.fileName)
    ));
    const verified = exactUrl
      || (labelMatches.length === 1 ? labelMatches[0] : undefined)
      || (downloads.length === 1 ? downloads[0] : undefined);
    if (!verified) return full;
    return `[${label}](${verified.downloadUrl})`;
  });
}

export function repairFileArtifactDownloadLinks(reply: string, tools: FileArtifactToolResult[]) {
  const downloads = tools
    .map(fileArtifactDownloadFromToolResult)
    .filter((item): item is FileArtifactDownload => Boolean(item));
  const unique = [...new Map(downloads.map((item) => [item.artifactId, item])).values()];
  return repairArtifactDownloadLinks(reply, unique);
}
