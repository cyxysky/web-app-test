import { NextRequest } from 'next/server';
import { switchBrowserChatTab } from '@/server/ai/agents/browser-chat.service';
import { noStoreJson } from '@/server/http/no-store-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ sessionId: string; index: string }>;
};

function requestUserId(request: NextRequest) {
  const value = request.nextUrl.searchParams.get('userId')
    || request.nextUrl.searchParams.get('qzUserId')
    || '';
  return typeof value === 'string' ? value.trim() : '';
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { sessionId, index } = await context.params;
  const parsed = Number(index);
  try {
    const session = await switchBrowserChatTab(sessionId, parsed, requestUserId(request));
    if (!session) return noStoreJson({ error: 'Browser chat session not found' }, { status: 404 });
    return noStoreJson({ session });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to switch browser tab';
    return noStoreJson(
      { error: message },
      { status: /session not found/i.test(message) || /closed/i.test(message) ? 404 : /Invalid tab index/i.test(message) ? 400 : 500 },
    );
  }
}
