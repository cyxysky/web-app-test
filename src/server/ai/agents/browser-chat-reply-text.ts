export function normalizeBrowserChatFinalReplyText(value: string | undefined) {
  return (value || '')
    .replace(/\r\n?/g, '\n')
    .trim();
}
