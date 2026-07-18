import { NextRequest } from 'next/server';
import { continueTargetWorkflow } from '@/server/ai/agents/browser-chat.service';
import { noStoreJson } from '@/server/http/no-store-response';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  const { sessionId } = await context.params;
  try {
    const userId = request.nextUrl.searchParams.get('userId') ?? undefined;
    // Backward-compatible alias: execution now always performs a fresh AI
    // completeness check before it is allowed to start the browser workflow.
    return noStoreJson({ session: continueTargetWorkflow(sessionId, {}, userId) });
  } catch (error) {
    return noStoreJson({ error: error instanceof Error ? error.message : 'Unable to start target workflow' }, { status: 400 });
  }
}
