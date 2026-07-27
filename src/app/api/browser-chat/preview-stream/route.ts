import { ensureBrowserPreviewWebSocketServer } from '@/server/realtime/browser-preview-ws';
import { browserReachableUrl } from '@/server/realtime/browser-preview-url';
import { noStoreJson } from '@/server/http/no-store-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

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
