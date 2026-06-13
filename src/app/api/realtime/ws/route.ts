import { NextResponse } from 'next/server';
import { ensureRefreshWebSocketServer } from '@/server/realtime/ws-refresh';

export const dynamic = 'force-dynamic';

export async function GET() {
  const info = await ensureRefreshWebSocketServer();
  return NextResponse.json(info, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}
