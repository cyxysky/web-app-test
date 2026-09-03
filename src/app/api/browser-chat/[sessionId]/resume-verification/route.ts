import { resumeBrowserChatHumanVerification } from '@/server/ai/agents/browser-chat.service';
import { ApiRequestError, apiError, apiJson } from '@/server/http/api-request';
import { requestApplicationUserId } from '@/server/auth/user-context';
import type { BrowserChatSessionRouteContext } from '@/server/http/browser-chat-route';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(request: Request, context: BrowserChatSessionRouteContext) {
  const { sessionId } = await context.params;
  try {
    return apiJson(request, { session: await resumeBrowserChatHumanVerification(sessionId, requestApplicationUserId(request)) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to resume browser chat verification';
    return apiError(request, error instanceof ApiRequestError ? error : new ApiRequestError(message, {
      code: /not found/i.test(message) ? 'not_found' : 'resume_failed',
      status: /not found/i.test(message) ? 404 : 400,
    }), { fallback: 'Failed to resume browser chat verification' });
  }
}
