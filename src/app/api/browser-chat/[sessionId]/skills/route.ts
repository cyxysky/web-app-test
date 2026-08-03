import { NextRequest } from 'next/server';
import { generateBrowserChatMessagesSkill, generateBrowserChatMessageSkill } from '@/server/ai/agents/browser-chat.service';
import { noStoreJson } from '@/server/http/no-store-response';
import { requestApplicationUserId } from '@/server/auth/user-context';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  const { sessionId } = await context.params;
  try {
    const body = await request.json().catch(() => ({}));
    const userId = requestApplicationUserId(request);
    const messageIds = Array.isArray(body.messageIds)
      ? body.messageIds.filter((item: unknown): item is string => typeof item === 'string')
      : [];
    const messageId = typeof body.messageId === 'string' ? body.messageId : '';
    const generated = messageIds.length
      ? await generateBrowserChatMessagesSkill(sessionId, messageIds, userId)
      : await generateBrowserChatMessageSkill(sessionId, messageId, userId);
    return noStoreJson({
      ok: true,
      skill: generated.skill,
      sourceMessageIds: generated.sourceMessageIds,
    });
  } catch (error) {
    return noStoreJson(
      { error: error instanceof Error ? error.message : 'Failed to generate skill from browser chat' },
      { status: 400 },
    );
  }
}
