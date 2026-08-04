import { ensureRefreshWebSocketServer } from '@/server/realtime/ws-refresh';
import { embedErrorJson, embedJson, embedOptionsResponse, readEmbedAuth } from '@/server/embed/browser-chat-embed';
import { createWebSocketTicket, requestPublicOrigin } from '@/server/auth/websocket-ticket';
import { withWebPilotBasePath } from '@/lib/webpilot-base-path';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export function OPTIONS() {
  return embedOptionsResponse();
}

export async function GET(request: Request) {
  try {
    const auth = readEmbedAuth(request);
    const info = await ensureRefreshWebSocketServer();
    const ticket = createWebSocketTicket({
      origin: auth.origin || request.headers.get('origin') || requestPublicOrigin(request),
      scope: 'realtime-refresh',
      userId: auth.userId,
    });
    const publicOrigin = new URL(requestPublicOrigin(request));
    publicOrigin.protocol = publicOrigin.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(withWebPilotBasePath('/refresh'), publicOrigin);
    url.searchParams.set('ticket', ticket.ticket);
    return embedJson({ ...info, expiresAt: ticket.expiresAt, transport: 'websocket', url: url.toString() });
  } catch (error) {
    return embedErrorJson(error, 'Realtime WebSocket is unavailable');
  }
}
