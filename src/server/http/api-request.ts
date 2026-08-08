import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { noStoreJson } from './no-store-response';
import { incrementMetric, structuredLog } from '@/server/observability/runtime-observability';

export class ApiRequestError extends Error {
  code: string;
  status: number;

  constructor(message: string, input: { code?: string; status?: number } = {}) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = input.code || 'invalid_request';
    this.status = input.status || 400;
  }
}

export function apiRequestId(request: Pick<Request, 'headers'>) {
  const supplied = String(request.headers.get('x-request-id') || '').trim();
  return /^[a-zA-Z0-9._:-]{8,128}$/.test(supplied) ? supplied : randomUUID();
}

export async function parseJsonRequest<T extends z.ZodType>(
  request: Request,
  schema: T,
  input: { maxBytes?: number } = {},
): Promise<z.infer<T>> {
  const maxBytes = Math.max(1024, Math.floor(input.maxBytes || 1024 * 1024));
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ApiRequestError('Request body is too large', { code: 'payload_too_large', status: 413 });
  }
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new ApiRequestError('Request body must be valid JSON');
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxBytes) {
    throw new ApiRequestError('Request body is too large', { code: 'payload_too_large', status: 413 });
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiRequestError('Request body is invalid', { code: 'validation_failed' });
  }
  return parsed.data;
}

export async function parseOptionalJsonRequest<T extends z.ZodType>(
  request: Request,
  schema: T,
  input: { maxBytes?: number } = {},
): Promise<z.infer<T>> {
  const maxBytes = Math.max(1024, Math.floor(input.maxBytes || 1024 * 1024));
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ApiRequestError('Request body is too large', { code: 'payload_too_large', status: 413 });
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
    throw new ApiRequestError('Request body is too large', { code: 'payload_too_large', status: 413 });
  }
  let value: unknown = {};
  if (raw.trim()) {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ApiRequestError('Request body must be valid JSON');
    }
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiRequestError('Request body is invalid', { code: 'validation_failed' });
  return parsed.data;
}

export function apiJson<T>(request: Pick<Request, 'headers'>, body: T, init: ResponseInit = {}) {
  const requestId = apiRequestId(request);
  const headers = new Headers(init.headers);
  headers.set('x-request-id', requestId);
  incrementMetric('api_responses_total', { status: init.status || 200 });
  return noStoreJson(body, { ...init, headers });
}

export function apiError(
  request: Pick<Request, 'headers'>,
  error: unknown,
  input: { code?: string; fallback: string; status?: number },
) {
  const requestId = apiRequestId(request);
  const known = error instanceof ApiRequestError;
  const status = known ? error.status : input.status || 400;
  const code = known ? error.code : input.code || (status >= 500 ? 'internal_error' : 'request_failed');
  const message = known ? error.message : input.fallback;
  incrementMetric('api_errors_total', { code, status });
  if (!known || status >= 500) {
    structuredLog({
      event: 'api.request.failed',
      level: status >= 500 ? 'error' : 'warn',
      requestId,
      code,
      status,
      error,
    });
  }
  return noStoreJson(
    { code, error: message, requestId },
    { status, headers: { 'x-request-id': requestId } },
  );
}

export function boundedQueryInteger(
  value: string | null,
  input: { fallback: number; max: number; min?: number },
) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return input.fallback;
  return Math.max(input.min ?? 1, Math.min(input.max, Math.floor(numeric)));
}
