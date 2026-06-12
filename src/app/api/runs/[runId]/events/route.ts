import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json(
    { error: 'SSE events are disabled. Use /api/realtime/ws for WebSocket realtime updates.' },
    { status: 410 },
  );
}
