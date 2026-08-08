import { browserPreviewPreferredTransport, ensureBrowserPreviewWebSocketServer } from '@/server/realtime/browser-preview-ws';
import { browserReachableUrl } from '@/server/realtime/browser-preview-url';
import { ApiRequestError, apiError, apiJson } from '@/server/http/api-request';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { createWebSocketTicket, requestPublicOrigin } from '@/server/auth/websocket-ticket';
import { getBrowserChatSession } from '@/server/ai/agents/browser-chat.service';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(request: Request) {
  try {
    const userId = requestApplicationUserId(request);
    const sessionId = new URL(request.url).searchParams.get('sessionId')?.trim() || '';
    if (!sessionId || !getBrowserChatSession(sessionId, userId)) {
      throw new ApiRequestError('Browser chat session not found', { code: 'not_found', status: 404 });
    }
    const info = await ensureBrowserPreviewWebSocketServer();
    const auth = createWebSocketTicket({
      origin: requestPublicOrigin(request),
      scope: 'browser-preview',
      sessionId,
      userId,
    });
    const url = new URL(browserReachableUrl(request, info.port));
    url.searchParams.set('ticket', auth.ticket);
    return apiJson(request, {
      expiresAt: auth.expiresAt,
      port: info.port,
      transport: browserPreviewPreferredTransport(),
      url: url.toString(),
    });
  } catch (error) {
    return apiError(request, error, { fallback: 'Failed to start browser preview stream', status: 503 });
  }
}
