import { NextRequest } from 'next/server';
import { resolveBrowserChatToolConfirmation } from '@/server/ai/agents/browser-chat.service';
import { noStoreJson } from '@/server/http/no-store-response';
import { requestApplicationUserId } from '@/server/auth/user-context';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

function requestUserId(request: NextRequest) {
  return requestApplicationUserId(request);
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { sessionId } = await context.params;
  try {
    const body = await request.json();
    const confirmationId = typeof body.confirmationId === 'string' ? body.confirmationId : '';
    const action = body.action === 'confirm' ? 'confirm' : body.action === 'cancel' ? 'cancel' : undefined;
    if (!confirmationId || !action) throw new Error('Invalid tool confirmation request');
    const session = resolveBrowserChatToolConfirmation(sessionId, confirmationId, action, requestUserId(request));
    return noStoreJson({ session });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to resolve tool confirmation';
    return noStoreJson(
      { error: message },
      { status: /Browser chat session not found/i.test(message) ? 404 : 400 },
    );
  }
}
