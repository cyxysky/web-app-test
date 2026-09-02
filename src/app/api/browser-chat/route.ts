import { NextRequest } from 'next/server';
import { listBrowserChatSessionSummaries } from '@/server/ai/agents/browser-chat-read.service';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { apiJson, boundedQueryInteger } from '@/server/http/api-request';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function requestUserId(request: NextRequest) {
  return requestApplicationUserId(request);
}

export async function GET(request: NextRequest) {
  const limit = boundedQueryInteger(request.nextUrl.searchParams.get('limit'), { fallback: 10, max: 100 });
  const page = await listBrowserChatSessionSummaries(requestUserId(request), {
    beforeId: request.nextUrl.searchParams.get('beforeId')?.trim() || undefined,
    beforeUpdatedAt: request.nextUrl.searchParams.get('beforeUpdatedAt')?.trim() || undefined,
    limit: limit + 1,
  });
  const sessions = page.slice(0, limit);
  const last = sessions.at(-1);
  return apiJson(request, {
    sessions,
    page: {
      hasMore: page.length > limit,
      next: page.length > limit && last ? { beforeId: last.id, beforeUpdatedAt: last.updatedAt } : undefined,
    },
  });
}
