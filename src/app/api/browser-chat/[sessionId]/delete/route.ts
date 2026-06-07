import { NextResponse } from 'next/server';
import { deleteBrowserChatSession } from '@/server/ai/agents/browser-chat.service';

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

export async function POST(_request: Request, context: RouteContext) {
  const { sessionId } = await context.params;
  const deleted = await deleteBrowserChatSession(sessionId);
  if (!deleted) return NextResponse.json({ error: 'Browser chat session not found' }, { status: 404 });
  return NextResponse.json({ ok: true, deleted });
}
