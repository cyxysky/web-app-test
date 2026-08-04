import { NextRequest } from 'next/server';
import { sendBrowserChatMessage } from '@/server/ai/agents/browser-chat.service';
import { sendBrowserChatMessageRequestSchema } from '@/server/http/browser-chat-request.schema';
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
    const body = sendBrowserChatMessageRequestSchema.parse(await request.json());
    const session = await sendBrowserChatMessage(
      sessionId,
      body.content,
      body.safetyMode,
      body.modelProvider,
      body.model,
      body.clientMessageId,
      body.attachments,
      body.skillIds,
      requestUserId(request),
    );
    return noStoreJson({ session });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to send browser chat message';
    return noStoreJson(
      { error: message },
      { status: /Browser chat session not found/i.test(message) ? 404 : 400 },
    );
  }
}
