import { NextRequest } from 'next/server';
import {
  listPersonalMemoryItems,
  personalMemoryDiagnostics,
  savePersonalMemoryItem,
} from '@/server/ai/personal-memory';
import { noStoreJson } from '@/server/http/no-store-response';
import { normalizeApplicationUserId } from '@/server/auth/user-context';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function requestUserId(request: NextRequest, body?: { userId?: unknown; qzUserId?: unknown }) {
  const url = new URL(request.url);
  return normalizeApplicationUserId(body?.userId ?? body?.qzUserId ?? url.searchParams.get('userId') ?? url.searchParams.get('qzUserId') ?? '');
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const userId = requestUserId(request);
  const domain = url.searchParams.get('domain') || '';
  const includeDisabled = url.searchParams.get('includeDisabled') === 'true';
  return noStoreJson({
    items: listPersonalMemoryItems({ userId, domain, includeDisabled }),
    diagnostics: personalMemoryDiagnostics(),
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const item = savePersonalMemoryItem({
      ...(body && typeof body === 'object' && !Array.isArray(body) ? body : {}),
      userId: requestUserId(request, body),
    });
    return noStoreJson({ item });
  } catch (error) {
    return noStoreJson(
      { error: error instanceof Error ? error.message : 'Failed to save personal memory item' },
      { status: 400 },
    );
  }
}
