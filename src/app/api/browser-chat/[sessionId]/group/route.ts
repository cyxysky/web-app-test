import { setBrowserChatSessionGroup } from '@/server/ai/agents/browser-chat.service';
import { noStoreJson } from '@/server/http/no-store-response';
import { requestApplicationUserId } from '@/server/auth/user-context';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

export async function PUT(request: Request, context: RouteContext) {
  const { sessionId } = await context.params;
  try {
    const body = await request.json() as { groupId?: unknown };
    const groupId = typeof body.groupId === 'string' ? body.groupId : '';
    const session = setBrowserChatSessionGroup(sessionId, groupId, requestApplicationUserId(request));
    if (!session) return noStoreJson({ error: 'Browser chat session not found' }, { status: 404 });
    return noStoreJson({ session });
  } catch (error) {
    return noStoreJson({ error: error instanceof Error ? error.message : 'Unable to set browser group' }, { status: 400 });
  }
}
