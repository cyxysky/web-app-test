import { NextRequest } from 'next/server';
import { store } from '@/server/db/store';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { apiError, apiJson, boundedQueryInteger, parseJsonRequest } from '@/server/http/api-request';
import { skillRequestSchema } from '@/server/http/skill-request.schema';
import { idempotencyFingerprint, runIdempotentJson } from '@/server/http/idempotency';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function requestUserId(request: NextRequest) {
  return requestApplicationUserId(request);
}

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get('q') || undefined;
  const limit = boundedQueryInteger(request.nextUrl.searchParams.get('limit'), { fallback: 200, max: 500 });
  const skills = store.listSkills(query, requestUserId(request), limit);
  return apiJson(request, { skills });
}

export async function POST(request: NextRequest) {
  try {
    const body = await parseJsonRequest(request, skillRequestSchema, { maxBytes: 256 * 1024 });
    const userId = requestUserId(request);
    return runIdempotentJson(request, {
      fingerprint: idempotencyFingerprint(body),
      scope: 'skills.create',
      userId,
    }, () => {
      const skill = store.upsertSkill({ ...body, userId });
      return apiJson(request, { skill });
    });
  } catch (error) {
    return apiError(request, error, { fallback: 'Invalid skill' });
  }
}
