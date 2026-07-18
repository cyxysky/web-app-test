import { NextRequest } from 'next/server';
import { z } from 'zod';
import { continueTargetWorkflow } from '@/server/ai/agents/browser-chat.service';
import { noStoreJson } from '@/server/http/no-store-response';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ sessionId: string }> };

const bodySchema = z.object({
  responses: z.array(z.object({
    requirementId: z.string().trim().min(1).max(120),
    value: z.string().trim().min(1).max(2_000),
  }).strict()).max(40).default([]),
  actorCredentials: z.array(z.object({
    actorId: z.string().trim().min(1).max(120),
    username: z.string().min(1).max(500),
    password: z.string().min(1).max(2_000),
  }).strict()).max(20).default([]),
  userId: z.union([z.string(), z.number()]).optional(),
  qzUserId: z.union([z.string(), z.number()]).optional(),
}).strict();

export async function POST(request: NextRequest, context: RouteContext) {
  const { sessionId } = await context.params;
  try {
    const body = bodySchema.parse(await request.json().catch(() => ({})));
    const userId = body.userId
      ?? body.qzUserId
      ?? request.nextUrl.searchParams.get('userId')
      ?? request.nextUrl.searchParams.get('qzUserId')
      ?? undefined;
    return noStoreJson({
      session: continueTargetWorkflow(sessionId, {
        responses: body.responses,
        actorCredentials: body.actorCredentials,
      }, userId),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to continue target workflow';
    return noStoreJson(
      { error: message },
      { status: /Browser chat session not found/i.test(message) ? 404 : 400 },
    );
  }
}
