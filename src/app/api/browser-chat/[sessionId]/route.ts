import { readBrowserChatSessionPage } from '@/server/ai/agents/browser-chat-read.service';
import { selectBrowserChatSessionRuntime } from '@/server/ai/agents/browser-chat.service';
import { ApiRequestError, apiError, apiJson } from '@/server/http/api-request';
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
    selectBrowserChatSessionRuntime(sessionId, requestUserId(request));
    const session = readBrowserChatSessionPage(sessionId, requestUserId(request));
    if (!session) throw new ApiRequestError('Browser chat session not found', { code: 'not_found', status: 404 });
    return apiJson(request, { session });
  } catch (error) {
    return apiError(request, error, { fallback: 'Failed to read browser chat session' });
  }
}
