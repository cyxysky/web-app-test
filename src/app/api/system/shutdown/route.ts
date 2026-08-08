import { closeAllBrowserSessions } from '@/server/browser/browser-session';
import { ApiRequestError, apiError, apiJson } from '@/server/http/api-request';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(request: Request) {
  try {
    const expectedToken = String(process.env.WEBPILOT_INTERNAL_SHUTDOWN_TOKEN || '').trim();
    const suppliedToken = String(request.headers.get('x-webpilot-shutdown-token') || '').trim();
    if (!expectedToken || suppliedToken !== expectedToken) {
      throw new ApiRequestError('Not found', { code: 'not_found', status: 404 });
    }
    await closeAllBrowserSessions();
    return apiJson(request, { ok: true });
  } catch (error) {
    return apiError(request, error, { fallback: 'Failed to shut down browser sessions', status: 500 });
  }
}
