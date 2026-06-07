import { NextRequest, NextResponse } from 'next/server';
import { sendBrowserChatMessage } from '@/server/ai/agents/browser-chat.service';

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  const { sessionId } = await context.params;
  try {
    const body = await request.json();
    const content = typeof body.content === 'string' ? body.content : '';
    const mode = body.mode === 'dom' || body.mode === 'visual-markers' ? body.mode : 'visual-markers';
    const clientMessageId = typeof body.clientMessageId === 'string' ? body.clientMessageId : undefined;
    const session = await sendBrowserChatMessage(sessionId, content, mode, clientMessageId);
    return NextResponse.json({ session });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to send browser chat message';
    return NextResponse.json(
      { error: message },
      { status: /Browser chat session not found/i.test(message) ? 404 : 400 },
    );
  }
}
