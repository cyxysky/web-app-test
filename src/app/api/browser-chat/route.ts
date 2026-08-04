import { NextRequest } from 'next/server';
import { createBrowserChatSession, listBrowserChatSessions } from '@/server/ai/agents/browser-chat.service';
import { createBrowserChatSessionRequestSchema } from '@/server/http/browser-chat-request.schema';
import { noStoreJson } from '@/server/http/no-store-response';
import { requestApplicationUserId } from '@/server/auth/user-context';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function requestUserId(request: NextRequest) {
  return requestApplicationUserId(request);
}

export async function GET(request: NextRequest) {
  return noStoreJson({ sessions: listBrowserChatSessions({ userId: requestUserId(request) }) });
}

export async function POST(request: NextRequest) {
  try {
    const body = createBrowserChatSessionRequestSchema.parse(await request.json().catch(() => ({})));
    const session = createBrowserChatSession({
      targetUrl: body.targetUrl,
      safetyMode: body.safetyMode,
      modelProvider: body.modelProvider,
      model: body.model,
      title: body.title,
      userId: requestUserId(request),
    });
    return noStoreJson({ session });
  } catch (error) {
    return noStoreJson(
      { error: error instanceof Error ? error.message : 'Failed to create browser chat session' },
      { status: 400 },
    );
  }
}
