import { readBrowserChatSessionOwner } from '@/server/storage/browser-chat-history-store';
import { queryDatabaseOne } from '@/server/db/database';
import { normalizeApplicationUserId, requestApplicationUserId } from '@/server/auth/user-context';
import { ApiRequestError, apiError, apiJson } from '@/server/http/api-request';
import type { BrowserChatSessionRouteContext } from '@/server/http/browser-chat-route';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request, context: BrowserChatSessionRouteContext) {
  try {
    const { sessionId } = await context.params;
    const userId = requestApplicationUserId(request);
    const owner = await readBrowserChatSessionOwner(sessionId);
    if (!owner || normalizeApplicationUserId(owner.userId) !== normalizeApplicationUserId(userId)) {
      throw new ApiRequestError('Browser chat session not found', { code: 'not_found', status: 404 });
    }
    const requestId = new URL(request.url).searchParams.get('requestId') || '';
    const row = await queryDatabaseOne<{ manifest_json: string }>(
      'SELECT manifest_json FROM browser_chat_context_request WHERE session_id = ? AND id = ?', [sessionId, requestId],
    );
    if (!row) throw new ApiRequestError('Context request not found', { code: 'not_found', status: 404 });
    return apiJson(request, { manifest: JSON.parse(row.manifest_json) });
  } catch (error) {
    return apiError(request, error, { fallback: 'Failed to read context request' });
  }
}
