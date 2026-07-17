import { ensureBrowserPreviewWebSocketServer } from '@/server/realtime/browser-preview-ws';
import { noStoreJson } from '@/server/http/no-store-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function browserReachableUrl(request: Request, port: number) {
  const url = new URL(request.url);
  const forwardedHost = request.headers.get('x-forwarded-host') || '';
  const forwardedProto = request.headers.get('x-forwarded-proto') || '';
  const host = (forwardedHost || url.host || `127.0.0.1:${port}`).split(',')[0].trim();
  const hostname = host.includes(':') ? host.split(':')[0] : host;
  const protocol = forwardedProto === 'https' || url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${hostname || '127.0.0.1'}:${port}/browser-preview`;
}

export async function GET(request: Request) {
  try {
    const info = await ensureBrowserPreviewWebSocketServer();
    return noStoreJson({
      port: info.port,
      url: browserReachableUrl(request, info.port),
    });
  } catch (error) {
    return noStoreJson(
      { error: error instanceof Error ? error.message : 'Failed to start browser preview stream' },
      { status: 503 },
    );
  }
}
