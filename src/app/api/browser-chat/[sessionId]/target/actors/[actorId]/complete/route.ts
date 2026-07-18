import { NextRequest } from 'next/server';
import { completeTargetActorLogin } from '@/server/ai/agents/browser-chat.service';
import { noStoreJson } from '@/server/http/no-store-response';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ sessionId: string; actorId: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  const { sessionId, actorId } = await context.params;
  try {
    const userId = request.nextUrl.searchParams.get('userId') ?? undefined;
    return noStoreJson({ session: await completeTargetActorLogin(sessionId, actorId, userId) });
  } catch (error) {
    return noStoreJson({ error: error instanceof Error ? error.message : 'Unable to verify actor login' }, { status: 400 });
  }
}
