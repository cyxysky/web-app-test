import { NextRequest } from 'next/server';
import { sendBrowserChatMessage } from '@/server/ai/agents/browser-chat.service';
import { noStoreJson } from '@/server/http/no-store-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

function requestUserId(request: NextRequest, body?: { userId?: unknown; qzUserId?: unknown }) {
  const value = body?.userId ?? body?.qzUserId ?? request.nextUrl.searchParams.get('userId') ?? request.nextUrl.searchParams.get('qzUserId');
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function safetyMode(value: unknown) {
  return value === 'full' ? 'full' : 'strict';
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { sessionId } = await context.params;
  try {
    const body = await request.json();
    const content = typeof body.content === 'string' ? body.content : '';
    const mode = 'dom';
    const nextSafetyMode = safetyMode(body.safetyMode);
    const modelProvider = typeof body.modelProvider === 'string' ? body.modelProvider : undefined;
    const model = typeof body.model === 'string' ? body.model : undefined;
    const clientMessageId = typeof body.clientMessageId === 'string' ? body.clientMessageId : undefined;
    const session = await sendBrowserChatMessage(sessionId, content, mode, nextSafetyMode, modelProvider, model, clientMessageId, body.attachments, body.skillIds, requestUserId(request, body));
    return noStoreJson({ session });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to send browser chat message';
    return noStoreJson(
      { error: message },
      { status: /Browser chat session not found/i.test(message) ? 404 : 400 },
    );
  }
}
