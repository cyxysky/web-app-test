export async function loadRequestedBrowserChatSessionDetail<TResult>(
  requestedSessionId: string,
  loadDetail: (sessionId: string) => Promise<TResult>,
) {
  const normalizedSessionId = requestedSessionId.trim();
  if (!normalizedSessionId) return undefined;
  return loadDetail(normalizedSessionId);
}

type BrowserChatSessionListRecord = {
  consoleErrors?: unknown[];
  contextUsage?: unknown;
  error?: unknown;
  hasMessages?: boolean;
  logs?: unknown[];
  messages?: unknown[];
  networkErrors?: unknown[];
  outputCycles?: unknown[];
  pendingToolConfirmation?: unknown;
  queuedTurns?: unknown[];
  steps?: unknown[];
  subagents?: unknown[];
  targetUrl?: string;
};

export function compactBrowserChatSessionForList<T extends BrowserChatSessionListRecord>(
  session: T,
): T & BrowserChatSessionListRecord {
  return {
    ...session,
    consoleErrors: [],
    contextUsage: undefined,
    error: undefined,
    hasMessages: session.hasMessages === true || Boolean(session.messages?.length),
    logs: [],
    messages: [],
    networkErrors: [],
    outputCycles: [],
    pendingToolConfirmation: undefined,
    queuedTurns: [],
    steps: [],
    subagents: [],
    targetUrl: '',
  };
}

export function shouldActivateRequestedBrowserChatSession({
  activeSessionId,
  currentSelectionIntent,
  requestedSessionId,
  selectionIntent,
}: {
  activeSessionId: string | null;
  currentSelectionIntent: number;
  requestedSessionId: string;
  selectionIntent: number;
}) {
  return selectionIntent === currentSelectionIntent
    && (!activeSessionId || activeSessionId === requestedSessionId);
}

export function shouldAcceptBrowserChatViewportPosition({
  activeSessionId,
  positionedSessionId,
}: {
  activeSessionId: string | null;
  positionedSessionId?: string;
}) {
  return Boolean(positionedSessionId && activeSessionId === positionedSessionId);
}

export function shouldFinishBrowserChatSessionLoading({
  loadingSessionId,
  minimumLoadingElapsed,
  viewportReady,
}: {
  loadingSessionId: string | null;
  minimumLoadingElapsed: boolean;
  viewportReady: boolean;
}) {
  return Boolean(loadingSessionId && minimumLoadingElapsed && viewportReady);
}

export function browserChatSessionNavigationHref(currentHref: string, sessionId?: string) {
  const current = new URL(currentHref);
  const normalizedSessionId = sessionId?.trim() || '';
  if (normalizedSessionId) current.searchParams.set('sessionId', normalizedSessionId);
  else current.searchParams.delete('sessionId');
  current.searchParams.delete('targetUrl');
  current.searchParams.delete('userId');
  current.searchParams.delete('qzUserId');
  current.searchParams.delete('onboarding');
  return `${current.pathname}${current.search}${current.hash}`;
}
