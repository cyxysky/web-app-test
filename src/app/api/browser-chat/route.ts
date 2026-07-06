import { NextRequest } from 'next/server';
import { createBrowserChatSession, listBrowserChatSessions } from '@/server/ai/agents/browser-chat.service';
import { noStoreJson } from '@/server/http/no-store-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function requestUserId(request: NextRequest, body?: { userId?: unknown; qzUserId?: unknown }) {
  const value = body?.userId ?? body?.qzUserId ?? request.nextUrl.searchParams.get('userId') ?? request.nextUrl.searchParams.get('qzUserId');
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function safetyMode(value: unknown) {
  return value === 'full' ? 'full' : 'strict';
}

export async function GET(request: NextRequest) {
  return noStoreJson({ sessions: listBrowserChatSessions({ userId: requestUserId(request) }) });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const session = createBrowserChatSession({
      targetUrl: typeof body.targetUrl === 'string' ? body.targetUrl : '',
      mode: 'dom',
      safetyMode: safetyMode(body.safetyMode),
      modelProvider: typeof body.modelProvider === 'string' ? body.modelProvider : undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
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
