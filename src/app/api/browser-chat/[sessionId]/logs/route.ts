import { getBrowserChatSessionLogs } from '@/server/ai/agents/browser-chat.service';
import { noStoreJson } from '@/server/http/no-store-response';
import { requestApplicationUserId } from '@/server/auth/user-context';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

function requestUserId(request: Request) {
  return requestApplicationUserId(request);
}

export async function GET(request: Request, context: RouteContext) {
  const { sessionId } = await context.params;
  const url = new URL(request.url);
  const result = getBrowserChatSessionLogs(sessionId, requestUserId(request), {
    cursor: url.searchParams.get('cursor') || undefined,
    limit: Number(url.searchParams.get('limit') || 500),
    messageId: url.searchParams.get('messageId') || undefined,
  });
  if (!result) return noStoreJson({ error: 'Browser chat session not found' }, { status: 404 });
  return noStoreJson(result);
}
