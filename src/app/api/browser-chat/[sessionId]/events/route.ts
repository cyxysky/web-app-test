import {
  currentBrowserChatSessionEvent,
  getBrowserChatSession,
  subscribeBrowserChatSessionEvents,
} from '@/server/ai/agents/browser-chat.service';
import { createSnapshotEventStream } from '@/server/realtime/snapshot-channel';

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: RouteContext) {
  const { sessionId } = await context.params;
  return createSnapshotEventStream({
    request,
    eventName: 'session',
    getSnapshot: () => getBrowserChatSession(sessionId),
    initialEvent: (session) => currentBrowserChatSessionEvent(sessionId, session),
    subscribe: (listener) => subscribeBrowserChatSessionEvents(sessionId, listener),
    notFoundMessage: 'Browser chat session not found',
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}
