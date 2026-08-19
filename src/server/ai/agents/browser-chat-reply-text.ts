export const browserChatInterruptedTurnContextMarker =
  '[Historical context only: the preceding browser-chat turn was interrupted before completion. Preserve completed tool results, but never quote or copy this marker into a response.]';

const browserChatContextOnlyMarkers = [
  browserChatInterruptedTurnContextMarker,
  '[This response was interrupted by the user before completion.]',
  '[The user interrupted this turn before the assistant produced text. Any completed tool messages remain valid conversation history.]',
] as const;

export function normalizeBrowserChatFinalReplyText(value: string | undefined) {
  return browserChatContextOnlyMarkers.reduce(
    (text, marker) => text.replaceAll(marker, ''),
    (value || '').replace(/\r\n?/g, '\n'),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function isBrowserChatDomObservationText(value: string | undefined) {
  const text = normalizeBrowserChatFinalReplyText(value);
  if (!text) return false;
  return /(?:^|\n)DOM snapshot (?:actionable|full|text):/i.test(text)
    || /(?:^|\n)Inter-action changes(?:\s|:)/i.test(text)
    || /\buid=dom-\d+-\d+\b/.test(text) && /<\/?[a-z][^>]*>/i.test(text)
    || /\buid=\d+\s+(?:RootWebArea|button|link|textbox|combobox|StaticText)\b/.test(text);
}
