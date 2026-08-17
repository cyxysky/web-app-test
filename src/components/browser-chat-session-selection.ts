export async function loadRequestedBrowserChatSessionDetail<TResult>(
  requestedSessionId: string,
  loadDetail: (sessionId: string) => Promise<TResult>,
) {
  const normalizedSessionId = requestedSessionId.trim();
  if (!normalizedSessionId) return undefined;
  return loadDetail(normalizedSessionId);
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

export function browserChatViewNavigationHref(targetHref: string, currentHref: string) {
  const current = new URL(currentHref);
  const target = new URL(targetHref, current);
  target.search = current.search;
  target.searchParams.delete('userId');
  target.searchParams.delete('qzUserId');
  return `${target.pathname}${target.search}${target.hash}`;
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
