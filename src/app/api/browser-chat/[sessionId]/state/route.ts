import { readBrowserChatRuntimeState } from '@/server/ai/agents/browser-chat-read.service';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { ApiRequestError, apiError, apiJson } from '@/server/http/api-request';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const { sessionId } = await context.params;
    const result = readBrowserChatRuntimeState(sessionId, requestApplicationUserId(request));
    if (!result) throw new ApiRequestError('Browser chat session not found', { code: 'not_found', status: 404 });
    return apiJson(request, result);
  } catch (error) {
    return apiError(request, error, { fallback: 'Failed to read browser chat runtime state' });
  }
}
