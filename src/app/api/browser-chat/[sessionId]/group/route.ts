import { setBrowserChatSessionGroup } from '@/server/ai/agents/browser-chat.service';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { setBrowserChatGroupRequestSchema } from '@/server/http/browser-chat-request.schema';
import { ApiRequestError, apiError, apiJson, parseJsonRequest } from '@/server/http/api-request';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

export async function PUT(request: Request, context: RouteContext) {
  const { sessionId } = await context.params;
  try {
    const body = await parseJsonRequest(request, setBrowserChatGroupRequestSchema, { maxBytes: 16 * 1024 });
    const session = setBrowserChatSessionGroup(sessionId, body.groupId, requestApplicationUserId(request));
    if (!session) throw new ApiRequestError('Browser chat session not found', { code: 'not_found', status: 404 });
    return apiJson(request, { session });
  } catch (error) {
    return apiError(request, error, { fallback: 'Unable to set browser group' });
  }
}
