import { NextRequest } from 'next/server';
import {
  closeBrowserChatSession,
  getBrowserChatSession,
  releaseBrowserChatSessionRuntime,
  selectBrowserChatSessionRuntime,
} from '@/server/ai/agents/browser-chat.service';
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

export async function GET(request: NextRequest, context: RouteContext) {
  const { sessionId } = await context.params;
  try {
    const auth = readEmbedAuth(request, sessionId);
    selectBrowserChatSessionRuntime(sessionId, auth.userId);
    const session = getBrowserChatSession(sessionId, auth.userId);
    if (!session) return embedJson({ error: 'Browser chat session not found' }, { status: 404 });
    return embedJson({ session });
  } catch (error) {
    return embedErrorJson(error, 'Failed to load browser chat session');
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { sessionId } = await context.params;
  try {
    const auth = readEmbedAuth(request, sessionId);
    const session = await closeBrowserChatSession(sessionId, auth.userId);
    if (!session) return embedJson({ error: 'Browser chat session not found' }, { status: 404 });
    await releaseBrowserChatSessionRuntime(sessionId, auth.userId);
    return embedJson({ session });
  } catch (error) {
    return embedErrorJson(error, 'Failed to close browser chat session');
  }
}
