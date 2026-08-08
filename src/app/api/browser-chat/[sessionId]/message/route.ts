import { NextRequest } from 'next/server';
import { sendBrowserChatMessage } from '@/server/ai/agents/browser-chat.service';
import { sendBrowserChatMessageRequestSchema } from '@/server/http/browser-chat-request.schema';
import { ApiRequestError, apiError, apiJson, parseJsonRequest } from '@/server/http/api-request';
import { idempotencyFingerprint, runIdempotentJson } from '@/server/http/idempotency';
import { requestApplicationUserId } from '@/server/auth/user-context';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

function requestUserId(request: NextRequest) {
  return requestApplicationUserId(request);
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { sessionId } = await context.params;
  try {
    const body = await parseJsonRequest(request, sendBrowserChatMessageRequestSchema, { maxBytes: 512 * 1024 });
    const userId = requestUserId(request);
    return await runIdempotentJson(request, {
      fingerprint: idempotencyFingerprint({ sessionId, ...body }),
      scope: 'browser-chat.message',
      userId,
    }, async () => {
      const session = await sendBrowserChatMessage(
        sessionId,
        body.content,
        body.safetyMode,
        body.modelProvider,
        body.model,
        body.clientMessageId,
        body.attachments,
        body.skillIds,
        userId,
      );
      return apiJson(request, { session });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to send browser chat message';
    const normalizedError = /Browser chat session not found/i.test(message)
      ? new ApiRequestError('Browser chat session not found', { code: 'not_found', status: 404 })
      : error;
    return apiError(request, normalizedError, { fallback: 'Failed to send browser chat message' });
  }
}
