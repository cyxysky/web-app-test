import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { normalizeApplicationUserId, requestApplicationUserId } from '@/server/auth/user-context';
import type { BrowserChatSessionSnapshot } from '@/server/ai/agents/browser-chat.service';
import { readBrowserChatSessionHeader } from '@/server/storage/browser-chat-history-store';
import { artifactsRoot } from '@/server/storage/paths';
import { ApiRequestError, apiError, apiRequestId } from '@/server/http/api-request';

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

const contentTypes: Record<string, string> = {
  '.apng': 'image/apng',
  '.gif': 'image/gif',
  '.csv': 'text/csv; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xml': 'application/xml; charset=utf-8',
  '.yaml': 'application/yaml; charset=utf-8',
  '.yml': 'application/yaml; charset=utf-8',
  '.zip': 'application/zip',
};

function resolveArtifactPath(segments: string[]) {
  const root = artifactsRoot();
  const filePath = path.resolve(root, ...segments);
  const relative = path.relative(root, filePath);

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return filePath;
}

function contentDispositionHeader(filePath: string) {
  return path.basename(filePath).replace(/["\r\n]/g, '_');
}

function artifactBelongsToUser(segments: string[], userId: string) {
  if (segments[0] === 'uploads') {
    return segments.length >= 3 ? segments[1] === userId : userId === normalizeApplicationUserId(undefined);
  }
  if (segments[0]?.startsWith('chat_')) {
    const session = readBrowserChatSessionHeader<BrowserChatSessionSnapshot>(segments[0]);
    return Boolean(session && normalizeApplicationUserId(session.userId) === userId);
  }
  return userId === normalizeApplicationUserId(undefined);
}

function requestedByteRange(value: string | null, size: number) {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[2] && match[1] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return null;
  return { end: Math.min(end, size - 1), start };
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const requestId = apiRequestId(request);
    const { path: pathSegments } = await context.params;
    const filePath = resolveArtifactPath(pathSegments || []);
    if (!filePath) throw new ApiRequestError('Invalid artifact path');
    const userId = requestApplicationUserId(request);
    if (!artifactBelongsToUser(pathSegments, userId)) {
      throw new ApiRequestError('Artifact not found', { code: 'not_found', status: 404 });
    }
    const fileStat = await stat(/*turbopackIgnore: true*/ filePath);
    if (!fileStat.isFile()) {
      throw new ApiRequestError('Artifact not found', { code: 'not_found', status: 404 });
    }

    const contentType = contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const range = requestedByteRange(request.headers.get('range'), fileStat.size);
    if (range === null) {
      return new NextResponse(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${fileStat.size}`, 'x-request-id': requestId },
      });
    }

    const headers: Record<string, string> = {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Length': String(range ? range.end - range.start + 1 : fileStat.size),
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
      'x-request-id': requestId,
    };
    if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${fileStat.size}`;
    if (request.nextUrl.searchParams.get('download') === '1') {
      const fileName = contentDispositionHeader(filePath);
      const asciiName = fileName.replace(/[^\x20-\x7E]/g, '_');
      headers['Content-Disposition'] = `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
    }

    const body = Readable.toWeb(createReadStream(filePath, range || undefined)) as unknown as BodyInit;
    return new NextResponse(body, { headers, status: range ? 206 : 200 });
  } catch (error) {
    return apiError(request, error, {
      code: 'not_found',
      fallback: 'Artifact not found',
      status: 404,
    });
  }
}
