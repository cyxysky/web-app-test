import { NextRequest } from 'next/server';
import { fuzzyRetrievalScore } from '@/lib/fuzzy-retrieval';
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
  const limit = boundedQueryInteger(request.nextUrl.searchParams.get('limit'), { fallback: 50, max: 100 });
  const userId = requestUserId(request);
  const page = query
    ? store.listSkills(undefined, userId, 2_000)
      .map((skill) => ({
        skill,
        score: fuzzyRetrievalScore(query, [skill.title, skill.description, ...skill.triggerPhrases]),
      }))
      .filter((item) => item.score >= 0.38)
      .sort((left, right) => right.score - left.score || right.skill.updatedAt.localeCompare(left.skill.updatedAt))
      .slice(0, limit + 1)
      .map((item) => item.skill)
    : store.listSkills(undefined, userId, limit + 1, {
      beforeId: request.nextUrl.searchParams.get('beforeId') || undefined,
      beforeUpdatedAt: request.nextUrl.searchParams.get('beforeUpdatedAt') || undefined,
    });
  const skills = page.slice(0, limit);
  const last = skills.at(-1);
  return apiJson(request, {
    skills,
    page: {
      hasMore: page.length > limit,
      next: page.length > limit && last
        ? { beforeId: last.id, beforeUpdatedAt: last.updatedAt }
        : undefined,
    },
  });
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
