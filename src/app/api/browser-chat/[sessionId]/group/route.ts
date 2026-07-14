import { setBrowserChatSessionGroup } from '@/server/ai/agents/browser-chat.service';
import { noStoreJson } from '@/server/http/no-store-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

export async function PUT(request: Request, context: RouteContext) {
  const { sessionId } = await context.params;
  try {
    const body = await request.json() as { groupId?: unknown; userId?: unknown; qzUserId?: unknown };
    const groupId = typeof body.groupId === 'string' ? body.groupId : '';
    const userId = body.userId ?? body.qzUserId ?? new URL(request.url).searchParams.get('userId') ?? new URL(request.url).searchParams.get('qzUserId');
    const session = setBrowserChatSessionGroup(sessionId, groupId, typeof userId === 'string' || typeof userId === 'number' ? userId : undefined);
    if (!session) return noStoreJson({ error: 'Browser chat session not found' }, { status: 404 });
    return noStoreJson({ session });
  } catch (error) {
    return noStoreJson({ error: error instanceof Error ? error.message : 'Unable to set browser group' }, { status: 400 });
  }
}
