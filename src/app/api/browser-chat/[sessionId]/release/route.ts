import { releaseBrowserChatSessionRuntime } from '@/server/ai/agents/browser-chat.service';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { ApiRequestError, apiError, apiJson } from '@/server/http/api-request';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  try {
    const { sessionId } = await context.params;
    const released = await releaseBrowserChatSessionRuntime(
      sessionId,
      requestApplicationUserId(request),
    );
    if (!released) {
      throw new ApiRequestError('Browser chat session not found', { code: 'not_found', status: 404 });
    }
    return apiJson(request, { released: true });
  } catch (error) {
    return apiError(request, error, { fallback: 'Failed to release browser chat session' });
  }
}
