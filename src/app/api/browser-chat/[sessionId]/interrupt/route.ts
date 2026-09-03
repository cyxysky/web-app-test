import { interruptBrowserChatSession } from '@/server/ai/agents/browser-chat.service';
import { ApiRequestError, apiError, apiJson } from '@/server/http/api-request';
import { requestApplicationUserId } from '@/server/auth/user-context';
import type { BrowserChatSessionRouteContext } from '@/server/http/browser-chat-route';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(request: Request, context: BrowserChatSessionRouteContext) {
  const { sessionId } = await context.params;
  try {
    const body = await request.json().catch(() => ({})) as { clientMessageId?: unknown };
    const clientMessageId = typeof body.clientMessageId === 'string' ? body.clientMessageId.trim() : '';
    if (!clientMessageId) {
      throw new ApiRequestError('Browser chat turn id is required', { code: 'invalid_request', status: 400 });
    }
    const session = await interruptBrowserChatSession(sessionId, clientMessageId, requestApplicationUserId(request));
    if (!session) throw new ApiRequestError('Browser chat session not found', { code: 'not_found', status: 404 });
    return apiJson(request, { session });
  } catch (error) {
    return apiError(request, error, { fallback: 'Browser chat interrupt failed', status: 500 });
  }
}
