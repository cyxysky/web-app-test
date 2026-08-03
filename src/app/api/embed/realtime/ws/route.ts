import { ensureRefreshWebSocketServer } from '@/server/realtime/ws-refresh';
import { embedErrorJson, embedJson, embedOptionsResponse, readEmbedAuth } from '@/server/embed/browser-chat-embed';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export function OPTIONS() {
  return embedOptionsResponse();
}

export async function GET(request: Request) {
  try {
    const auth = readEmbedAuth(request);
    const info = await ensureRefreshWebSocketServer();
    const url = new URL(info.url);
    url.searchParams.set('userId', auth.userId);
    return embedJson({ ...info, transport: 'websocket', url: url.toString() });
  } catch (error) {
    return embedErrorJson(error, 'Realtime WebSocket is unavailable');
  }
}
