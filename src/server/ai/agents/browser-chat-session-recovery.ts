import type { BrowserChatTurnState } from '@/server/ai/agents/browser-chat-session-state';

type RecoverableBrowserChatSession = {
  id: string;
  busy: boolean;
  status: 'idle' | 'running' | 'closed' | 'error';
  turnState?: BrowserChatTurnState;
  pendingToolConfirmation?: unknown;
};

type BrowserChatRuntimeRegistry = {
  activeTurns?: Pick<Map<string, unknown>, 'has'>;
};

const browserChatRuntimeGlobal = globalThis as typeof globalThis & {
  __browserChatRuntimeState?: BrowserChatRuntimeRegistry;
};

function hasActiveBrowserChatTurn(sessionId: string) {
  return browserChatRuntimeGlobal.__browserChatRuntimeState?.activeTurns?.has(sessionId) === true;
}

export function recoverOrphanedBrowserChatSession<T extends RecoverableBrowserChatSession>(
  persistedSummary: T,
): T {
  const persistedLifecycleNeedsReview = persistedSummary.busy
    || persistedSummary.status === 'running'
    || persistedSummary.turnState === 'interrupted';
  if (!persistedLifecycleNeedsReview || hasActiveBrowserChatTurn(persistedSummary.id)) {
    return persistedSummary;
  }
  return {
    ...persistedSummary,
    busy: false,
    status: 'idle',
    turnState: 'interrupted',
    pendingToolConfirmation: undefined,
  };
}
