import { closeBrowserChatSession } from '@/server/ai/agents/browser-chat.service';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { noStoreJson } from '@/server/http/no-store-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const { sessionId } = await context.params;
  const session = await closeBrowserChatSession(sessionId, requestApplicationUserId(request));
  if (!session) return noStoreJson({ error: 'Browser chat session not found' }, { status: 404 });
  return noStoreJson({ session });
}
