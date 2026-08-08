import { readBrowserChatSessionLogs } from '@/server/ai/agents/browser-chat-read.service';
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
    const result = readBrowserChatSessionLogs(sessionId, requestUserId(request), {
      cursor: url.searchParams.get('cursor') || undefined,
      limit: boundedQueryInteger(url.searchParams.get('limit'), { fallback: 500, max: 2_000 }),
      messageId: url.searchParams.get('messageId') || undefined,
    });
    if (!result) throw new ApiRequestError('Browser chat session not found', { code: 'not_found', status: 404 });
    return apiJson(request, result);
  } catch (error) {
    return apiError(request, error, { fallback: 'Failed to read browser chat logs' });
  }
}
