import { NextRequest, NextResponse } from 'next/server';
import { createBrowserChatSession, listBrowserChatSessions } from '@/server/ai/agents/browser-chat.service';

export async function GET() {
  return NextResponse.json({ sessions: listBrowserChatSessions() });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const session = createBrowserChatSession({
      targetUrl: typeof body.targetUrl === 'string' ? body.targetUrl : '',
      mode: body.mode === 'dom' || body.mode === 'visual-markers' ? body.mode : 'visual-markers',
      title: typeof body.title === 'string' ? body.title : undefined,
    });
    return NextResponse.json({ session });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create browser chat session' },
      { status: 400 },
    );
  }
}
