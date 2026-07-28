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
