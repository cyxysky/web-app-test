export function browserSessionGroupLabel(sessionId?: string) {
  const normalized = (sessionId || 'browser-session')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const parts = normalized.split('_');
  const shortId = (parts.at(-1) || normalized || 'session').slice(-6).toLowerCase();
  return `ai-${shortId}`;
}
