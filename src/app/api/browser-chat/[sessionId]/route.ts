import { closeBrowserChatSession, getBrowserChatSession } from '@/server/ai/agents/browser-chat.service';
import { noStoreJson } from '@/server/http/no-store-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

function requestUserId(request: Request) {
  const url = new URL(request.url);
  return (url.searchParams.get('userId') || url.searchParams.get('qzUserId') || '').trim();
}

export async function GET(request: Request, context: RouteContext) {
  const { sessionId } = await context.params;
  const session = getBrowserChatSession(sessionId, requestUserId(request));
  if (!session) return noStoreJson({ error: 'Browser chat session not found' }, { status: 404 });
  return noStoreJson({ session });
}

export async function DELETE(request: Request, context: RouteContext) {
  const { sessionId } = await context.params;
  const session = await closeBrowserChatSession(sessionId, requestUserId(request));
  if (!session) return noStoreJson({ error: 'Browser chat session not found' }, { status: 404 });
  return noStoreJson({ session });
}
