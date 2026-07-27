import { closeAllBrowserSessions } from '@/server/browser/browser-session';
import { noStoreJson } from '@/server/http/no-store-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(request: Request) {
  const expectedToken = String(process.env.WEBPILOT_INTERNAL_SHUTDOWN_TOKEN || '').trim();
  const suppliedToken = String(request.headers.get('x-webpilot-shutdown-token') || '').trim();
  if (!expectedToken || suppliedToken !== expectedToken) {
    return noStoreJson({ error: 'Not found' }, { status: 404 });
  }
  await closeAllBrowserSessions();
  return noStoreJson({ ok: true });
}
