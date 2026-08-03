import { getBrowserChatSessionHistory } from '@/server/ai/agents/browser-chat.service';
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
  const result = getBrowserChatSessionHistory(sessionId, requestUserId(request), {
    messageCursor: url.searchParams.get('messageCursor') || undefined,
    messageLimit: Number(url.searchParams.get('messageLimit') || 80),
    stepCursor: url.searchParams.get('stepCursor') || undefined,
    stepLimit: Number(url.searchParams.get('stepLimit') || 120),
    logCursor: url.searchParams.get('logCursor') || undefined,
    logLimit: Number(url.searchParams.get('logLimit') || 200),
  });
  if (!result) return noStoreJson({ error: 'Browser chat session not found' }, { status: 404 });
  return noStoreJson(result);
}
