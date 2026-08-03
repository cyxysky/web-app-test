import { NextResponse } from 'next/server';
import { ensureRefreshWebSocketServer } from '@/server/realtime/ws-refresh';
import { requestApplicationUserId } from '@/server/auth/user-context';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const info = await ensureRefreshWebSocketServer();
  const url = new URL(info.url);
  url.searchParams.set('userId', requestApplicationUserId(request));
  return NextResponse.json({ ...info, transport: 'websocket', url: url.toString() }, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}
