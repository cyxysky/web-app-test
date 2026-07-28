export function selectEmbeddedBrowserChatSessionId<TSession extends { id: string; messages: unknown[] }>(
  sessions: TSession[],
  requestedSessionId: string,
) {
  const requested = requestedSessionId.trim();
  if (requested) return requested;
  return sessions.find((session) => session.messages.length > 0)?.id || '';
}
