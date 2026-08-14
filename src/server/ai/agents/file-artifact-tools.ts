import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { artifactApiUrl, artifactApiUrlFromRelative } from '@/lib/artifacts';
import type { BrowserActionResult } from '@/server/browser/browser-session';
import { artifactPath, artifactsRoot } from '@/server/storage/paths';
import {
  generateFileBuffer,
  type GeneratedFileInput,
} from './document-artifact-generators';
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

type GenerateArtifactInput = Omit<GeneratedFileInput, 'fileName'> & {
  runId?: string;
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

function artifactDir(runId: string | undefined, kind: 'attachment-previews' | 'downloads' | 'generated') {
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
  if (toolName !== 'downloadFile' && toolName !== 'generateFile' && toolName !== 'fillDocumentTemplate') return undefined;
  try {
    const payload = JSON.parse(actual || '{}') as ArtifactToolPayload;
    const label = toolName === 'downloadFile'
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

async function readLimitedResponse(response: Response, maxBytes: number) {
  const contentLength = Number(response.headers.get('content-length') || '');
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Download is too large: ${contentLength} bytes exceeds ${maxBytes} bytes.`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new Error(`Download is too large: ${buffer.byteLength} bytes exceeds ${maxBytes} bytes.`);
  }
  return buffer;
}

export async function downloadFileArtifact(input: DownloadArtifactInput): Promise<BrowserActionResult> {
  try {
    const url = resolveDownloadUrl(input);
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(new Error(`Download timed out after ${FILE_DOWNLOAD_TIMEOUT_MS}ms`)), FILE_DOWNLOAD_TIMEOUT_MS);

    let response: Response;
    let buffer = Buffer.alloc(0);
    try {
      response = await fetch(url, { signal: abortController.signal });
      if (!response.ok) {
        return { ok: false, actual: `downloadFile failed: HTTP ${response.status} ${response.statusText} for ${url}` };
      }
      buffer = await readLimitedResponse(response, FILE_DOWNLOAD_MAX_BYTES);
    } finally {
      clearTimeout(timer);
    }
    const suggestedName = input.fileName
      || parseContentDispositionFileName(response.headers.get('content-disposition'))
      || fileNameFromUrl(url)
      || `download-${Date.now()}.bin`;
    const fileName = sanitizeFileName(suggestedName, `download-${Date.now()}.bin`);
    const dir = artifactDir(input.runId, 'downloads');
    await mkdir(dir, { recursive: true });
    const target = await uniqueArtifactPath(dir, fileName);
    await writeFile(target.filePath, buffer);

    return {
      ok: true,
      actual: JSON.stringify(artifactResultPayload({
        kind: 'download',
        fileName: target.fileName,
        filePath: target.filePath,
        bytes: buffer.byteLength,
        sourceUrl: url,
      })),
    };
  } catch (error) {
    return { ok: false, actual: `downloadFile failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function generateFileArtifact(input: GenerateArtifactInput): Promise<BrowserActionResult> {
  try {
    if (!String(input.fileName || '').trim()) {
      return { ok: false, actual: 'generateFile failed: fileName with a supported extension is required.' };
    }
    const requestedName = sanitizeFileName(
      input.fileName,
      `document-${Date.now()}.md`,
    );
    const generated = await generateFileBuffer({
      content: input.content,
      documentType: input.documentType,
      fileName: requestedName,
      sheets: input.sheets,
      slides: input.slides,
      subtitle: input.subtitle,
      theme: input.theme,
      title: input.title,
    });
    const dir = artifactDir(input.runId, 'generated');
    await mkdir(dir, { recursive: true });
    const target = await uniqueArtifactPath(dir, requestedName);
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

    return {
      ok: true,
      actual: JSON.stringify({
        ...artifactResultPayload({
          kind: 'generated',
          fileName: target.fileName,
          filePath: target.filePath,
          bytes: generated.buffer.byteLength,
        }),
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
    return { ok: false, actual: `generateFile failed: ${error instanceof Error ? error.message : String(error)}` };
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
  if (tool.name !== 'downloadFile' && tool.name !== 'generateFile' && tool.name !== 'fillDocumentTemplate') return undefined;
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

export function appendMissingFileArtifactDownloadLinks(reply: string, tools: FileArtifactToolResult[]) {
  const downloads = tools
    .map(fileArtifactDownloadFromToolResult)
    .filter((item): item is FileArtifactDownload => Boolean(item));
  const unique = [...new Map(downloads.map((item) => [item.artifactId, item])).values()];
  const repairedReply = repairArtifactDownloadLinks(reply, unique);
  const missing = unique.filter((item) => !repairedReply.includes(item.downloadUrl));
  if (!missing.length) return repairedReply;
  const links = missing.map((item) => `- [${escapeMarkdownLinkLabel(item.fileName)}](${item.downloadUrl})`).join('\n');
  return [repairedReply.trim(), `## 文件下载\n\n${links}`].filter(Boolean).join('\n\n');
}
