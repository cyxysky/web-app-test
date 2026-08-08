import { NextRequest } from 'next/server';
import {
  listPersonalMemoryItems,
  personalMemoryDiagnostics,
  savePersonalMemoryItem,
} from '@/server/ai/personal-memory';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { apiError, apiJson, boundedQueryInteger, parseJsonRequest } from '@/server/http/api-request';
import { personalMemoryRequestSchema } from '@/server/http/personal-memory-request.schema';
import { idempotencyFingerprint, runIdempotentJson } from '@/server/http/idempotency';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function requestUserId(request: NextRequest) {
  return requestApplicationUserId(request);
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const userId = requestUserId(request);
  const domain = url.searchParams.get('domain') || '';
  const includeDisabled = url.searchParams.get('includeDisabled') === 'true';
  const limit = boundedQueryInteger(url.searchParams.get('limit'), { fallback: 200, max: 500 });
  return apiJson(request, {
    items: listPersonalMemoryItems({ userId, domain, includeDisabled, limit }),
    diagnostics: personalMemoryDiagnostics(),
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await parseJsonRequest(request, personalMemoryRequestSchema, { maxBytes: 64 * 1024 });
    const userId = requestUserId(request);
    return runIdempotentJson(request, {
      fingerprint: idempotencyFingerprint(body),
      scope: 'personal-memory.create',
      userId,
    }, () => {
      const item = savePersonalMemoryItem({ ...body, userId });
      return apiJson(request, { item });
    });
  } catch (error) {
    return apiError(request, error, { fallback: 'Failed to save personal memory item' });
  }
}
