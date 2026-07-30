import { NextRequest } from 'next/server';
import { createBrowserChatSession, listBrowserChatSessions } from '@/server/ai/agents/browser-chat.service';
import { createBrowserChatSessionRequestSchema, type CreateBrowserChatSessionRequest } from '@/server/http/browser-chat-request.schema';
import { noStoreJson } from '@/server/http/no-store-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function requestUserId(request: NextRequest, body?: Pick<CreateBrowserChatSessionRequest, 'userId' | 'qzUserId'>) {
  const value = body?.userId ?? body?.qzUserId ?? request.nextUrl.searchParams.get('userId') ?? request.nextUrl.searchParams.get('qzUserId');
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
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
      userId: requestUserId(request, body),
    });
    return noStoreJson({ session });
  } catch (error) {
    return noStoreJson(
      { error: error instanceof Error ? error.message : 'Failed to create browser chat session' },
      { status: 400 },
    );
  }
}
