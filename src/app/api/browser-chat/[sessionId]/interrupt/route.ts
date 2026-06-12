import { NextResponse } from 'next/server';
import { interruptBrowserChatSession } from '@/server/ai/agents/browser-chat.service';

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

export async function POST(_request: Request, context: RouteContext) {
  const { sessionId } = await context.params;
  const session = await interruptBrowserChatSession(sessionId);
  if (!session) return NextResponse.json({ error: 'Browser chat session not found' }, { status: 404 });
  return NextResponse.json({ session });
}
