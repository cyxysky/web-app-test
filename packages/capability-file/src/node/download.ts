import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { raceWithAbort, type CapabilityHealth } from '@webpilot/capability-sdk';
import {
  fileFormatForExtension as defaultFileFormatForExtension,
  fileFormatForMimeType as defaultFileFormatForMimeType,
} from '../formats.js';
import type { FileArtifactOperationResult } from '../types.js';
import {
  createNodeArtifactPayload,
  nodeArtifactFileExtension,
  sanitizeNodeArtifactFileName,
  uniqueNodeArtifactPath,
  type NodeArtifactPayload,
  type NodeArtifactUrlResolver,
} from './artifacts.js';

const defaultTimeoutMs = 120_000;
const defaultMaxBytes = 50 * 1024 * 1024;
const defaultRetryDelaysMs = [750, 1_500, 3_000] as const;
const defaultMaxRetryAfterMs = 2_000;
const defaultMaxConcurrentPerOrigin = 2;
const downloadCacheVersion = 'mime-extension-v1';

export type NodeFileDownloadInput = {
  runId?: string;
  url?: string;
  path?: string;
  urlOrPath?: string;
  sourcePageUrl?: string;
  fileName?: string | null;
  fileType?: string | null;
};

export type NodeFileDownloadFormat = {
  extension: string;
  mimeType: string;
};

export type NodeFileDownloadArtifact = NodeArtifactPayload<'download'> & {
  sourceUrl: string;
  cacheHit: boolean;
};

export type NodeFileDownloaderOptions = {
  artifactsRoot: string;
  artifactUrl?: NodeArtifactUrlResolver;
  downloadsDirectory?: (runId?: string) => string;
  fetch?: typeof globalThis.fetch;
  formatForExtension?: (extension: string) => NodeFileDownloadFormat | undefined;
  formatForMimeType?: (mimeType: string) => NodeFileDownloadFormat | undefined;
  maxBytes?: number;
  maxConcurrentPerOrigin?: number;
  maxRetryAfterMs?: number;
  retryDelaysMs?: readonly number[];
  timeoutMs?: number;
  userAgent?: string;
};

export type NodeFileDownloadExecutionOptions = {
  abortSignal?: AbortSignal;
};

export interface NodeFileDownloader {
  download(
    input: NodeFileDownloadInput,
    options?: NodeFileDownloadExecutionOptions,
  ): Promise<FileArtifactOperationResult>;
  health(): Promise<CapabilityHealth>;
  dispose(): Promise<void>;
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
    throw new Error('download requires fileType as an extension without a dot, for example jpg, pdf, or docx.');
  }
  return `.${fileType}`;
}

function resolveDownloadUrl(input: NodeFileDownloadInput) {
  const raw = String(input.url || input.urlOrPath || input.path || '').trim();
  if (!raw) throw new Error('download requires url, path, or urlOrPath.');
  if (/^[a-z]:[\\/]|^\\\\|^file:/i.test(raw)) {
    throw new Error('download accepts HTTP(S) URLs or page-relative URL paths, not operating-system file paths. Use an uploaded/host-bound attachment asset; do not retry this path with sourcePageUrl.');
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  const sourcePageUrl = String(input.sourcePageUrl || '').trim();
  if (!sourcePageUrl) {
    throw new Error('download needs a source page URL to resolve relative paths; provide an absolute URL instead.');
  }
  try {
    return new URL(raw, sourcePageUrl).toString();
  } catch {
    throw new Error(`download cannot resolve "${raw}" against source page URL "${sourcePageUrl}".`);
  }
}

function alternateWikimediaThumbnailUrls(url: string) {
  try {
    const parsed = new URL(url);
    if (!['upload.wikimedia.org', 'thumb.wikimedia.org'].includes(parsed.hostname)) return undefined;
    const match = parsed.pathname.match(/^(.*\/)(\d+)px-([^/]+)$/i);
    if (!match) return undefined;
    const requestedWidth = Number(match[2]);
    return [250, 330, 500, 640, 800, 1024, 1280]
      .filter((width) => width !== requestedWidth)
      .sort((left, right) => Math.abs(left - requestedWidth) - Math.abs(right - requestedWidth))
      .slice(0, 3)
      .map((width) => {
        const candidate = new URL(parsed);
        candidate.hostname = 'thumb.wikimedia.org';
        candidate.pathname = `${match[1]}${width}px-${match[3]}`;
        return candidate.toString();
      });
  } catch {
    return undefined;
  }
}

function preferredDownloadUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'upload.wikimedia.org' && parsed.pathname.includes('/wikipedia/commons/thumb/')) {
      parsed.hostname = 'thumb.wikimedia.org';
      return parsed.toString();
    }
  } catch {
    // Preserve the original value so normal URL validation reports the error.
  }
  return url;
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

export function createNodeFileDownloader(
  options: NodeFileDownloaderOptions,
): NodeFileDownloader {
  const artifactsRoot = path.resolve(options.artifactsRoot);
  const timeoutMs = Math.max(1_000, Math.trunc(options.timeoutMs || defaultTimeoutMs));
  const maxBytes = Math.max(1, Math.trunc(options.maxBytes || defaultMaxBytes));
  const retryDelaysMs = options.retryDelaysMs?.length
    ? options.retryDelaysMs.map((value) => Math.max(0, Math.trunc(value)))
    : [...defaultRetryDelaysMs];
  const maxRetryAfterMs = Math.max(0, Math.trunc(options.maxRetryAfterMs ?? defaultMaxRetryAfterMs));
  const maxConcurrentPerOrigin = Math.max(
    1,
    Math.trunc(options.maxConcurrentPerOrigin || defaultMaxConcurrentPerOrigin),
  );
  const activeDownloads = new Map<string, Promise<FileArtifactOperationResult>>();
  const activeControllers = new Set<AbortController>();
  const originStates = new Map<string, { active: number; waiters: Array<() => void> }>();
  let disposed = false;

  const formatForExtension = (extension: string) => (
    options.formatForExtension?.(extension)
    || defaultFileFormatForExtension(extension)
  );
  const formatForMimeType = (mimeType: string) => (
    options.formatForMimeType?.(mimeType)
    || defaultFileFormatForMimeType(mimeType)
  );
  const downloadsDirectory = (runId?: string) => path.resolve(
    options.downloadsDirectory?.(runId)
      || path.join(artifactsRoot, sanitizeNodeArtifactFileName(runId, 'adhoc'), 'downloads'),
  );

  function sameRegisteredFileType(left: string, right: string) {
    const leftMime = formatForExtension(left)?.mimeType.split(';')[0].trim().toLowerCase();
    const rightMime = formatForExtension(right)?.mimeType.split(';')[0].trim().toLowerCase();
    return Boolean(leftMime && rightMime && leftMime === rightMime);
  }

  function fileNameWithResponseExtension(
    fileName: string,
    requestedExtension: string,
    contentType: string | null,
  ) {
    const normalizedContentType = String(contentType || '').split(';')[0].trim().toLowerCase();
    const responseExtension = normalizedContentType && normalizedContentType !== 'application/octet-stream'
      ? formatForMimeType(normalizedContentType)?.extension
      : undefined;
    const effectiveExtension = !responseExtension || sameRegisteredFileType(requestedExtension, responseExtension)
      ? requestedExtension
      : responseExtension;
    const currentExtension = nodeArtifactFileExtension(fileName);
    if (!currentExtension) return `${fileName}${effectiveExtension}`;
    if (currentExtension === effectiveExtension || sameRegisteredFileType(currentExtension, effectiveExtension)) {
      return fileName;
    }
    return `${fileName.slice(0, -currentExtension.length)}${effectiveExtension}`;
  }

  function artifactPayload(input: {
    bytes: number;
    fileName: string;
    filePath: string;
    sourceUrl: string;
    cacheHit: boolean;
  }): NodeFileDownloadArtifact {
    return {
      ...createNodeArtifactPayload({
        artifactsRoot,
        artifactUrl: options.artifactUrl,
      }, {
        bytes: input.bytes,
        fileName: input.fileName,
        filePath: input.filePath,
        kind: 'download',
      }),
      sourceUrl: input.sourceUrl,
      cacheHit: input.cacheHit,
    };
  }

  function downloadRequestInit(url: string, signal: AbortSignal): RequestInit {
    const wikimedia = /(?:^|\.)wikimedia\.org$/i.test(new URL(url).hostname);
    return {
      signal,
      redirect: 'follow',
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'User-Agent': options.userAgent || 'WebPilot-Office-Artifact/1.0 (local user-requested media fetch)',
        ...(wikimedia ? { Referer: 'https://commons.wikimedia.org/' } : {}),
      },
    };
  }

  async function fetchDownloadResponse(url: string, signal: AbortSignal) {
    const request = options.fetch || globalThis.fetch;
    const preferredUrl = preferredDownloadUrl(url);
    let resolvedUrl = preferredUrl;
    let response = await request(resolvedUrl, downloadRequestInit(resolvedUrl, signal));
    if (response.ok || response.status !== 400) return { response, resolvedUrl };
    for (const candidate of alternateWikimediaThumbnailUrls(preferredUrl) || []) {
      await response.body?.cancel().catch(() => undefined);
      resolvedUrl = candidate;
      response = await request(resolvedUrl, downloadRequestInit(resolvedUrl, signal));
      if (response.ok || response.status !== 400) break;
    }
    return { response, resolvedUrl };
  }

  function downloadRetryDelay(attempt: number) {
    return retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)] || 0;
  }

  function rateLimitRetryDelay(response: Response, attempt: number) {
    const header = String(response.headers.get('retry-after') || '').trim();
    const seconds = Number(header);
    const parsed = Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1_000
      : header ? Date.parse(header) - Date.now() : Number.NaN;
    if (!Number.isFinite(parsed) || parsed < 0) return downloadRetryDelay(attempt);
    return Math.max(downloadRetryDelay(attempt), Math.min(parsed, maxRetryAfterMs));
  }

  async function fetchDownloadResponseWithRetry(url: string, signal: AbortSignal) {
    const retryable = new Set([429, 502, 503, 504]);
    for (let attempt = 0; ; attempt += 1) {
      const result = await fetchDownloadResponse(url, signal);
      const retryLimit = result.response.status === 429 ? 1 : retryDelaysMs.length;
      if (!retryable.has(result.response.status) || attempt >= retryLimit) return result;
      const delayMs = result.response.status === 429
        ? rateLimitRetryDelay(result.response, attempt)
        : downloadRetryDelay(attempt);
      await result.response.body?.cancel().catch(() => undefined);
      await raceWithAbort(new Promise<void>((resolve) => setTimeout(resolve, delayMs)), signal);
    }
  }

  function originKey(url: string) {
    try {
      return new URL(url).origin.toLowerCase();
    } catch {
      return url;
    }
  }

  async function acquireOriginSlot(url: string) {
    const origin = originKey(url);
    const state = originStates.get(origin) || { active: 0, waiters: [] };
    originStates.set(origin, state);
    if (state.active >= maxConcurrentPerOrigin) {
      await new Promise<void>((resolve) => state.waiters.push(resolve));
    } else {
      state.active += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = state.waiters.shift();
      if (next) {
        next();
        return;
      }
      state.active -= 1;
      if (state.active === 0) originStates.delete(origin);
    };
  }

  async function withOriginSlot<T>(url: string, operation: () => Promise<T>) {
    const release = await acquireOriginSlot(url);
    try {
      if (disposed) throw new Error('File downloader has been disposed.');
      return await operation();
    } finally {
      release();
    }
  }

  function cacheKey(input: NodeFileDownloadInput, url: string) {
    return createHash('sha256')
      .update(`${downloadCacheVersion}\n${url}\n${String(input.fileName || '')}\n${String(input.fileType || '')}`, 'utf8')
      .digest('hex');
  }

  function createController(externalSignal?: AbortSignal) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(
      externalSignal?.reason instanceof Error
        ? externalSignal.reason
        : new Error('Download aborted.'),
    );
    if (externalSignal?.aborted) onAbort();
    else externalSignal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error(`Download timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    activeControllers.add(controller);
    return {
      controller,
      dispose() {
        clearTimeout(timer);
        externalSignal?.removeEventListener('abort', onAbort);
        activeControllers.delete(controller);
      },
    };
  }

  async function downloadUnlocked(
    input: NodeFileDownloadInput,
    url: string,
    key: string,
    execution: NodeFileDownloadExecutionOptions,
  ): Promise<FileArtifactOperationResult> {
    try {
      const directory = downloadsDirectory(input.runId);
      const relativeDirectory = path.relative(artifactsRoot, directory);
      if (relativeDirectory.startsWith('..') || path.isAbsolute(relativeDirectory)) {
        throw new Error('Downloads directory must stay inside the configured artifact root.');
      }
      const cacheDirectory = path.join(directory, '.url-cache');
      const cachePath = path.join(cacheDirectory, `${key}.json`);
      try {
        const cached = JSON.parse(await readFile(cachePath, 'utf8')) as NodeFileDownloadArtifact;
        const cachedPath = path.resolve(String(cached.path || ''));
        const relative = path.relative(directory, cachedPath);
        const metadata = relative && !relative.startsWith('..') && !path.isAbsolute(relative)
          ? await stat(cachedPath)
          : undefined;
        if (metadata?.isFile()) {
          return {
            ok: true,
            actual: JSON.stringify(artifactPayload({
              bytes: metadata.size,
              fileName: cached.fileName,
              filePath: cachedPath,
              sourceUrl: cached.sourceUrl,
              cacheHit: true,
            })),
          };
        }
      } catch {
        // A missing or stale URL cache is a normal cache miss.
      }

      const controlled = createController(execution.abortSignal);
      try {
        const { response, resolvedUrl } = await fetchDownloadResponseWithRetry(
          url,
          controlled.controller.signal,
        );
        if (!response.ok) {
          const guidance = response.status === 429
            ? ' after bounded automatic retries; use a different source or origin instead of sleeping and retrying this URL'
            : '';
          return {
            ok: false,
            actual: `download failed: HTTP ${response.status} ${response.statusText}${guidance} for ${resolvedUrl}`,
          };
        }
        const suggestedName = input.fileName
          || parseContentDispositionFileName(response.headers.get('content-disposition'))
          || fileNameFromUrl(resolvedUrl)
          || `download-${Date.now()}.bin`;
        const sanitizedName = sanitizeNodeArtifactFileName(suggestedName, `download-${Date.now()}.bin`);
        const fileName = fileNameWithResponseExtension(
          sanitizedName,
          normalizedDownloadFileType(input.fileType),
          response.headers.get('content-type'),
        );
        await mkdir(directory, { recursive: true });
        const target = await uniqueNodeArtifactPath(directory, fileName);
        let bytes = 0;
        try {
          bytes = await writeLimitedResponse(response, target.filePath, maxBytes);
        } catch (error) {
          await unlink(target.filePath).catch(() => undefined);
          throw error;
        }
        const payload = artifactPayload({
          bytes,
          fileName: target.fileName,
          filePath: target.filePath,
          sourceUrl: resolvedUrl,
          cacheHit: false,
        });
        await mkdir(cacheDirectory, { recursive: true });
        await writeFile(cachePath, JSON.stringify(payload), 'utf8');
        return { ok: true, actual: JSON.stringify(payload) };
      } finally {
        controlled.dispose();
      }
    } catch (error) {
      return {
        ok: false,
        actual: `download failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async function download(
    input: NodeFileDownloadInput,
    execution: NodeFileDownloadExecutionOptions = {},
  ): Promise<FileArtifactOperationResult> {
    if (disposed) return { ok: false, actual: 'download failed: file downloader has been disposed.' };
    let requestedExtension: string;
    try {
      requestedExtension = normalizedDownloadFileType(input.fileType);
    } catch (error) {
      return { ok: false, actual: `download failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    const explicitExtension = nodeArtifactFileExtension(String(input.fileName || ''));
    if (
      explicitExtension
      && explicitExtension !== requestedExtension
      && !sameRegisteredFileType(explicitExtension, requestedExtension)
    ) {
      return {
        ok: false,
        actual: `download failed: fileName extension ${explicitExtension} does not match fileType ${input.fileType}.`,
      };
    }
    let url: string;
    try {
      url = resolveDownloadUrl(input);
    } catch (error) {
      return { ok: false, actual: `download failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    const key = cacheKey(input, url);
    const activeKey = `${sanitizeNodeArtifactFileName(input.runId, 'adhoc')}:${key}`;
    const existing = activeDownloads.get(activeKey);
    if (existing) return existing;
    const pending = withOriginSlot(url, () => downloadUnlocked(input, url, key, execution));
    activeDownloads.set(activeKey, pending);
    try {
      return await pending;
    } finally {
      if (activeDownloads.get(activeKey) === pending) activeDownloads.delete(activeKey);
    }
  }

  return {
    download,
    health: () => Promise.resolve({
      status: disposed ? 'unhealthy' : 'healthy',
      message: disposed ? 'File downloader has been disposed.' : undefined,
      details: { artifactsRoot },
    }),
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const controller of activeControllers) {
        controller.abort(new Error('File downloader disposed.'));
      }
      for (const state of originStates.values()) {
        for (const resume of state.waiters.splice(0)) resume();
      }
      await Promise.allSettled(activeDownloads.values());
      activeControllers.clear();
      activeDownloads.clear();
      originStates.clear();
    },
  };
}
