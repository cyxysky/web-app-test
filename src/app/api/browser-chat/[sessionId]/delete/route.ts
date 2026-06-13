import { deleteBrowserChatSession } from '@/server/ai/agents/browser-chat.service';
import { noStoreJson } from '@/server/http/no-store-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

export async function POST(_request: Request, context: RouteContext) {
  const { sessionId } = await context.params;
  const deleted = await deleteBrowserChatSession(sessionId);
  if (!deleted) return noStoreJson({ error: 'Browser chat session not found' }, { status: 404 });
  return noStoreJson({ ok: true, deleted });
}
