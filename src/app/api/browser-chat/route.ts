import { NextRequest } from 'next/server';
import { createBrowserChatSession, listBrowserChatSessions } from '@/server/ai/agents/browser-chat.service';
import { noStoreJson } from '@/server/http/no-store-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  return noStoreJson({ sessions: listBrowserChatSessions() });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const session = createBrowserChatSession({
      targetUrl: typeof body.targetUrl === 'string' ? body.targetUrl : '',
      mode: body.mode === 'dom' || body.mode === 'visual-markers' ? body.mode : 'visual-markers',
      title: typeof body.title === 'string' ? body.title : undefined,
    });
    return noStoreJson({ session });
  } catch (error) {
    return noStoreJson(
      { error: error instanceof Error ? error.message : 'Failed to create browser chat session' },
      { status: 400 },
    );
  }
}
