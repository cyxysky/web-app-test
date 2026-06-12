import { NextResponse } from 'next/server';
import { realtimeWebSocketUrl } from '@/server/realtime/ws-hub';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const topics = (url.searchParams.get('topics') || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return NextResponse.json({
    url: await realtimeWebSocketUrl(request, topics),
  });
}
