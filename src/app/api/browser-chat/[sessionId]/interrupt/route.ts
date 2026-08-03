import { interruptBrowserChatSession } from '@/server/ai/agents/browser-chat.service';
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

export async function POST(request: Request, context: RouteContext) {
  const { sessionId } = await context.params;
  try {
    const session = interruptBrowserChatSession(sessionId, requestUserId(request));
    if (!session) return noStoreJson({ error: 'Browser chat session not found' }, { status: 404 });
    return noStoreJson({ session });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || 'Browser chat interrupt failed');
    return noStoreJson({ error: message }, { status: 500 });
  }
}
