import { NextRequest } from 'next/server';
import {
  deletePersonalMemoryItem,
  getPersonalMemoryItem,
  updatePersonalMemoryItem,
} from '@/server/ai/personal-memory';
import { noStoreJson } from '@/server/http/no-store-response';
import { normalizeApplicationUserId } from '@/server/auth/user-context';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ id: string }>;
};

function requestUserId(request: NextRequest, body?: { userId?: unknown; qzUserId?: unknown }) {
  const url = new URL(request.url);
  return normalizeApplicationUserId(body?.userId ?? body?.qzUserId ?? url.searchParams.get('userId') ?? url.searchParams.get('qzUserId') ?? '');
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    const userId = requestUserId(request, body);
    const visibleItem = getPersonalMemoryItem(id, userId);
    if (visibleItem && visibleItem.userId !== userId) return noStoreJson({ error: 'Only the memory creator can edit this shared memory' }, { status: 403 });
    const item = updatePersonalMemoryItem(id, body && typeof body === 'object' && !Array.isArray(body) ? body : {}, userId);
    if (!item) return noStoreJson({ error: 'Personal memory item not found' }, { status: 404 });
    return noStoreJson({ item });
  } catch (error) {
    return noStoreJson(
      { error: error instanceof Error ? error.message : 'Failed to update personal memory item' },
      { status: 400 },
    );
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const userId = requestUserId(request);
    const visibleItem = getPersonalMemoryItem(id, userId);
    if (visibleItem && visibleItem.userId !== userId) return noStoreJson({ error: 'Only the memory creator can delete this shared memory' }, { status: 403 });
    const deleted = deletePersonalMemoryItem(id, userId);
    if (!deleted) return noStoreJson({ error: 'Personal memory item not found' }, { status: 404 });
    return noStoreJson({ ok: true, deleted });
  } catch (error) {
    return noStoreJson(
      { error: error instanceof Error ? error.message : 'Failed to delete personal memory item' },
      { status: 400 },
    );
  }
}
