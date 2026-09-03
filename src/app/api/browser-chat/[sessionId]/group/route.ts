import { setBrowserChatSessionGroup } from '@/server/ai/agents/browser-chat.service';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { setBrowserChatGroupRequestSchema } from '@/server/http/browser-chat-request.schema';
import { ApiRequestError, apiError, apiJson, parseJsonRequest } from '@/server/http/api-request';
import type { BrowserChatSessionRouteContext } from '@/server/http/browser-chat-route';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function PUT(request: Request, context: BrowserChatSessionRouteContext) {
  const { sessionId } = await context.params;
  try {
    const body = await parseJsonRequest(request, setBrowserChatGroupRequestSchema, { maxBytes: 16 * 1024 });
    const session = await setBrowserChatSessionGroup(sessionId, body.groupId, requestApplicationUserId(request));
    if (!session) throw new ApiRequestError('Browser chat session not found', { code: 'not_found', status: 404 });
    return apiJson(request, { session });
  } catch (error) {
    return apiError(request, error, { fallback: 'Unable to set browser group' });
  }
}
