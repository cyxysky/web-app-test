import { normalizeApplicationUserId } from '@/server/auth/user-context';
import { publishRealtimeRefreshEvent } from '@/server/realtime/ws-refresh';
import { readBrowserChatSessionOwner } from './browser-chat-history-store';

export function publishBrowserChatRuntimeRecordsChanged(
  sessionId: string,
  kind: 'defects' | 'variables',
) {
  const owner = readBrowserChatSessionOwner(sessionId);
  if (!owner) return;
  void publishRealtimeRefreshEvent({
    entityType: 'browserChatSession',
    id: sessionId,
    userId: normalizeApplicationUserId(owner.userId),
    patch: { runtimeRecordsChanged: true, runtimeRecordKind: kind },
  }).catch(() => undefined);
}
