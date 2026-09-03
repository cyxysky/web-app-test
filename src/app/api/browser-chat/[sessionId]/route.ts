import { readBrowserChatSessionPage } from '@/server/ai/agents/browser-chat-read.service';
import { selectBrowserChatSessionRuntime, updateBrowserChatSessionTitle } from '@/server/ai/agents/browser-chat.service';
import { updateBrowserChatSessionRequestSchema } from '@/server/http/browser-chat-request.schema';
import { ApiRequestError, apiError, apiJson, parseJsonRequest } from '@/server/http/api-request';
import { requestApplicationUserId } from '@/server/auth/user-context';
import type { BrowserChatSessionRouteContext } from '@/server/http/browser-chat-route';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request, context: BrowserChatSessionRouteContext) {
  try {
    const { sessionId } = await context.params;
    const userId = requestApplicationUserId(request);
    await selectBrowserChatSessionRuntime(sessionId, userId);
    const session = await readBrowserChatSessionPage(sessionId, userId);
    if (!session) throw new ApiRequestError('Browser chat session not found', { code: 'not_found', status: 404 });
    return apiJson(request, { session });
  } catch (error) {
    return apiError(request, error, { fallback: 'Failed to read browser chat session' });
  }
}

export async function PUT(request: Request, context: BrowserChatSessionRouteContext) {
  try {
    const { sessionId } = await context.params;
    const body = await parseJsonRequest(request, updateBrowserChatSessionRequestSchema, { maxBytes: 16 * 1024 });
    const session = await updateBrowserChatSessionTitle(sessionId, body.title, requestApplicationUserId(request));
    if (!session) throw new ApiRequestError('Browser chat session not found', { code: 'not_found', status: 404 });
    return apiJson(request, { session });
  } catch (error) {
    return apiError(request, error, { fallback: 'Unable to update browser chat session' });
  }
}
