import { deleteBrowserChatSession } from '@/server/ai/agents/browser-chat.service';
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
  try {
    const { sessionId } = await context.params;
    const deleted = await deleteBrowserChatSession(sessionId, requestUserId(request));
    if (!deleted) return noStoreJson({ error: 'Browser chat session not found' }, { status: 404 });
    return noStoreJson({ ok: true, deleted });
  } catch (error) {
    return noStoreJson(
      { error: error instanceof Error ? error.message : 'Failed to delete browser chat session' },
      { status: 400 },
    );
  }
}
