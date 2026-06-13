import { closeBrowserChatSession, getBrowserChatSession } from '@/server/ai/agents/browser-chat.service';
import { noStoreJson } from '@/server/http/no-store-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { sessionId } = await context.params;
  const session = getBrowserChatSession(sessionId);
  if (!session) return noStoreJson({ error: 'Browser chat session not found' }, { status: 404 });
  return noStoreJson({ session });
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { sessionId } = await context.params;
  const session = await closeBrowserChatSession(sessionId);
  if (!session) return noStoreJson({ error: 'Browser chat session not found' }, { status: 404 });
  return noStoreJson({ session });
}
