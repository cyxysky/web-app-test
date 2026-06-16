import { randomUUID } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { artifactApiUrl, artifactApiUrlFromRelative } from '@/lib/artifacts';
import type { BrowserActionResult } from '@/server/browser/browser-session';
import { artifactPath, artifactsRoot } from '@/server/storage/paths';

type DownloadArtifactInput = {
  runId?: string;
  url?: string;
  path?: string;
  urlOrPath?: string;
  fileName?: string | null;
};

type MarkdownArtifactInput = {
  runId?: string;
  fileName?: string | null;
  title?: string | null;
  content?: string | null;
};

type ArtifactToolPayload = {
  kind?: string;
  fileName?: string;
  path?: string;
  url?: string;
  downloadUrl?: string;
  bytes?: number;
  sourceUrl?: string;
};

function positiveNumberEnv(name: string, fallback: number) {
  const value = Number(process.env[name] || '');
  return Number.isFinite(value) && value > 0 ? value : fallback;
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

function ensureMarkdownExtension(fileName: string) {
  if (path.extname(fileName).toLowerCase() === '.md') return fileName;
  const parsed = path.parse(fileName);
  return `${parsed.name || fileName}.md`;
}

function artifactDir(runId: string | undefined, kind: 'downloads' | 'markdown') {
  return artifactPath(sanitizeFileName(runId, 'adhoc'), kind);
}

function fileOutputDir(runId: string | undefined, kind: 'downloads' | 'markdown') {
  const configured = String(process.env.AI_FILE_OUTPUT_DIR || '').trim();
  if (!configured) return artifactDir(runId, kind);
  return path.resolve(configured);
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
  kind: 'download' | 'markdown';
}) {
  const root = artifactsRoot();
  const relative = path.relative(root, input.filePath).replace(/\\/g, '/');
  const url = relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? artifactApiUrlFromRelative(relative)
    : artifactApiUrl(input.filePath, { artifactsRoot: root });
  return {
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
  if (toolName !== 'downloadFile' && toolName !== 'generateMarkdownFile') return undefined;
  try {
    const payload = JSON.parse(actual || '{}') as ArtifactToolPayload;
    const label = toolName === 'downloadFile' ? 'File downloaded' : 'Markdown file generated';
    const target = payload.downloadUrl || payload.url || payload.path || '';
    return [
      `${label}: ${payload.fileName || 'artifact'}`,
      target ? `URL: ${target}` : '',
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

  const base = String(process.env.AI_FILE_DOWNLOAD_BASE_URL || '').trim();
  if (!base) {
    throw new Error('AI_FILE_DOWNLOAD_BASE_URL is not configured; provide an absolute URL or set the file download base URL in settings.');
  }
  return new URL(raw.replace(/^\/+/, ''), base.endsWith('/') ? base : `${base}/`).toString();
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
    const timeoutMs = positiveNumberEnv('AI_FILE_DOWNLOAD_TIMEOUT_MS', 30000);
    const maxBytes = Math.floor(positiveNumberEnv('AI_FILE_DOWNLOAD_MAX_MB', 50) * 1024 * 1024);
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(new Error(`Download timed out after ${timeoutMs}ms`)), timeoutMs);

    let response: Response;
    let buffer = Buffer.alloc(0);
    try {
      response = await fetch(url, { signal: abortController.signal });
      if (!response.ok) {
        return { ok: false, actual: `downloadFile failed: HTTP ${response.status} ${response.statusText} for ${url}` };
      }
      buffer = await readLimitedResponse(response, maxBytes);
    } finally {
      clearTimeout(timer);
    }
    const suggestedName = input.fileName
      || parseContentDispositionFileName(response.headers.get('content-disposition'))
      || fileNameFromUrl(url)
      || `download-${Date.now()}.bin`;
    const fileName = sanitizeFileName(suggestedName, `download-${Date.now()}.bin`);
    const dir = fileOutputDir(input.runId, 'downloads');
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

export async function generateMarkdownArtifact(input: MarkdownArtifactInput): Promise<BrowserActionResult> {
  try {
    const body = String(input.content || '').trim();
    if (!body) return { ok: false, actual: 'generateMarkdownFile failed: content is empty.' };

    const requestedName = ensureMarkdownExtension(
      sanitizeFileName(input.fileName || input.title || `markdown-${Date.now()}`, `markdown-${Date.now()}`),
    );
    const content = `${body}\n`;
    const dir = fileOutputDir(input.runId, 'markdown');
    await mkdir(dir, { recursive: true });
    const target = await uniqueArtifactPath(dir, requestedName);
    await writeFile(target.filePath, content, 'utf8');

    return {
      ok: true,
      actual: JSON.stringify(artifactResultPayload({
        kind: 'markdown',
        fileName: target.fileName,
        filePath: target.filePath,
        bytes: Buffer.byteLength(content, 'utf8'),
      })),
    };
  } catch (error) {
    return { ok: false, actual: `generateMarkdownFile failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
