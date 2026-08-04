import { NextResponse } from 'next/server';
import { ensureRefreshWebSocketServer } from '@/server/realtime/ws-refresh';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { createWebSocketTicket, requestPublicOrigin } from '@/server/auth/websocket-ticket';
import { withWebPilotBasePath } from '@/lib/webpilot-base-path';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const info = await ensureRefreshWebSocketServer();
  const userId = requestApplicationUserId(request);
  const auth = createWebSocketTicket({
    origin: requestPublicOrigin(request),
    scope: 'realtime-refresh',
    userId,
  });
  const publicOrigin = new URL(requestPublicOrigin(request));
  publicOrigin.protocol = publicOrigin.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(withWebPilotBasePath('/refresh'), publicOrigin);
  url.searchParams.set('ticket', auth.ticket);
  return NextResponse.json({ ...info, expiresAt: auth.expiresAt, transport: 'websocket', url: url.toString() }, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}
