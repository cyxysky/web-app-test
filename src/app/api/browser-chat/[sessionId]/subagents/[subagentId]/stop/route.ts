import { stopBrowserChatSubagent } from '@/server/ai/agents/browser-chat.service';
import { ApiRequestError, apiError, apiJson } from '@/server/http/api-request';
import { requestApplicationUserId } from '@/server/auth/user-context';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ sessionId: string; subagentId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const { sessionId, subagentId } = await context.params;
  try {
    const session = await stopBrowserChatSubagent(
      sessionId,
      subagentId,
      requestApplicationUserId(request),
    );
    if (!session) {
      throw new ApiRequestError('Browser chat sub-agent not found', { code: 'not_found', status: 404 });
    }
    return apiJson(request, { session });
  } catch (error) {
    return apiError(request, error, { fallback: 'Browser chat sub-agent stop failed', status: 500 });
  }
}
