import { publishRealtimeRefreshEvent } from '@/server/realtime/ws-refresh';
import {
  markBrowserChatRealtimeOutboxDelivered,
  markBrowserChatRealtimeOutboxFailed,
  pruneDeliveredBrowserChatRealtimeOutbox,
  readPendingBrowserChatRealtimeOutbox,
} from '@/server/storage/sqlite-record-store';

type BrowserChatOutboxRuntimeState = {
  flush?: Promise<void>;
  requested?: boolean;
  retryAttempt?: number;
  retryTimer?: ReturnType<typeof setTimeout>;
};

const runtimeState = ((globalThis as typeof globalThis & {
  __browserChatOutboxRuntimeState?: BrowserChatOutboxRuntimeState;
}).__browserChatOutboxRuntimeState ??= {});

const retryDelayBaseMs = 1_000;
const retryDelayMaxMs = 30_000;

export function browserChatOutboxRetryDelay(attempt: number) {
  const normalizedAttempt = Number.isFinite(attempt) ? Math.max(0, Math.trunc(attempt)) : 0;
  return Math.min(retryDelayMaxMs, retryDelayBaseMs * (2 ** normalizedAttempt));
}

async function publishPendingBrowserChatRealtimeEvents() {
  while (true) {
    const records = readPendingBrowserChatRealtimeOutbox(100);
    if (!records.length) {
      pruneDeliveredBrowserChatRealtimeOutbox();
      return;
    }
    for (const record of records) {
      try {
        await publishRealtimeRefreshEvent(record.payload);
        markBrowserChatRealtimeOutboxDelivered(record.id);
      } catch (error) {
        markBrowserChatRealtimeOutboxFailed(
          record.id,
          error instanceof Error ? error.message : 'Unknown realtime publish error',
        );
        throw error;
      }
    }
  }
}

export function flushBrowserChatRealtimeOutbox() {
  runtimeState.requested = true;
  if (runtimeState.retryTimer) {
    clearTimeout(runtimeState.retryTimer);
    runtimeState.retryTimer = undefined;
  }
  if (runtimeState.flush) return runtimeState.flush;
  runtimeState.flush = (async () => {
    do {
      runtimeState.requested = false;
      await publishPendingBrowserChatRealtimeEvents();
    } while (runtimeState.requested);
    runtimeState.retryAttempt = 0;
  })().finally(() => {
    runtimeState.flush = undefined;
  });
  return runtimeState.flush;
}

export function scheduleBrowserChatRealtimeOutboxFlush() {
  runtimeState.requested = true;
  if (runtimeState.retryTimer || runtimeState.flush) return;
  void flushBrowserChatRealtimeOutbox().then(
    () => undefined,
    () => {
      if (runtimeState.retryTimer) return;
      const retryAttempt = runtimeState.retryAttempt || 0;
      runtimeState.retryAttempt = retryAttempt + 1;
      runtimeState.retryTimer = setTimeout(() => {
        runtimeState.retryTimer = undefined;
        scheduleBrowserChatRealtimeOutboxFlush();
      }, browserChatOutboxRetryDelay(retryAttempt));
      runtimeState.retryTimer.unref?.();
    },
  );
}

const startupFlush = setTimeout(scheduleBrowserChatRealtimeOutboxFlush, 0);
startupFlush.unref?.();
