import { readBrowserChatSessionHistoryPage } from '@/server/ai/agents/browser-chat-read.service';
import { ApiRequestError, apiError, apiJson, boundedQueryInteger } from '@/server/http/api-request';
import { requestApplicationUserId } from '@/server/auth/user-context';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

function requestUserId(request: Request) {
  return requestApplicationUserId(request);
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { sessionId } = await context.params;
    const url = new URL(request.url);
    const result = readBrowserChatSessionHistoryPage(sessionId, requestUserId(request), {
      messageCursor: url.searchParams.get('messageCursor') || undefined,
      messageLimit: boundedQueryInteger(url.searchParams.get('messageLimit'), { fallback: 80, max: 500 }),
      stepCursor: url.searchParams.get('stepCursor') || undefined,
      stepLimit: boundedQueryInteger(url.searchParams.get('stepLimit'), { fallback: 120, max: 500 }),
      logCursor: url.searchParams.get('logCursor') || undefined,
      logLimit: boundedQueryInteger(url.searchParams.get('logLimit'), { fallback: 200, max: 1_000 }),
    });
    if (!result) throw new ApiRequestError('Browser chat session not found', { code: 'not_found', status: 404 });
    return apiJson(request, result);
  } catch (error) {
    return apiError(request, error, { fallback: 'Failed to read browser chat history' });
  }
}
