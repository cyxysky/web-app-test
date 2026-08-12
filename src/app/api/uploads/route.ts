import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { artifactApiUrlFromRelative } from '@/lib/artifacts';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { artifactPath } from '@/server/storage/paths';
import { ApiRequestError, apiError, apiJson } from '@/server/http/api-request';
import { readReferencedUploadPaths } from '@/server/storage/sqlite-record-store';
import {
  enforceUserUploadQuota,
  scheduleUploadArtifactMaintenance,
  userUploadUsage,
} from '@/server/storage/upload-artifact-lifecycle';

const allowedExtensions = new Set([
  '.apng', '.bin', '.csv', '.docx', '.gif', '.jpeg', '.jpg', '.json', '.md', '.pdf',
  '.png', '.pptx', '.tsv', '.txt', '.webp', '.xls', '.xlsx', '.xml', '.yaml', '.yml', '.zip',
]);

function uploadMaxBytes() {
  const configured = Number(process.env.WEBPILOT_UPLOAD_MAX_BYTES || 50 * 1024 * 1024);
  return Number.isFinite(configured)
    ? Math.min(512 * 1024 * 1024, Math.max(1024, Math.floor(configured)))
    : 50 * 1024 * 1024;
}

function decodedUploadName(value: string | null) {
  if (!value || value.length > 2_048) return 'upload.bin';
  try {
    return decodeURIComponent(value).trim() || 'upload.bin';
  } catch {
    throw new ApiRequestError('Upload file name is invalid');
  }
}

function uploadByteLimiter(maxBytes: number) {
  let bytes = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        callback(new ApiRequestError('Upload is too large', { code: 'payload_too_large', status: 413 }));
        return;
      }
      callback(null, chunk);
    },
  });
  return { bytes: () => bytes, stream };
}

scheduleUploadArtifactMaintenance(readReferencedUploadPaths);

export async function GET(request: NextRequest) {
  try {
    return apiJson(request, { usage: await userUploadUsage(requestApplicationUserId(request)) });
  } catch (error) {
    return apiError(request, error, { code: 'upload_usage_failed', fallback: 'Unable to read upload usage', status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const maxBytes = uploadMaxBytes();
    const contentLengthHeader = request.headers.get('content-length');
    const contentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
    const isRawUpload = request.headers.get('x-webpilot-upload') === 'raw';
    const requestLimit = isRawUpload ? maxBytes : maxBytes + 1024 * 1024;
    if (contentLength !== undefined && Number.isFinite(contentLength) && contentLength > requestLimit) {
      throw new ApiRequestError('Upload is too large', { code: 'payload_too_large', status: 413 });
    }
    let name: string;
    let type: string;
    let source: Readable;
    if (isRawUpload) {
      if (!request.body) throw new ApiRequestError('File is required');
      name = decodedUploadName(request.headers.get('x-webpilot-file-name'));
      type = String(request.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
      source = Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0]);
    } else {
      const form = await request.formData().catch(() => {
        throw new ApiRequestError('Upload request must be valid multipart form data');
      });
      const file = form.get('file');
      if (!(file instanceof File)) throw new ApiRequestError('File is required');
      if (file.size <= 0 || file.size > maxBytes) {
        throw new ApiRequestError(`File size must be between 1 byte and ${maxBytes} bytes`, {
          code: 'payload_too_large',
          status: 413,
        });
      }
      name = file.name;
      type = file.type || 'application/octet-stream';
      source = Readable.fromWeb(file.stream() as Parameters<typeof Readable.fromWeb>[0]);
    }

    const requestedExtension = path.extname(name).toLowerCase();
    const ext = allowedExtensions.has(requestedExtension)
      ? requestedExtension
      : type.startsWith('image/') ? '.png' : '.bin';
    const prefix = type.startsWith('image/') ? 'img' : 'file';
    const fileId = `${prefix}_${Date.now()}_${randomUUID().slice(0, 12)}${ext}`;
    const userId = requestApplicationUserId(request);
    const relativePath = `uploads/${userId}/${fileId}`;
    const dir = artifactPath('uploads', userId);
    const filePath = path.join(dir, fileId);

    await mkdir(dir, { recursive: true });
    const limiter = uploadByteLimiter(maxBytes);
    try {
      await pipeline(
        source,
        limiter.stream,
        createWriteStream(filePath, { flags: 'wx', mode: 0o600 }),
      );
      if (limiter.bytes() <= 0) throw new ApiRequestError('File must not be empty');
    } catch (error) {
      await unlink(filePath).catch(() => undefined);
      throw error;
    }

    const quota = await enforceUserUploadQuota(userId, readReferencedUploadPaths(userId), { protectedPath: filePath });
    if (quota.overQuota) {
      await unlink(filePath).catch(() => undefined);
      throw new ApiRequestError('Upload storage quota exceeded', { code: 'storage_quota_exceeded', status: 413 });
    }

    return apiJson(request, {
      fileId,
      imageId: type.startsWith('image/') ? fileId : undefined,
      path: relativePath,
      url: artifactApiUrlFromRelative(relativePath),
      name,
      type,
      size: limiter.bytes(),
    });
  } catch (error) {
    return apiError(request, error, {
      code: 'upload_failed',
      fallback: 'File upload failed',
      status: 500,
    });
  }
}
