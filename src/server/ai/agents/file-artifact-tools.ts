import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, copyFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { artifactApiUrl, artifactApiUrlFromRelative } from '@/lib/artifacts';
import type { BrowserActionResult } from '@/server/browser/browser-session';
import { artifactPath, artifactsRoot } from '@/server/storage/paths';
import {
  generateFileBuffer,
  type GeneratedFileOutput,
} from './document-artifact-generators';
import { assertControlledUnoProgram, inspectUnoApi, type UnoApiTarget } from '@/server/files/uno-program';
import { assertControlledOfficeJsProgram } from '@/server/files/office-js-program';
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
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const draftLocks = new Map<string, Promise<void>>();
const DRAFT_LOCK_WAIT_MS = 120_000;
const STALE_DRAFT_LOCK_MS = 10 * 60_000;

type DownloadArtifactInput = {
  runId?: string;
  url?: string;
  path?: string;
  urlOrPath?: string;
  sourcePageUrl?: string;
  fileName?: string | null;
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
};

export type UnoDraftLineEdit = {
  /** One-based, inclusive source line range from action=read. */
  startLine: number;
  endLine: number;
  newText: string;
};

type EditUnoProgramInput = {
  runId?: string;
  documentId?: string;
  /** Optional legacy digest. A single chat owns its draft, so edits use the current source. */
  baseDigest?: string;
  edits?: UnoDraftLineEdit[];
  program?: string;
  render?: boolean;
  includeVisualVerification?: boolean;
  attachmentBindings?: BrowserCodeAttachmentBinding[];
  abortSignal?: AbortSignal;
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
};

type RenderArtifactInput = {
  runId?: string;
  documentId?: string;
  includeVisualVerification?: boolean;
  attachmentBindings?: BrowserCodeAttachmentBinding[];
  abortSignal?: AbortSignal;
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
  origin: 'attachment' | 'download' | 'generated';
  ref?: string;
};

const documentExtensions: Record<OfficeDocumentKind, Set<string>> = {
  presentation: new Set(['.ppt', '.pptx', '.odp']),
  spreadsheet: new Set(['.xls', '.xlsx', '.ods']),
  word: new Set(['.doc', '.docx', '.odt']),
};
const javascriptOfficeExtensions = new Set(['.docx', '.pptx', '.xlsx', '.pdf']);

function configuredOfficeGenerator(fileName: string, operation: 'create' | 'modify'):
  OfficeDocumentDraft['generator'] {
  if (operation === 'modify') return 'uno';
  const configured = String(process.env.OFFICE_GENERATION_MODE || 'uno').trim().toLowerCase();
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
  const buffer = await readFile(binding.path);
  return {
    operation: 'modify' as const,
    sourceDocument: {
      assetName: asset.assetName,
      attachmentId: binding.ref,
      bytes: buffer.byteLength,
      fileName: binding.name,
      sha256: createHash('sha256').update(buffer).digest('hex'),
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
      if (!metadata.isFile() || metadata.size > FILE_DOWNLOAD_MAX_BYTES) continue;
      const assetName = assetFileName(
        source.name,
        source.origin === 'attachment' ? `attachment-${source.ref || 'file'}` : source.origin,
        claimed,
      );
      await copyFile(source.path, path.join(destination, assetName));
      result.push({ assetName, bytes: metadata.size, origin: source.origin, ref: source.ref });
    } catch {
      // A stale upload or artifact must not make unrelated document authoring fail.
    }
  }
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
      return `Document planned: ${payload.fileName || 'artifact'}; Document ID: ${payload.documentId}; operation=${payload.operation || 'create'}; generator=${payload.generator || 'uno'}; sourceCharacters=${payload.sourceCharacters || 0}; Mounted conversation assets: ${assets.length ? assets.join(', ') : '(none)'}. Use only these exact names with the returned cookbook asset API.`;
    }
    if (payload.kind === 'uno-program' || payload.kind === 'office-program') {
      return `Office source updated: ${payload.fileName || 'artifact'}; Document ID: ${payload.documentId}; generator=${payload.generator || 'uno'}; sourceCharacters=${payload.sourceCharacters || 0}`;
    }
    if (payload.kind === 'uno-draft-validation') {
      return `Office source validated: ${payload.fileName || 'artifact'}; Document ID: ${payload.documentId}; sourceCharacters=${payload.sourceCharacters || 0}; cacheHit=${payload.cacheHit === true}`;
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

export async function downloadFileArtifact(input: DownloadArtifactInput): Promise<BrowserActionResult> {
  try {
    const url = resolveDownloadUrl(input);
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(new Error(`Download timed out after ${FILE_DOWNLOAD_TIMEOUT_MS}ms`)), FILE_DOWNLOAD_TIMEOUT_MS);

    try {
      const { response, resolvedUrl } = await fetchDownloadResponse(url, abortController.signal);
      if (!response.ok) {
        return { ok: false, actual: `downloadFile failed: HTTP ${response.status} ${response.statusText} for ${resolvedUrl}` };
      }
      const suggestedName = input.fileName
        || parseContentDispositionFileName(response.headers.get('content-disposition'))
        || fileNameFromUrl(resolvedUrl)
        || `download-${Date.now()}.bin`;
      const fileName = sanitizeFileName(suggestedName, `download-${Date.now()}.bin`);
      const dir = artifactDir(input.runId, 'downloads');
      await mkdir(dir, { recursive: true });
      const target = await uniqueArtifactPath(dir, fileName);
      let bytes = 0;
      try {
        bytes = await writeLimitedResponse(response, target.filePath, FILE_DOWNLOAD_MAX_BYTES);
      } catch (error) {
        await unlink(target.filePath).catch(() => undefined);
        throw error;
      }

      return {
        ok: true,
        actual: JSON.stringify(artifactResultPayload({
          kind: 'download',
          fileName: target.fileName,
          filePath: target.filePath,
          bytes,
          sourceUrl: resolvedUrl,
        })),
      };
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
        if (Date.now() - metadata.mtimeMs > STALE_DRAFT_LOCK_MS) await unlink(lockPath).catch(() => undefined);
      } catch (lockError) {
        const lockCode = lockError && typeof lockError === 'object' && 'code' in lockError ? String((lockError as { code?: unknown }).code || '') : '';
        if (lockCode !== 'ENOENT') throw lockError;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for the workspace draft lock for ${documentId}.`);
      await racePromiseWithAbort(new Promise((resolve) => setTimeout(resolve, 50)), abortSignal);
    }
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
  parsed.generator ||= 'uno';
  parsed.operation ||= parsed.sourceDocument ? 'modify' : 'create';
  parsed.renderedDigest ||= parsed.renderedSourceDigest;
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
  return parsed;
}

async function saveDraft(runId: string | undefined, draft: OfficeDocumentDraft) {
  const dir = artifactDir(runId, 'document-drafts');
  await mkdir(dir, { recursive: true });
  draft.updatedAt = new Date().toISOString();
  draft.sourceDigest = draft.program ? sourceDigest(draft.program) : undefined;
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

function sourceDigest(source: string) {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

function normalizedDraftSource(source: string) {
  return source.replace(/\r\n?/g, '\n');
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
  const hasFinalNewline = normalized.endsWith('\n');
  const lines = hasFinalNewline ? normalized.slice(0, -1).split('\n') : normalized.split('\n');
  const lineCount = lines.length;
  const ordered = edits.map((edit, editIndex) => {
    const startLine = Number(edit?.startLine);
    const endLine = Number(edit?.endLine);
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
      throw new Error(`source edit ${editIndex + 1} requires integer startLine and endLine from action=read.`);
    }
    if (startLine < 1 || endLine < startLine || endLine > lineCount) {
      throw new Error(`source edit ${editIndex + 1} range ${startLine}-${endLine} is outside the current 1-${lineCount} source lines. Read the draft again.`);
    }
    if (typeof edit.newText !== 'string') {
      throw new Error(`source edit ${editIndex + 1} requires string newText.`);
    }
    return { ...edit, startLine, endLine, editIndex };
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
    return {
      ok: true,
      actual: JSON.stringify({
        kind: 'uno-draft',
        documentId: draft.documentId,
        documentType: draft.documentType,
        fileName: draft.fileName,
        operation: draft.operation || 'create',
        generator: draft.generator || 'uno',
        sourceFileName: path.basename(draftProgramPath(input.runId, documentId, draft.generator)),
        sourceDocument: draft.sourceDocument ? {
          attachmentId: draft.sourceDocument.attachmentId,
          assetName: draft.sourceDocument.assetName,
          fileName: draft.sourceDocument.fileName,
        } : undefined,
        sourceDigest: sourceDigest(draft.program),
        lineCount: draftSourceLineCount(draft.program),
        program: numberedDraftSource(draft.program),
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
    if ((draft.generator || 'uno') === 'javascript') {
      return {
        ok: false,
        actual: `Document ${documentId} uses JavaScript generation. UNO API guidance is unavailable for this draft; call action=jsApi for ${draft.documentType} instead.`,
      };
    }
    if (!input.documentType || !input.target) return { ok: false, actual: 'file action=unoApi requires documentType and target.' };
    return {
      ok: true,
      actual: JSON.stringify({ kind: 'uno-api', ...(await inspectUnoApi({
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

export function getOfficeJsApi(input: Pick<UnoApiInput, 'documentType'>): BrowserActionResult {
  if (!input.documentType) return { ok: false, actual: 'file action=jsApi requires documentType.' };
  const examples = {
    presentation: `export async function createDocument(job) {
  const pptx = new job.PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  const slide = pptx.addSlide();
  slide.addText('Title', { x: 0.7, y: 0.5, w: 12, h: 0.6, fontSize: 28, bold: true, margin: 0, breakLine: false, fit: 'shrink' });
  await pptx.writeFile({ fileName: job.outputPath });
}`,
    word: `export async function createDocument(job) {
  const { Document, Packer, Paragraph, TextRun } = job.docx;
  const document = new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun({ text: 'Title', bold: true, size: 40 })] })] }] });
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
  return {
    ok: true,
    actual: JSON.stringify({
      kind: 'office-js-api',
      documentType: input.documentType,
      libraries: {
        presentation: 'pptxgenjs via job.PptxGenJS',
        word: 'docx via job.docx',
        spreadsheet: 'exceljs via job.ExcelJS',
      },
      rules: [
        'Export exactly one async or synchronous createDocument(job) function.',
        'The initial action=generate may be a small, runnable skeleton; do not try to author the entire document in one call. Add pages, sections, assets, and layout incrementally with repeated action=edit line-range changes, validating after each bounded change.',
        'Write the final editable Office file to job.outputPath, or use await job.writeOutput(buffer) for docx buffers.',
        'Use await job.assetPath(exactName) and await job.listAssets() for conversation assets.',
        'Do not fetch remote URLs from the draft; download assets with the file tool first.',
        'JavaScript mode creates PPTX, DOCX, or XLSX directly. A .pdf target is supported by creating the matching Office source for documentType and converting it with local LibreOffice.',
        'For PDF, still write to job.outputPath exactly as shown; its temporary extension is already the correct .pptx, .docx, or .xlsx source format.',
        'Existing-file modification remains UNO-based.',
      ],
      completeDocument: examples[input.documentType],
    }),
  };
}

type ValidatedDraftCandidate = {
  assets: DocumentAsset[];
  cacheHit: boolean;
  generated: GeneratedFileOutput;
  previewPath?: string;
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
  return createHash('sha256').update(JSON.stringify(assets.map((asset) => ({
    assetName: asset.assetName,
    bytes: asset.bytes,
    origin: asset.origin,
    ref: asset.ref,
  }))), 'utf8').digest('hex');
}

async function prepareValidatedDraft(input: {
  runId?: string;
  draft: OfficeDocumentDraft;
  attachmentBindings?: BrowserCodeAttachmentBinding[];
  abortSignal?: AbortSignal;
}): Promise<ValidatedDraftCandidate> {
  if (!input.draft.program) throw new Error(`Office draft ${input.draft.documentId} has no source yet; call action=generate first.`);
  // Save first: a failing program remains editable just like it would in a
  // normal code editor, while the generated candidate remains unpublished.
  await saveDraft(input.runId, input.draft);
  const assets = await syncDocumentAssets(input.runId, input.attachmentBindings);
  const assetFingerprint = documentAssetsFingerprint(assets);
  const extension = path.extname(input.draft.fileName).toLowerCase();
  const cache = validationCachePaths(input.runId, input.draft, extension);
  try {
    const metadata = JSON.parse(await readFile(cache.metadataPath, 'utf8')) as { assetFingerprint?: string };
    if (metadata.assetFingerprint === assetFingerprint) {
      const buffer = await readFile(cache.artifactPath);
      const previewPdf = await readFile(cache.previewPath).catch(() => undefined);
      return {
        assets,
        cacheHit: true,
        generated: { buffer, extension: extension as GeneratedFileOutput['extension'], previewPdf },
        previewPath: previewPdf ? cache.previewPath : undefined,
      };
    }
  } catch {
    // A missing or interrupted cache is not a document failure; regenerate it.
  }
  const generated = await generateFileBuffer({
    ...input.draft,
    programPath: draftProgramPath(input.runId, input.draft.documentId, input.draft.generator),
    assetsPath: artifactDir(input.runId, 'document-assets'),
    generator: input.draft.generator,
    requiredSourceAssetName: input.draft.sourceDocument?.assetName,
    abortSignal: input.abortSignal,
  });
  await writeFile(cache.artifactPath, generated.buffer);
  if (generated.previewPdf) await writeFile(cache.previewPath, generated.previewPdf);
  else await unlink(cache.previewPath).catch(() => undefined);
  await writeFile(cache.metadataPath, JSON.stringify({ assetFingerprint }), 'utf8');
  return { assets, cacheHit: false, generated, previewPath: generated.previewPdf ? cache.previewPath : undefined };
}

async function validateDraft(input: {
  runId?: string;
  draft: OfficeDocumentDraft;
  includeVisualVerification?: boolean;
  documentChanged?: boolean;
  attachmentBindings?: BrowserCodeAttachmentBinding[];
  abortSignal?: AbortSignal;
}): Promise<BrowserActionResult> {
  try {
    const candidate = await prepareValidatedDraft(input);
    const needsOfficePreview = input.includeVisualVerification && [
      '.doc', '.docx', '.odt', '.pdf', '.xls', '.xlsx', '.ods', '.ppt', '.pptx', '.odp',
    ].includes(candidate.generated.extension);
    if (needsOfficePreview && (!candidate.generated.previewPdf || !candidate.previewPath)) {
      throw new Error('LibreOffice UNO worker did not produce a PDF preview for draft validation.');
    }
    const visualVerification = needsOfficePreview
      ? await renderBrowserChatAttachmentVisuals({
          absolutePath: candidate.previewPath!,
          buffer: candidate.generated.previewPdf!,
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
        generator: input.draft.generator || 'uno',
        sourceDigest: sourceDigest(input.draft.program || ''),
        sourceCharacters: input.draft.program?.length || 0,
        documentChanged: input.documentChanged || false,
        cacheHit: candidate.cacheHit,
        generationDiagnostics: candidate.generated.diagnostics,
        qualityGate: {
          structural: true,
          visual: visualVerification ? {
            previewGenerated: visualVerification.imagePaths.length > 0,
            modelReviewRequired: true,
            reviewedPages: visualVerification.renderedPages,
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
        generator: input.draft.generator || 'uno',
        changed: input.documentChanged || false,
        saved: true,
        sourceDigest: sourceDigest(source),
        sourceCharacters: source.length,
        lineCount: draftSourceLineCount(source),
        validation: 'failed',
        requiredNextAction: 'read',
        error: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}

async function renderDraft(input: {
  runId?: string;
  draft: OfficeDocumentDraft;
  includeVisualVerification?: boolean;
  documentChanged?: boolean;
  attachmentBindings?: BrowserCodeAttachmentBinding[];
  abortSignal?: AbortSignal;
}): Promise<BrowserActionResult> {
  let publishCandidatePath: string | undefined;
  try {
    const candidate = await prepareValidatedDraft(input);
    const digest = sourceDigest(input.draft.program || '');
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
    if (needsOfficePreview && (!candidate.generated.previewPdf || !candidate.previewPath)) {
      throw new Error('LibreOffice UNO worker did not produce a PDF preview for visual verification.');
    }
    const visualVerification = needsOfficePreview
      ? await renderBrowserChatAttachmentVisuals({
          absolutePath: candidate.previewPath!,
          buffer: candidate.generated.previewPdf!,
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
    publishCandidatePath = path.join(dir, `.render-${randomUUID()}${candidate.generated.extension}`);
    await writeFile(publishCandidatePath, candidate.generated.buffer, { flag: 'wx' });
    await rename(publishCandidatePath, target.filePath);
    publishCandidatePath = undefined;
    const artifact = artifactResultPayload({
      kind: 'generated',
      fileName: target.fileName,
      filePath: target.filePath,
      bytes: candidate.generated.buffer.byteLength,
    });
    input.draft.renderedArtifactId = artifact.artifactId;
    input.draft.renderedFileName = target.fileName;
    input.draft.renderedSourceDigest = digest;
    input.draft.renderedDigest = digest;
    input.draft.visualQaArtifactId = undefined;
    input.draft.visualQaDigest = undefined;
    input.draft.visualQaPageCount = undefined;
    input.draft.visualQaSeenPages = [];
    await saveDraft(input.runId, input.draft);

    return {
      ok: true,
      actual: JSON.stringify({
        ...artifact,
        documentId: input.draft.documentId,
        sourceDigest: digest,
        renderedDigest: digest,
        documentChanged: input.documentChanged || false,
        cacheHit: candidate.cacheHit,
        availableAssets: candidate.assets.map((asset) => ({
          assetName: asset.assetName,
          bytes: asset.bytes,
          origin: asset.origin,
          ref: asset.ref,
        })),
        generationDiagnostics: candidate.generated.diagnostics,
        qualityGate: {
          structural: true,
          visual: visualVerification ? {
            previewGenerated: visualVerification.imagePaths.length > 0,
            modelReviewRequired: true,
            reviewedPages: visualVerification.renderedPages,
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
          gateStatus: 'pending-model-review',
          requiredCondition: 'visualQaDigest === renderedDigest and every indexed page has been read',
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
          generator: existing.generator || 'uno',
          sourceDocument: existing.sourceDocument,
          sourceFileName: path.basename(draftProgramPath(input.runId, existing.documentId, existing.generator)),
          sourceCharacters: existing.program?.length || 0,
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
    if (!program) return { ok: false, actual: 'file action=generate requires a runnable source draft in program; start with a small validated skeleton, then add the document through action=edit.' };
    const persistedDraft = await loadDraft(input.runId, documentId);
    if ((persistedDraft.generator || 'uno') === 'javascript') assertControlledOfficeJsProgram(program);
    else assertControlledUnoProgram(program);
    if (persistedDraft.program) {
      return {
        ok: false,
        actual: `Office draft ${documentId} already has source. Do not send another complete program. Use action=read only when the current source is unknown, then action=edit with line-range edits=[{startLine,endLine,newText}]. The edit is saved and validated before action=render publishes it.`,
      };
    }
    const draft = structuredClone(persistedDraft);
    draft.program = program;
    await saveDraft(input.runId, draft);
    // Initial authoring validates the saved draft but never publishes a file.
    if (input.render !== false) return validateDraft({ ...input, draft, documentChanged: true });
    return { ok: true, actual: JSON.stringify({ kind: 'office-program', documentId, generator: draft.generator || 'uno', fileName: draft.fileName, sourceCharacters: program.length }) };
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
    if (!Array.isArray(input.edits) || !input.edits.length) {
      return { ok: false, actual: 'file action=edit requires line-range edits=[{startLine,endLine,newText}].' };
    }
    const persistedDraft = await loadDraft(input.runId, documentId);
    if (!persistedDraft.program) return { ok: false, actual: `Office draft ${documentId} has no program yet; call action=generate first.` };
    const currentDigest = sourceDigest(persistedDraft.program);
    const draft = structuredClone(persistedDraft);
    draft.program = applyUnoDraftLineEdits(persistedDraft.program, input.edits);
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
          lineCount: draftSourceLineCount(draft.program),
          validation: 'unchanged',
        }),
      };
    }
    if ((draft.generator || 'uno') === 'javascript') assertControlledOfficeJsProgram(draft.program);
    else assertControlledUnoProgram(draft.program);
    await saveDraft(input.runId, draft);
    // Editing behaves like a code editor: save, execute and report errors,
    // but reserve the user-visible artifact for explicit action=render.
    if (input.render !== false) return validateDraft({ ...input, draft, documentChanged: true });
    return { ok: true, actual: JSON.stringify({
      kind: 'office-program',
      generator: draft.generator || 'uno',
      documentId,
      fileName: draft.fileName,
      changed: true,
      saved: true,
      sourceCharacters: draft.program.length,
      sourceDigest: sourceDigest(draft.program),
      lineCount: draftSourceLineCount(draft.program),
    }) };
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
  action: 'index' | 'read';
  result: BrowserActionResult;
}): Promise<BrowserActionResult> {
  if (!input.result.ok) return input.result;
  const identity = versionedRenderedArtifact(input.artifactId);
  if (!identity) return input.result;
  try {
    const payload = JSON.parse(String(input.result.actual || '')) as {
      kind?: string;
      screenshotCount?: number;
      screenshots?: Array<{ pageNumber?: number }>;
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
      }
      const screenshotCount = Number(payload.screenshotCount);
      if (Number.isSafeInteger(screenshotCount) && screenshotCount > 0) draft.visualQaPageCount = screenshotCount;
      if (input.action === 'read' && payload.kind === 'file-visual-read') {
        const seen = new Set(draft.visualQaSeenPages || []);
        for (const screenshot of payload.screenshots || []) {
          const page = Number(screenshot.pageNumber);
          if (Number.isSafeInteger(page) && page > 0 && (!draft.visualQaPageCount || page <= draft.visualQaPageCount)) seen.add(page);
        }
        draft.visualQaSeenPages = [...seen].sort((left, right) => left - right);
      }
      const pageCount = draft.visualQaPageCount || 0;
      const completeCoverage = pageCount > 0
        && Array.from({ length: pageCount }, (_, index) => index + 1).every((page) => draft.visualQaSeenPages?.includes(page));
      draft.visualQaDigest = completeCoverage ? identity.renderedDigest : undefined;
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
            complete: draft.visualQaDigest === identity.renderedDigest && completeCoverage,
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
      if (draft.visualQaArtifactId !== draft.renderedArtifactId
        || draft.visualQaDigest !== renderedDigest
        || !completeCoverage) {
        pending.push({
          documentId: draft.documentId,
          artifactId: draft.renderedArtifactId,
          renderedDigest,
          visualQaDigest: draft.visualQaDigest,
          pageCount,
          seenPageCount: seen.size,
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
        availableAssets: assets.map((asset) => ({ assetName: asset.assetName, bytes: asset.bytes, origin: asset.origin, ref: asset.ref })),
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
