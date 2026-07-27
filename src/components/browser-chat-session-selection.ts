export function findRequestedBrowserChatSession<TSession extends { id: string }>(
  sessions: TSession[],
  requestedSessionId: string,
) {
  const normalizedSessionId = requestedSessionId.trim();
  if (!normalizedSessionId) return undefined;
  return sessions.find((session) => session.id === normalizedSessionId);
}
