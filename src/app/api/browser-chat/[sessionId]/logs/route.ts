import { readBrowserChatSessionLogs } from '@/server/ai/agents/browser-chat-read.service';
import { ApiRequestError, apiError, apiJson, boundedQueryInteger } from '@/server/http/api-request';
import { requestApplicationUserId } from '@/server/auth/user-context';
import type { BrowserChatSessionRouteContext } from '@/server/http/browser-chat-route';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request, context: BrowserChatSessionRouteContext) {
  try {
    const { sessionId } = await context.params;
    const url = new URL(request.url);
    const result = await readBrowserChatSessionLogs(sessionId, requestApplicationUserId(request), {
      cursor: url.searchParams.get('cursor') || undefined,
      limit: boundedQueryInteger(url.searchParams.get('limit'), { fallback: 200, max: 500 }),
      messageId: url.searchParams.get('messageId') || undefined,
      subagentsOnly: url.searchParams.get('subagentsOnly') === 'true',
    });
    if (!result) throw new ApiRequestError('Browser chat session not found', { code: 'not_found', status: 404 });
    return apiJson(request, result);
  } catch (error) {
    return apiError(request, error, { fallback: 'Failed to read browser chat logs' });
  }
}
