import { NextRequest } from 'next/server';
import { switchBrowserChatTab } from '@/server/ai/agents/browser-chat.service';
import { ApiRequestError, apiError, apiJson } from '@/server/http/api-request';
import { requestApplicationUserId } from '@/server/auth/user-context';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ sessionId: string; index: string }>;
};

function requestUserId(request: NextRequest) {
  return requestApplicationUserId(request);
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { sessionId, index } = await context.params;
  try {
    const session = await switchBrowserChatTab(sessionId, index, requestUserId(request));
    if (!session) throw new ApiRequestError('Browser chat session not found', { code: 'not_found', status: 404 });
    return apiJson(request, { session });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to switch browser tab';
    const status = /session not found/i.test(message) || /closed/i.test(message) ? 404 : /Invalid tab id/i.test(message) ? 400 : 500;
    return apiError(request, error instanceof ApiRequestError ? error : new ApiRequestError(message, {
      code: status === 404 ? 'not_found' : status === 400 ? 'invalid_tab_id' : 'tab_switch_failed',
      status,
    }), { fallback: 'Failed to switch browser tab', status });
  }
}
