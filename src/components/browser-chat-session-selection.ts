export function findRequestedBrowserChatSession<TSession extends { id: string }>(
  sessions: TSession[],
  requestedSessionId: string,
) {
  const normalizedSessionId = requestedSessionId.trim();
  if (!normalizedSessionId) return undefined;
  return sessions.find((session) => session.id === normalizedSessionId);
}

export async function loadRequestedBrowserChatSessionDetail<TSession extends { id: string }, TResult>(
  sessions: TSession[],
  requestedSessionId: string,
  loadDetail: (session: TSession) => Promise<TResult>,
) {
  const requestedSession = findRequestedBrowserChatSession(sessions, requestedSessionId);
  if (!requestedSession) return undefined;
  return loadDetail(requestedSession);
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
  return `${current.pathname}${current.search}${current.hash}`;
}
