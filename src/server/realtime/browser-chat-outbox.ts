import { publishBrowserChatRefreshEvent } from '@/server/realtime/ws-refresh';
import {
  markBrowserChatRealtimeOutboxDelivered,
  markBrowserChatRealtimeOutboxFailed,
  pruneDeliveredBrowserChatRealtimeOutbox,
  readPendingBrowserChatRealtimeOutbox,
} from '@/server/storage/sqlite-record-store';

type BrowserChatOutboxRuntimeState = {
  flush?: Promise<void>;
  requested?: boolean;
  retryTimer?: ReturnType<typeof setTimeout>;
};

const runtimeState = ((globalThis as typeof globalThis & {
  __browserChatOutboxRuntimeState?: BrowserChatOutboxRuntimeState;
}).__browserChatOutboxRuntimeState ??= {});

const retryDelayMs = 1_000;

async function publishPendingBrowserChatRealtimeEvents() {
  while (true) {
    const records = readPendingBrowserChatRealtimeOutbox(100);
    if (!records.length) {
      pruneDeliveredBrowserChatRealtimeOutbox();
      return;
    }
    for (const record of records) {
      try {
        await publishBrowserChatRefreshEvent(record.payload);
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
  })().finally(() => {
    runtimeState.flush = undefined;
  });
  return runtimeState.flush;
}

export function scheduleBrowserChatRealtimeOutboxFlush() {
  void flushBrowserChatRealtimeOutbox().catch(() => {
    if (runtimeState.retryTimer) return;
    runtimeState.retryTimer = setTimeout(() => {
      runtimeState.retryTimer = undefined;
      scheduleBrowserChatRealtimeOutboxFlush();
    }, retryDelayMs);
  });
}

const startupFlush = setTimeout(scheduleBrowserChatRealtimeOutboxFlush, 0);
startupFlush.unref?.();
