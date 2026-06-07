import { NextResponse } from 'next/server';
import { closeBrowserChatSession, getBrowserChatSession } from '@/server/ai/agents/browser-chat.service';

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { sessionId } = await context.params;
  const session = getBrowserChatSession(sessionId);
  if (!session) return NextResponse.json({ error: 'Browser chat session not found' }, { status: 404 });
  return NextResponse.json({ session });
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { sessionId } = await context.params;
  const session = await closeBrowserChatSession(sessionId);
  if (!session) return NextResponse.json({ error: 'Browser chat session not found' }, { status: 404 });
  return NextResponse.json({ session });
}
