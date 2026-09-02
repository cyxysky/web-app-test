import { deleteQueuedBrowserChatMessage } from '@/server/ai/agents/browser-chat.service';
import { ApiRequestError, apiError, apiJson } from '@/server/http/api-request';
import { requestApplicationUserId } from '@/server/auth/user-context';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ sessionId: string; messageId: string }>;
};

export async function DELETE(request: Request, context: RouteContext) {
  const { messageId, sessionId } = await context.params;
  try {
    const session = await deleteQueuedBrowserChatMessage(
      sessionId,
      messageId,
      requestApplicationUserId(request),
    );
    if (!session) {
      throw new ApiRequestError('Browser chat session not found', { code: 'not_found', status: 404 });
    }
    return apiJson(request, { session });
  } catch (error) {
    return apiError(request, error, { fallback: 'Failed to delete queued browser chat message' });
  }
}
