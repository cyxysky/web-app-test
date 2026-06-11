import { NextRequest, NextResponse } from 'next/server';
import { deleteBrowserChatSessions } from '@/server/ai/agents/browser-chat.service';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch((): { ids?: unknown } => ({})) as { ids?: unknown };
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((item: unknown): item is string => typeof item === 'string')
      : [];
    if (!ids.length) return NextResponse.json({ error: 'No browser chat sessions selected' }, { status: 400 });
    const result = await deleteBrowserChatSessions(ids);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete browser chat sessions' },
      { status: 400 },
    );
  }
}
