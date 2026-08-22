import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { artifactApiUrl, artifactApiUrlFromRelative } from '@/lib/artifacts';
import type { BrowserActionResult } from '@/server/browser/browser-session';
import { artifactPath, artifactsRoot } from '@/server/storage/paths';
import {
  generateFileBuffer,
} from './document-artifact-generators';
import type {
  OfficeBlock,
  OfficeDocumentDraft,
  OfficeDocumentEditOperation,
  OfficeDocumentKind,
  OfficeDocumentOutlineItem,
  OfficeDocumentSettings,
} from '@/server/files/office-document-spec';
import { normalizeOfficeBlock } from '@/server/files/office-document-normalizer';
import {
  fillDocxTemplateBuffer,
  type DocxTemplateFillOperation,
} from './docx-template-filler';
import { renderBrowserChatAttachmentVisuals } from './browser-chat-attachment-visuals';
import type { BrowserCodeAttachmentBinding } from '@/server/browser/browser-code-runner';

const FILE_DOWNLOAD_TIMEOUT_MS = 30000;
const FILE_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;

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
  document?: OfficeDocumentSettings;
  intent?: string;
  outline?: OfficeDocumentOutlineItem[];
};

type GenerateArtifactBlocksInput = {
  runId?: string;
  documentId?: string;
  blocks?: OfficeBlock[];
  parentId?: string;
  beforeId?: string;
  afterId?: string;
  render?: boolean;
  includeVisualVerification?: boolean;
};

type EditArtifactInput = {
  runId?: string;
  documentId?: string;
  operations?: OfficeDocumentEditOperation[];
  render?: boolean;
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
  blockCount?: number;
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

function artifactDir(runId: string | undefined, kind: 'attachment-previews' | 'document-drafts' | 'downloads' | 'generated') {
  return artifactPath(sanitizeFileName(runId, 'adhoc'), kind);
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
      return `Document planned: ${payload.fileName || 'artifact'}; Document ID: ${payload.documentId}; blocks=${payload.blockCount || 0}`;
    }
    if (payload.kind === 'document-draft') {
      return `Document draft updated: ${payload.fileName || 'artifact'}; Document ID: ${payload.documentId}; blocks=${payload.blockCount || 0}`;
    }
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
      const response = await fetch(url, { signal: abortController.signal });
      if (!response.ok) {
        return { ok: false, actual: `downloadFile failed: HTTP ${response.status} ${response.statusText} for ${url}` };
      }
      const suggestedName = input.fileName
        || parseContentDispositionFileName(response.headers.get('content-disposition'))
        || fileNameFromUrl(url)
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
          sourceUrl: url,
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

function nestedBlocks(block: OfficeBlock) {
  return [
    ...(Array.isArray(block.children) ? block.children : []),
    ...(Array.isArray(block.columns) ? block.columns.flatMap((column) => Array.isArray(column.blocks) ? column.blocks : []) : []),
  ];
}

function allBlocks(blocks: OfficeBlock[]): OfficeBlock[] {
  return blocks.flatMap((block) => [block, ...allBlocks(nestedBlocks(block))]);
}

function validateUniqueBlockIds(blocks: OfficeBlock[], occupied = new Set<string>()) {
  for (const block of allBlocks(blocks)) {
    const id = String(block.id || '').trim();
    if (!id) throw new Error('Every document block requires a stable id.');
    if (occupied.has(id)) throw new Error(`Duplicate document block id: ${id}`);
    occupied.add(id);
  }
}

function findBlockList(blocks: OfficeBlock[], blockId: string): { list: OfficeBlock[]; index: number } | undefined {
  const directIndex = blocks.findIndex((block) => block.id === blockId);
  if (directIndex >= 0) return { list: blocks, index: directIndex };
  for (const block of blocks) {
    const candidates: OfficeBlock[][] = [];
    if (Array.isArray(block.children)) candidates.push(block.children);
    for (const column of block.columns || []) if (Array.isArray(column.blocks)) candidates.push(column.blocks);
    for (const candidate of candidates) {
      const found = findBlockList(candidate, blockId);
      if (found) return found;
    }
  }
  return undefined;
}

function insertionList(draft: OfficeDocumentDraft, parentId?: string) {
  if (!parentId) return draft.blocks;
  const parent = findBlockList(draft.blocks, parentId);
  if (!parent) throw new Error(`Parent block not found: ${parentId}`);
  const block = parent.list[parent.index];
  if (!Array.isArray(block.children)) block.children = [];
  return block.children;
}

function insertBlocks(draft: OfficeDocumentDraft, blocks: OfficeBlock[], placement: { parentId?: string; beforeId?: string; afterId?: string }) {
  blocks = blocks.map(normalizeOfficeBlock);
  validateUniqueBlockIds(blocks, new Set(allBlocks(draft.blocks).map((block) => block.id)));
  let list = insertionList(draft, placement.parentId);
  let index = list.length;
  const anchorId = placement.beforeId || placement.afterId;
  if (anchorId) {
    const anchor = findBlockList(draft.blocks, anchorId);
    if (!anchor) throw new Error(`Placement block not found: ${anchorId}`);
    list = anchor.list;
    index = anchor.index + (placement.afterId ? 1 : 0);
  }
  list.splice(index, 0, ...blocks);
}

function mergePlainObject(base: unknown, patch: unknown): unknown {
  if (!base || !patch || typeof base !== 'object' || typeof patch !== 'object' || Array.isArray(base) || Array.isArray(patch)) return patch;
  const result = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    result[key] = mergePlainObject(result[key], value);
  }
  return result;
}

async function loadDraft(runId: string | undefined, documentId: string) {
  const parsed = JSON.parse(await readFile(draftPath(runId, documentId), 'utf8')) as OfficeDocumentDraft;
  if (parsed.documentId !== documentId) throw new Error('Document draft identity does not match the requested documentId.');
  return parsed;
}

async function saveDraft(runId: string | undefined, draft: OfficeDocumentDraft) {
  const dir = artifactDir(runId, 'document-drafts');
  await mkdir(dir, { recursive: true });
  draft.updatedAt = new Date().toISOString();
  await writeFile(draftPath(runId, draft.documentId), JSON.stringify(draft, null, 2), 'utf8');
}

async function renderDraft(input: {
  runId?: string;
  draft: OfficeDocumentDraft;
  includeVisualVerification?: boolean;
}): Promise<BrowserActionResult> {
  try {
    const requestedName = sanitizeFileName(input.draft.fileName, `document-${Date.now()}.pdf`);
    const generated = await generateFileBuffer(input.draft);
    const dir = artifactDir(input.runId, 'generated');
    await mkdir(dir, { recursive: true });
    const existingRenderedName = input.draft.renderedFileName
      ? sanitizeFileName(input.draft.renderedFileName, requestedName)
      : undefined;
    const target = existingRenderedName
      ? { fileName: existingRenderedName, filePath: path.join(dir, existingRenderedName) }
      : await uniqueArtifactPath(dir, requestedName);
    await writeFile(target.filePath, generated.buffer);

    const visualVerification = input.includeVisualVerification && [
      '.doc', '.docx', '.odt', '.pdf', '.xls', '.xlsx', '.ods', '.ppt', '.pptx', '.odp',
    ].includes(generated.extension)
      ? await renderBrowserChatAttachmentVisuals({
          absolutePath: target.filePath,
          buffer: generated.buffer,
          extension: generated.extension,
          name: target.fileName,
          previewRoot: artifactDir(input.runId, 'attachment-previews'),
        })
      : undefined;
    if (input.includeVisualVerification
      && ['.doc', '.docx', '.odt', '.pdf', '.xls', '.xlsx', '.ods', '.ppt', '.pptx', '.odp'].includes(generated.extension)
      && (!visualVerification?.imagePaths.length
        || !['libreoffice-pdf', 'pdf'].includes(visualVerification.renderer))) {
      throw new Error(`visual quality gate failed: ${visualVerification?.warning || 'LibreOffice produced no page previews'}`);
    }
    if (input.draft.renderedFileName !== target.fileName) {
      input.draft.renderedFileName = target.fileName;
      await saveDraft(input.runId, input.draft);
    }

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
        blockCount: allBlocks(input.draft.blocks).length,
        generationDiagnostics: generated.diagnostics,
        qualityGate: {
          structural: true,
          visual: visualVerification ? visualVerification.imagePaths.length > 0 : 'not-applicable-to-current-model',
        },
        visualVerification: visualVerification ? {
          imageCount: visualVerification.imagePaths.length,
          pageCount: visualVerification.pageCount,
          renderedPages: visualVerification.renderedPages,
          renderer: visualVerification.renderer,
          warning: visualVerification.warning,
        } : { skipped: 'current model does not accept image input or the generated format has no page renderer' },
      }),
      referenceImagePaths: visualVerification?.imagePaths.length ? visualVerification.imagePaths : undefined,
    };
  } catch (error) {
    return { ok: false, actual: `file rendering failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function planFileArtifact(input: PlanArtifactInput): Promise<BrowserActionResult> {
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
      if (!existing.blocks.length && !existing.renderedFileName) {
        existing.fileName = requestedFileName;
        existing.document = input.document || existing.document;
        existing.intent = input.intent ?? existing.intent;
        existing.outline = input.outline ?? existing.outline;
        await saveDraft(input.runId, existing);
      }
      return {
        ok: true,
        actual: JSON.stringify({
          kind: 'document-plan',
          documentId: existing.documentId,
          fileName: existing.fileName,
          documentType: existing.documentType,
          outline: existing.outline,
          blockCount: allBlocks(existing.blocks).length,
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
      blocks: [],
      createdAt: now,
      document: input.document || {},
      documentId,
      documentType: input.documentType,
      fileName: requestedFileName,
      intent: input.intent,
      outline: input.outline,
      updatedAt: now,
    };
    await saveDraft(input.runId, draft);
    return { ok: true, actual: JSON.stringify({ kind: 'document-plan', documentId: draft.documentId, fileName: draft.fileName, documentType: draft.documentType, outline: draft.outline, blockCount: 0 }) };
  } catch (error) {
    return { ok: false, actual: `file planning failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function generateFileArtifactBlocks(input: GenerateArtifactBlocksInput): Promise<BrowserActionResult> {
  try {
    const documentId = String(input.documentId || '').trim();
    if (!documentId) return { ok: false, actual: 'file action=generate requires documentId from action=plan.' };
    const blocks = Array.isArray(input.blocks) ? input.blocks : [];
    if (!blocks.length) return { ok: false, actual: 'file action=generate requires at least one block.' };
    const draft = await loadDraft(input.runId, documentId);
    insertBlocks(draft, blocks, input);
    await saveDraft(input.runId, draft);
    if (input.render) return renderDraft({ ...input, draft });
    return { ok: true, actual: JSON.stringify({ kind: 'document-draft', documentId, fileName: draft.fileName, acceptedBlockIds: blocks.map((block) => block.id), blockCount: allBlocks(draft.blocks).length }) };
  } catch (error) {
    return { ok: false, actual: `file block generation failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function editFileArtifact(input: EditArtifactInput): Promise<BrowserActionResult> {
  try {
    const documentId = String(input.documentId || '').trim();
    if (!documentId) return { ok: false, actual: 'file action=edit requires documentId.' };
    const operations = Array.isArray(input.operations) ? input.operations : [];
    if (!operations.length) return { ok: false, actual: 'file action=edit requires at least one operation.' };
    const draft = await loadDraft(input.runId, documentId);
    for (const operation of operations) {
      if (operation.op === 'setDocument') {
        draft.document = mergePlainObject(draft.document, operation.patch || {}) as OfficeDocumentSettings;
        continue;
      }
      if (operation.op === 'add') {
        const blocks = operation.blocks || (operation.block ? [operation.block] : []);
        insertBlocks(draft, blocks, operation);
        continue;
      }
      const blockId = String(operation.blockId || '').trim();
      const found = findBlockList(draft.blocks, blockId);
      if (!found) throw new Error(`Block not found: ${blockId}`);
      if (operation.op === 'remove') {
        found.list.splice(found.index, 1);
      } else if (operation.op === 'replace') {
        if (!operation.block) throw new Error(`replace requires block for ${blockId}`);
        const replacedIds = new Set(allBlocks([found.list[found.index]]).map((block) => block.id));
        const remainingIds = new Set(allBlocks(draft.blocks).filter((block) => !replacedIds.has(block.id)).map((block) => block.id));
        validateUniqueBlockIds([operation.block], remainingIds);
        found.list.splice(found.index, 1, normalizeOfficeBlock(operation.block));
      } else if (operation.op === 'update') {
        const updated = normalizeOfficeBlock(mergePlainObject(found.list[found.index], operation.patch || {}) as OfficeBlock);
        updated.id = blockId;
        found.list[found.index] = updated;
      } else if (operation.op === 'move') {
        const [block] = found.list.splice(found.index, 1);
        insertBlocks(draft, [block], operation);
      }
    }
    validateUniqueBlockIds(draft.blocks);
    await saveDraft(input.runId, draft);
    if (input.render !== false) return renderDraft({ ...input, draft });
    return { ok: true, actual: JSON.stringify({ kind: 'document-draft', documentId, fileName: draft.fileName, blockCount: allBlocks(draft.blocks).length }) };
  } catch (error) {
    return { ok: false, actual: `file edit failed: ${error instanceof Error ? error.message : String(error)}` };
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
        } : { skipped: 'current model does not accept image input' },
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
