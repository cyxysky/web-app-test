import { NextRequest } from 'next/server';
import { interruptBrowserChatSession } from '@/server/ai/agents/browser-chat.service';
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
    const session = interruptBrowserChatSession(sessionId, auth.userId);
    if (!session) return embedJson({ error: 'Browser chat session not found' }, { status: 404 });
    return embedJson({ session });
  } catch (error) {
    return embedErrorJson(error, 'Failed to interrupt browser chat session');
  }
}
