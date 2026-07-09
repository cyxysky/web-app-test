import { NextRequest } from 'next/server';
import {
  deletePersonalMemoryItem,
  updatePersonalMemoryItem,
} from '@/server/ai/personal-memory';
import { noStoreJson } from '@/server/http/no-store-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ id: string }>;
};

function requestUserId(request: NextRequest, body?: { userId?: unknown; qzUserId?: unknown }) {
  const url = new URL(request.url);
  return String(body?.userId ?? body?.qzUserId ?? url.searchParams.get('userId') ?? url.searchParams.get('qzUserId') ?? '').trim();
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    const item = updatePersonalMemoryItem(id, body && typeof body === 'object' && !Array.isArray(body) ? body : {}, requestUserId(request, body));
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
    const deleted = deletePersonalMemoryItem(id, requestUserId(request));
    if (!deleted) return noStoreJson({ error: 'Personal memory item not found' }, { status: 404 });
    return noStoreJson({ ok: true, deleted });
  } catch (error) {
    return noStoreJson(
      { error: error instanceof Error ? error.message : 'Failed to delete personal memory item' },
      { status: 400 },
    );
  }
}
