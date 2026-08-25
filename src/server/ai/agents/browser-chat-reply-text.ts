export const browserChatInterruptedTurnContextMarker =
  '[Historical context only: the preceding browser-chat turn was interrupted before completion. Preserve completed tool results, but never quote or copy this marker into a response.]';

const browserChatContextOnlyMarkers = [
  browserChatInterruptedTurnContextMarker,
  '[This response was interrupted by the user before completion.]',
  '[The user interrupted this turn before the assistant produced text. Any completed tool messages remain valid conversation history.]',
] as const;

const privateToolProtocolPattern = /(?:<(?:minimax:)?tool_call\b[^>]*>|<function_calls\b[^>]*>|<invoke\b[^>]*>|[◁＜]\s*(?:tool_call|function_calls|invoke)\s*[▷＞])/i;

export function containsPrivateToolProtocol(value: string | undefined) {
  return privateToolProtocolPattern.test(value || '');
}

function removePrivateToolProtocol(value: string) {
  let text = value
    .replace(/<(?:minimax:)?tool_call\b[^>]*>[\s\S]*?<\/(?:minimax:)?tool_call\s*>/gi, '')
    .replace(/<function_calls\b[^>]*>[\s\S]*?<\/function_calls\s*>/gi, '')
    .replace(/[◁＜]\s*(?:tool_call|function_calls|invoke)\s*[▷＞][\s\S]*?[◁＜]\s*\/(?:tool_call|function_calls|invoke)\s*[▷＞]/gi, '');
  const dangling = text.search(privateToolProtocolPattern);
  if (dangling >= 0) text = text.slice(0, dangling);
  return text;
}

export function normalizeBrowserChatFinalReplyText(value: string | undefined) {
  return browserChatContextOnlyMarkers.reduce(
    (text, marker) => text.replaceAll(marker, ''),
    removePrivateToolProtocol((value || '').replace(/\r\n?/g, '\n')),
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
