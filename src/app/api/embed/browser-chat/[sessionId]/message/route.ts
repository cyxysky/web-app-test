import { NextRequest } from 'next/server';
import { sendBrowserChatMessage } from '@/server/ai/agents/browser-chat.service';
import {
  embedErrorJson,
  embedJson,
  embedOptionsResponse,
  normalizeMode,
  normalizeSafetyMode,
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
    const content = typeof body.content === 'string' ? body.content : '';
    const session = await sendBrowserChatMessage(
      sessionId,
      content,
      'dom',
      normalizeSafetyMode(body.safetyMode),
      typeof body.modelProvider === 'string' ? body.modelProvider : undefined,
      typeof body.model === 'string' ? body.model : undefined,
      typeof body.clientMessageId === 'string' ? body.clientMessageId : undefined,
      body.attachments,
      body.skillIds,
      auth.userId,
    );
    return embedJson({ session });
  } catch (error) {
    return embedErrorJson(error, 'Failed to send browser chat message');
  }
}
