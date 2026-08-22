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
} from './document-artifact-generators';
import { assertControlledUnoProgram, inspectUnoApi, type UnoApiTarget } from '@/server/files/uno-program';
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

export type UnoDraftTextEdit = {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
};

type EditUnoProgramInput = {
  runId?: string;
  documentId?: string;
  edits?: UnoDraftTextEdit[];
  program?: string;
  render?: boolean;
  includeVisualVerification?: boolean;
  attachmentBindings?: BrowserCodeAttachmentBinding[];
  abortSignal?: AbortSignal;
};

type UnoApiInput = {
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
  sourceCharacters?: number;
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
    for (const entry of await visibleFiles(directory)) {
      sources.push({ name: entry.name, path: path.join(directory, entry.name), origin: origin === 'downloads' ? 'download' : 'generated' });
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
      return `Document planned: ${payload.fileName || 'artifact'}; Document ID: ${payload.documentId}; sourceCharacters=${payload.sourceCharacters || 0}; Mounted conversation assets: ${assets.length ? assets.join(', ') : '(none)'}. Use only these exact names with job.asset_path(name).`;
    }
    if (payload.kind === 'uno-program') {
      return `UNO draft updated: ${payload.fileName || 'artifact'}; Document ID: ${payload.documentId}; sourceCharacters=${payload.sourceCharacters || 0}`;
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

function draftProgramPath(runId: string | undefined, documentId: string) {
  return path.join(artifactDir(runId, 'document-drafts'), `${sanitizeFileName(documentId, 'document')}.py`);
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
      sourceMatches = sourceDigest(await readFile(draftProgramPath(runId, documentId), 'utf8')) === pending.sourceDigest;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code || '') : '';
      if (code !== 'ENOENT') throw error;
    }
  } else {
    try {
      await access(draftProgramPath(runId, documentId));
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
  if (parsed.documentId !== documentId) throw new Error('Document draft identity does not match the requested documentId.');
  if (parsed.program) {
    try {
      const workspaceProgram = await readFile(draftProgramPath(runId, documentId), 'utf8');
      const workspaceDigest = sourceDigest(workspaceProgram);
      if (parsed.sourceDigest && parsed.sourceDigest !== workspaceDigest) {
        throw new Error('Workspace draft.py does not match its saved source metadata. Read the draft again or restore it before editing.');
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
  const programTarget = draftProgramPath(runId, draft.documentId);
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

function textOccurrenceCount(source: string, search: string) {
  let count = 0;
  let offset = 0;
  while (offset <= source.length - search.length) {
    const foundAt = source.indexOf(search, offset);
    if (foundAt < 0) break;
    count += 1;
    offset = foundAt + search.length;
  }
  return count;
}

/**
 * Apply editor-style, ordered search/replace operations to the one virtual
 * draft.py. A single replacement must be unambiguous; callers can explicitly
 * opt into replacing every occurrence.
 */
export function applyUnoDraftTextEdits(source: string, edits: UnoDraftTextEdit[]) {
  if (!Array.isArray(edits) || !edits.length) {
    throw new Error('file action=edit requires at least one text edit.');
  }
  let output = normalizedDraftSource(source);
  edits.forEach((edit, editIndex) => {
    const oldText = normalizedDraftSource(typeof edit?.oldText === 'string' ? edit.oldText : '');
    const newText = normalizedDraftSource(typeof edit?.newText === 'string' ? edit.newText : '');
    if (!oldText) throw new Error(`draft.py edit ${editIndex + 1} requires non-empty oldText.`);
    const occurrences = textOccurrenceCount(output, oldText);
    if (!occurrences) {
      throw new Error(`draft.py edit ${editIndex + 1} could not find oldText in the current source. Read draft.py again and copy a larger exact source region.`);
    }
    if (occurrences > 1 && edit.replaceAll !== true) {
      throw new Error(`draft.py edit ${editIndex + 1} matched ${occurrences} locations. Include more surrounding context or set replaceAll=true intentionally.`);
    }
    if (edit.replaceAll === true) output = output.split(oldText).join(newText);
    else {
      const foundAt = output.indexOf(oldText);
      output = `${output.slice(0, foundAt)}${newText}${output.slice(foundAt + oldText.length)}`;
    }
  });
  return output;
}

async function readUnoDraftUnlocked(input: ReadUnoDraftInput): Promise<BrowserActionResult> {
  try {
    const documentId = String(input.documentId || '').trim();
    if (!documentId) return { ok: false, actual: 'file action=read requires documentId when reading a UNO draft.' };
    const draft = await loadDraft(input.runId, documentId);
    if (!draft.program) return { ok: false, actual: `UNO draft ${documentId} has no program yet; call action=generate first.` };
    return {
      ok: true,
      actual: JSON.stringify({
        kind: 'uno-draft',
        documentId: draft.documentId,
        documentType: draft.documentType,
        fileName: draft.fileName,
        sourceDigest: sourceDigest(draft.program),
        program: draft.program,
      }),
    };
  } catch (error) {
    return { ok: false, actual: `UNO draft read failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function getUnoApi(input: UnoApiInput): Promise<BrowserActionResult> {
  try {
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

async function renderDraft(input: {
  runId?: string;
  draft: OfficeDocumentDraft;
  includeVisualVerification?: boolean;
  documentChanged?: boolean;
  attachmentBindings?: BrowserCodeAttachmentBinding[];
  abortSignal?: AbortSignal;
}): Promise<BrowserActionResult> {
  let verificationPath: string | undefined;
  let previewPath: string | undefined;
  try {
    if (!input.draft.program) throw new Error(`UNO draft ${input.draft.documentId} has no program yet; call action=generate first.`);
    // Also migrates legacy JSON-only drafts before the worker is given its real
    // workspace path. This never changes the source.
    await saveDraft(input.runId, input.draft);
    const requestedName = sanitizeFileName(input.draft.fileName, `document-${Date.now()}.pdf`);
    const assets = await syncDocumentAssets(input.runId, input.attachmentBindings);
    const generated = await generateFileBuffer({
      ...input.draft,
      programPath: draftProgramPath(input.runId, input.draft.documentId),
      // The worker sees only the materialized per-run asset workspace. This
      // includes every registered upload plus previous downloads and final
      // generated artifacts, never an arbitrary host path.
      assetsPath: artifactDir(input.runId, 'document-assets'),
      abortSignal: input.abortSignal,
    });
    const dir = artifactDir(input.runId, 'generated');
    await mkdir(dir, { recursive: true });
    const existingRenderedName = input.draft.renderedFileName
      ? sanitizeFileName(input.draft.renderedFileName, requestedName)
      : undefined;
    const target = existingRenderedName
      ? { fileName: existingRenderedName, filePath: path.join(dir, existingRenderedName) }
      : await uniqueArtifactPath(dir, requestedName);
    const needsOfficePreview = input.includeVisualVerification && [
      '.doc', '.docx', '.odt', '.pdf', '.xls', '.xlsx', '.ods', '.ppt', '.pptx', '.odp',
    ].includes(generated.extension);
    verificationPath = path.join(dir, `.render-${randomUUID()}${generated.extension}`);
    await writeFile(verificationPath, generated.buffer, { flag: 'wx' });

    previewPath = path.join(dir, `.preview-${randomUUID()}.pdf`);
    if (needsOfficePreview && !generated.previewPdf) {
      throw new Error('LibreOffice UNO worker did not produce a PDF preview for visual verification.');
    }
    if (generated.previewPdf) await writeFile(previewPath, generated.previewPdf, { flag: 'wx' });
    const visualVerification = needsOfficePreview
      ? await renderBrowserChatAttachmentVisuals({
          absolutePath: previewPath,
          buffer: generated.previewPdf!,
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

    // The candidate program and binary stay invisible until every generation,
    // reload, and optional preview gate has passed.
    await rename(verificationPath, target.filePath);
    verificationPath = undefined;
    input.draft.renderedFileName = target.fileName;
    await saveDraft(input.runId, input.draft);

    return {
      ok: true,
      actual: JSON.stringify({
        ...artifactResultPayload({
          kind: 'generated',
          fileName: target.fileName,
          filePath: target.filePath,
          bytes: generated.buffer.byteLength,
        }),
        documentId: input.draft.documentId,
        documentChanged: input.documentChanged || false,
        availableAssets: assets.map((asset) => ({
          assetName: asset.assetName,
          bytes: asset.bytes,
          origin: asset.origin,
          ref: asset.ref,
        })),
        generationDiagnostics: generated.diagnostics,
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
    if (verificationPath) await unlink(verificationPath).catch(() => undefined);
    if (previewPath) await unlink(previewPath).catch(() => undefined);
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
        await saveDraft(input.runId, existing);
      }
      return {
        ok: true,
        actual: JSON.stringify({
          kind: 'document-plan',
          documentId: existing.documentId,
          fileName: existing.fileName,
          documentType: existing.documentType,
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
      updatedAt: now,
    };
    await saveDraft(input.runId, draft);
    return { ok: true, actual: JSON.stringify({ kind: 'document-plan', documentId: draft.documentId, fileName: draft.fileName, documentType: draft.documentType, sourceCharacters: 0 }) };
  } catch (error) {
    return { ok: false, actual: `file planning failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function generateUnoFileArtifactUnlocked(input: GenerateUnoProgramInput): Promise<BrowserActionResult> {
  try {
    const documentId = String(input.documentId || '').trim();
    if (!documentId) return { ok: false, actual: 'file action=generate requires documentId from action=plan.' };
    const program = String(input.program || '').trim();
    if (!program) return { ok: false, actual: 'file action=generate requires a complete Python UNO draft in program.' };
    assertControlledUnoProgram(program);
    const persistedDraft = await loadDraft(input.runId, documentId);
    if (persistedDraft.program) {
      return {
        ok: false,
        actual: `UNO draft ${documentId} already has source. Do not send another complete program. Use action=read only when the current source is unknown, then action=edit with targeted edits=[{oldText,newText,replaceAll?}]. The edit is saved to draft.py before it is rendered.`,
      };
    }
    const draft = structuredClone(persistedDraft);
    draft.program = program;
    await saveDraft(input.runId, draft);
    if (input.render !== false) return renderDraft({ ...input, draft, documentChanged: true });
    return { ok: true, actual: JSON.stringify({ kind: 'uno-program', documentId, fileName: draft.fileName, sourceCharacters: program.length }) };
  } catch (error) {
    return { ok: false, actual: `UNO program generation failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function editUnoFileArtifactUnlocked(input: EditUnoProgramInput): Promise<BrowserActionResult> {
  try {
    const documentId = String(input.documentId || '').trim();
    if (!documentId) return { ok: false, actual: 'file action=edit requires documentId.' };
    if (typeof input.program === 'string' && input.program.trim()) {
      return {
        ok: false,
        actual: 'file action=edit does not accept a complete program replacement. Read the current draft.py when needed and send only targeted edits=[{oldText,newText,replaceAll?}].',
      };
    }
    if (!Array.isArray(input.edits) || !input.edits.length) {
      return { ok: false, actual: 'file action=edit requires targeted edits=[{oldText,newText,replaceAll?}].' };
    }
    const persistedDraft = await loadDraft(input.runId, documentId);
    if (!persistedDraft.program) return { ok: false, actual: `UNO draft ${documentId} has no program yet; call action=generate first.` };
    const draft = structuredClone(persistedDraft);
    draft.program = applyUnoDraftTextEdits(persistedDraft.program, input.edits);
    if (draft.program === normalizedDraftSource(persistedDraft.program)) {
      return { ok: false, actual: 'file action=edit made no changes to draft.py.' };
    }
    assertControlledUnoProgram(draft.program);
    await saveDraft(input.runId, draft);
    if (input.render !== false) return renderDraft({ ...input, draft, documentChanged: true });
    return { ok: true, actual: JSON.stringify({ kind: 'uno-program', documentId, fileName: draft.fileName, sourceCharacters: draft.program.length, sourceDigest: sourceDigest(draft.program) }) };
  } catch (error) {
    return { ok: false, actual: `UNO draft edit failed: ${error instanceof Error ? error.message : String(error)}` };
  }
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
    return { ok: false, actual: `UNO draft read failed: ${error instanceof Error ? error.message : String(error)}` };
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
    return { ok: false, actual: `UNO program generation failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function editUnoFileArtifact(input: EditUnoProgramInput): Promise<BrowserActionResult> {
  try {
    const documentId = requireDocumentId(input.documentId, 'edit');
    return await withDraftLock(input.runId, documentId, () => editUnoFileArtifactUnlocked({ ...input, documentId }), input.abortSignal);
  } catch (error) {
    return { ok: false, actual: `UNO draft edit failed: ${error instanceof Error ? error.message : String(error)}` };
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
