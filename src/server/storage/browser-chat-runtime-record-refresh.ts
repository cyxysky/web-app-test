import { normalizeApplicationUserId } from '@/server/auth/user-context';
import { publishRealtimeRefreshEvent } from '@/server/realtime/ws-refresh';
import { readBrowserChatSessionOwner } from './browser-chat-history-store';

export async function publishBrowserChatRuntimeRecordsChanged(
  sessionId: string,
  kind: 'defects' | 'variables',
) {
  const owner = await readBrowserChatSessionOwner(sessionId);
  if (!owner) return;
  await publishRealtimeRefreshEvent({
    entityType: 'browserChatSession',
    id: sessionId,
    userId: normalizeApplicationUserId(owner.userId),
    patch: { runtimeRecordsChanged: true, runtimeRecordKind: kind },
  }).catch(() => undefined);
}
