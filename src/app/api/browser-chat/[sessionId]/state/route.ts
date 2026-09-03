import { readBrowserChatRuntimeState } from '@/server/ai/agents/browser-chat-read.service';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { ApiRequestError, apiError, apiJson } from '@/server/http/api-request';
import type { BrowserChatSessionRouteContext } from '@/server/http/browser-chat-route';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request, context: BrowserChatSessionRouteContext) {
  try {
    const { sessionId } = await context.params;
    const result = await readBrowserChatRuntimeState(sessionId, requestApplicationUserId(request));
    if (!result) throw new ApiRequestError('Browser chat session not found', { code: 'not_found', status: 404 });
    return apiJson(request, result);
  } catch (error) {
    return apiError(request, error, { fallback: 'Failed to read browser chat runtime state' });
  }
}
