import { NextRequest } from 'next/server';
import { resolveBrowserChatToolConfirmation } from '@/server/ai/agents/browser-chat.service';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { browserChatToolConfirmationRequestSchema } from '@/server/http/browser-chat-request.schema';
import { ApiRequestError, apiError, apiJson, parseJsonRequest } from '@/server/http/api-request';

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
    const body = await parseJsonRequest(request, browserChatToolConfirmationRequestSchema, { maxBytes: 16 * 1024 });
    const session = await resolveBrowserChatToolConfirmation(sessionId, body.confirmationId, body.action, requestUserId(request));
    return apiJson(request, { session });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to resolve tool confirmation';
    const normalizedError = /Browser chat session not found/i.test(message)
      ? new ApiRequestError('Browser chat session not found', { code: 'not_found', status: 404 })
      : error;
    return apiError(request, normalizedError, { fallback: 'Failed to resolve tool confirmation' });
  }
}
