import { NextRequest } from 'next/server';
import {
  deletePersonalMemoryItem,
  getPersonalMemoryItem,
  updatePersonalMemoryItem,
} from '@/server/ai/personal-memory';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { ApiRequestError, apiError, apiJson, parseJsonRequest } from '@/server/http/api-request';
import { personalMemoryPatchSchema } from '@/server/http/personal-memory-request.schema';
import { idempotencyFingerprint, runIdempotentJson } from '@/server/http/idempotency';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ id: string }>;
};

function requestUserId(request: NextRequest) {
  return requestApplicationUserId(request);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = await parseJsonRequest(
      request,
      personalMemoryPatchSchema,
      { maxBytes: 64 * 1024 },
    );
    const userId = requestUserId(request);
    return runIdempotentJson(request, {
      fingerprint: idempotencyFingerprint({ id, ...body }),
      scope: 'personal_memory.update',
      userId,
    }, () => {
      const visibleItem = getPersonalMemoryItem(id, userId);
      if (visibleItem && visibleItem.userId !== userId) throw new ApiRequestError('Only the memory creator can edit this shared memory', { code: 'forbidden', status: 403 });
      const item = updatePersonalMemoryItem(id, body, userId);
      if (!item) throw new ApiRequestError('Personal memory item not found', { code: 'not_found', status: 404 });
      return apiJson(request, { item });
    });
  } catch (error) {
    return apiError(request, error, { fallback: 'Failed to update personal memory item' });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const userId = requestUserId(request);
    return runIdempotentJson(request, {
      fingerprint: idempotencyFingerprint({ id }),
      scope: 'personal_memory.delete',
      userId,
    }, () => {
      const visibleItem = getPersonalMemoryItem(id, userId);
      if (visibleItem && visibleItem.userId !== userId) throw new ApiRequestError('Only the memory creator can delete this shared memory', { code: 'forbidden', status: 403 });
      const deleted = deletePersonalMemoryItem(id, userId);
      if (!deleted) throw new ApiRequestError('Personal memory item not found', { code: 'not_found', status: 404 });
      return apiJson(request, { ok: true, deleted });
    });
  } catch (error) {
    return apiError(request, error, { fallback: 'Failed to delete personal memory item' });
  }
}
