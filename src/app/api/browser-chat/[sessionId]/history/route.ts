import { readBrowserChatSessionHistoryPage } from '@/server/ai/agents/browser-chat-read.service';
import { ApiRequestError, apiError, apiJson, boundedQueryInteger } from '@/server/http/api-request';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { BROWSER_CHAT_MESSAGE_PAGE_SIZE } from '@/server/storage/browser-chat-history-store';
import type { BrowserChatSessionRouteContext } from '@/server/http/browser-chat-route';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request, context: BrowserChatSessionRouteContext) {
  try {
    const { sessionId } = await context.params;
    const url = new URL(request.url);
    const result = await readBrowserChatSessionHistoryPage(sessionId, requestApplicationUserId(request), {
      messageCursor: url.searchParams.get('messageCursor') || undefined,
      messageLimit: boundedQueryInteger(url.searchParams.get('messageLimit'), {
        fallback: BROWSER_CHAT_MESSAGE_PAGE_SIZE,
        max: BROWSER_CHAT_MESSAGE_PAGE_SIZE,
      }),
    });
    if (!result) throw new ApiRequestError('Browser chat session not found', { code: 'not_found', status: 404 });
    return apiJson(request, result);
  } catch (error) {
    return apiError(request, error, { fallback: 'Failed to read browser chat history' });
  }
}
