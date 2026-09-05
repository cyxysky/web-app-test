export type BrowserChatActivity = { phase: string; label: string; updatedAt: string; startedAt?: string };

/** updatedAt is a heartbeat; it must never become the elapsed-time origin. */
export function nextBrowserChatActivity(input: {
  phase: string; label: string; timestamp: string; elapsedMs?: number; previous?: BrowserChatActivity;
}): BrowserChatActivity {
  const startedAt = typeof input.elapsedMs === 'number' && Number.isFinite(input.elapsedMs)
    ? new Date(Date.parse(input.timestamp) - Math.max(0, input.elapsedMs)).toISOString()
    : input.previous?.phase === input.phase
      ? input.previous.startedAt || input.previous.updatedAt
      : input.timestamp;
  return { phase: input.phase, label: input.label, updatedAt: input.timestamp, startedAt };
}
