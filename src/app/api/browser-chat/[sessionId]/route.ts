import { closeBrowserChatSession, getBrowserChatSessionPage } from '@/server/ai/agents/browser-chat.service';
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
  const session = getBrowserChatSessionPage(sessionId, requestUserId(request));
  if (!session) return noStoreJson({ error: 'Browser chat session not found' }, { status: 404 });
  return noStoreJson({ session });
}

export async function DELETE(request: Request, context: RouteContext) {
  const { sessionId } = await context.params;
  const session = await closeBrowserChatSession(sessionId, requestUserId(request));
  if (!session) return noStoreJson({ error: 'Browser chat session not found' }, { status: 404 });
  return noStoreJson({ session });
}
