import { ensureRefreshWebSocketServer } from '@/server/realtime/ws-refresh';
import { embedErrorJson, embedJson, embedOptionsResponse } from '@/server/embed/browser-chat-embed';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export function OPTIONS() {
  return embedOptionsResponse();
}

export async function GET() {
  try {
    return embedJson(await ensureRefreshWebSocketServer());
  } catch (error) {
    return embedErrorJson(error, 'Realtime WebSocket is unavailable');
  }
}
