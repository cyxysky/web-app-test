import { NextRequest } from 'next/server';
import { deleteBrowserChatSessions } from '@/server/ai/agents/browser-chat.service';
import { noStoreJson } from '@/server/http/no-store-response';
import { requestApplicationUserId } from '@/server/auth/user-context';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function requestUserId(request: NextRequest) {
  return requestApplicationUserId(request);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch((): { ids?: unknown } => ({})) as {
      ids?: unknown;
    };
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((item: unknown): item is string => typeof item === 'string')
      : [];
    if (!ids.length) return noStoreJson({ error: 'No browser chat sessions selected' }, { status: 400 });
    const result = await deleteBrowserChatSessions(ids, requestUserId(request));
    return noStoreJson({ ok: true, ...result });
  } catch (error) {
    return noStoreJson(
      { error: error instanceof Error ? error.message : 'Failed to delete browser chat sessions' },
      { status: 400 },
    );
  }
}
