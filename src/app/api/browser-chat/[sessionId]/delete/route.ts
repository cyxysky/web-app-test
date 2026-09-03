import { deleteBrowserChatSession } from '@/server/ai/agents/browser-chat.service';
import { ApiRequestError, apiError, apiJson } from '@/server/http/api-request';
import { requestApplicationUserId } from '@/server/auth/user-context';
import type { BrowserChatSessionRouteContext } from '@/server/http/browser-chat-route';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(request: Request, context: BrowserChatSessionRouteContext) {
  try {
    const { sessionId } = await context.params;
    const deleted = await deleteBrowserChatSession(sessionId, requestApplicationUserId(request));
    if (!deleted) throw new ApiRequestError('Browser chat session not found', { code: 'not_found', status: 404 });
    return apiJson(request, { ok: true, deleted });
  } catch (error) {
    return apiError(request, error, { fallback: 'Failed to delete browser chat session' });
  }
}
