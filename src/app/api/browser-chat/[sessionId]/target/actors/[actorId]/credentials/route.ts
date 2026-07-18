import { NextRequest } from 'next/server';
import { z } from 'zod';
import { provideTargetActorCredentials } from '@/server/ai/agents/browser-chat.service';
import { noStoreJson } from '@/server/http/no-store-response';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ sessionId: string; actorId: string }> };

const bodySchema = z.object({
  username: z.string().min(1).max(500),
  password: z.string().min(1).max(2_000),
  userId: z.union([z.string(), z.number()]).optional(),
  qzUserId: z.union([z.string(), z.number()]).optional(),
}).strict();

export async function POST(request: NextRequest, context: RouteContext) {
  const { sessionId, actorId } = await context.params;
  try {
    const body = bodySchema.parse(await request.json());
    const userId = body.userId ?? body.qzUserId ?? request.nextUrl.searchParams.get('userId') ?? undefined;
    const session = provideTargetActorCredentials(sessionId, actorId, {
      username: body.username,
      password: body.password,
    }, userId);
    return noStoreJson({ session });
  } catch (error) {
    return noStoreJson({ error: error instanceof Error ? error.message : 'Unable to store actor credentials' }, { status: 400 });
  }
}
