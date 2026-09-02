import { NextRequest } from 'next/server';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { store } from '@/server/db/store';
import { ApiRequestError, apiError, apiJson, parseJsonRequest } from '@/server/http/api-request';
import { skillRequestSchema } from '@/server/http/skill-request.schema';
import { idempotencyFingerprint, runIdempotentJson } from '@/server/http/idempotency';

type RouteContext = {
  params: Promise<{ skillId: string }>;
};

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function requestUserId(request: NextRequest) {
  return requestApplicationUserId(request);
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { skillId } = await context.params;
  const skill = await store.getSkill(skillId, requestUserId(request));
  if (!skill) return apiError(request, new ApiRequestError('Skill not found', { code: 'not_found', status: 404 }), { fallback: 'Skill not found' });
  return apiJson(request, { skill });
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const { skillId } = await context.params;
  try {
    const body = await parseJsonRequest(request, skillRequestSchema.omit({ id: true }), { maxBytes: 256 * 1024 });
    const userId = requestUserId(request);
    return runIdempotentJson(request, {
      fingerprint: idempotencyFingerprint({ skillId, ...body }),
      scope: 'skill.update',
      userId,
    }, async () => {
      const current = await store.getSkill(skillId, userId);
      if (!current) throw new ApiRequestError('Skill not found', { code: 'not_found', status: 404 });
      if (current.userId !== userId) throw new ApiRequestError('Only the Skill creator can edit this shared Skill', { code: 'forbidden', status: 403 });
      const skill = await store.upsertSkill({ id: skillId, ...body, userId });
      return apiJson(request, { skill });
    });
  } catch (error) {
    return apiError(request, error, { fallback: 'Invalid skill' });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const { skillId } = await context.params;
    const userId = requestUserId(request);
    return runIdempotentJson(request, {
      fingerprint: idempotencyFingerprint({ skillId }),
      scope: 'skill.delete',
      userId,
    }, async () => {
      const current = await store.getSkill(skillId, userId);
      if (current && current.userId !== userId) throw new ApiRequestError('Only the Skill creator can delete this shared Skill', { code: 'forbidden', status: 403 });
      if (!await store.deleteSkill(skillId, userId)) throw new ApiRequestError('Skill not found', { code: 'not_found', status: 404 });
      return apiJson(request, { ok: true });
    });
  } catch (error) {
    return apiError(request, error, { fallback: 'Unable to delete Skill' });
  }
}
