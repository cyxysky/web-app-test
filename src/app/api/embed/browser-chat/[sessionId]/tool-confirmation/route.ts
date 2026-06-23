import { NextRequest } from 'next/server';
import { resolveBrowserChatToolConfirmation } from '@/server/ai/agents/browser-chat.service';
import {
  embedErrorJson,
  embedJson,
  embedOptionsResponse,
  readEmbedAuth,
} from '@/server/embed/browser-chat-embed';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

export function OPTIONS() {
  return embedOptionsResponse();
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { sessionId } = await context.params;
  try {
    const auth = readEmbedAuth(request, sessionId);
    const body = await request.json().catch(() => ({}));
    const confirmationId = typeof body.confirmationId === 'string' ? body.confirmationId : '';
    const action = body.action === 'confirm' ? 'confirm' : body.action === 'cancel' ? 'cancel' : undefined;
    if (!confirmationId || !action) throw new Error('Invalid tool confirmation request');
    const session = resolveBrowserChatToolConfirmation(sessionId, confirmationId, action, auth.userId);
    return embedJson({ session });
  } catch (error) {
    return embedErrorJson(error, 'Failed to resolve tool confirmation');
  }
}
