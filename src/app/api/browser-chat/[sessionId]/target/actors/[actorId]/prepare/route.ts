import { NextRequest } from 'next/server';
import { z } from 'zod';
import { prepareTargetActorLogin } from '@/server/ai/agents/browser-chat.service';
import { noStoreJson } from '@/server/http/no-store-response';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ sessionId: string; actorId: string }> };

const bodySchema = z.object({
  mode: z.enum(['manual', 'credentials', 'existing_session']).default('manual'),
  userId: z.union([z.string(), z.number()]).optional(),
  qzUserId: z.union([z.string(), z.number()]).optional(),
}).strict();

export async function POST(request: NextRequest, context: RouteContext) {
  const { sessionId, actorId } = await context.params;
  try {
    const body = bodySchema.parse(await request.json().catch(() => ({})));
    const userId = body.userId ?? body.qzUserId ?? request.nextUrl.searchParams.get('userId') ?? undefined;
    return noStoreJson({ session: prepareTargetActorLogin(sessionId, actorId, body.mode, userId) });
  } catch (error) {
    return noStoreJson({ error: error instanceof Error ? error.message : 'Unable to prepare actor login' }, { status: 400 });
  }
}
