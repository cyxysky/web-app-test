export const BROWSER_CHAT_FILE_READ_MIN_CHARS = 20_000;
export const BROWSER_CHAT_FILE_READ_MAX_CHARS = 40_000;

export function normalizeBrowserChatFileReadLimit(value: unknown) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number)
    ? Math.min(BROWSER_CHAT_FILE_READ_MAX_CHARS, Math.max(BROWSER_CHAT_FILE_READ_MIN_CHARS, Math.floor(number)))
    : BROWSER_CHAT_FILE_READ_MIN_CHARS;
}
