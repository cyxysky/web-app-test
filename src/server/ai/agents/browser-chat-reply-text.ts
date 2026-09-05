import { stripBrowserChatContextMarkers } from '../../../lib/browser-chat-visible-text';
export { browserChatInterruptedTurnContextMarker } from '../../../lib/browser-chat-visible-text';

const privateToolProtocolPattern = /(?:<(?:minimax:)?tool_call\b[^>]*>|<function_calls\b[^>]*>|<invoke\b[^>]*>|[◁＜]\s*(?:tool_call|function_calls|invoke)\s*[▷＞])/i;

export function containsPrivateToolProtocol(value: string | undefined) {
  return privateToolProtocolPattern.test(value || '') || isTextualToolCallStub(value);
}

// Some providers imitate a transcript instead of emitting tool_calls. Only
// recognize a whole response with a matching name and arguments, not prose
// discussing tools or quoted examples. Detection never authorizes execution.
function isTextualToolCallStub(value: string | undefined) {
  const match = (value || '').trim().match(/^\[Tool call:\s*([\w.-]+)\]\s*(\{[\s\S]*\})$/i);
  if (!match) return false;
  try {
    const call = JSON.parse(match[2]);
    return call?.name === match[1] && call.arguments !== null && typeof call.arguments === 'object' && !Array.isArray(call.arguments);
  } catch { return false; }
}

function removePrivateToolProtocol(value: string) {
  if (isTextualToolCallStub(value)) return '';
  let text = value
    .replace(/<(?:minimax:)?tool_call\b[^>]*>[\s\S]*?<\/(?:minimax:)?tool_call\s*>/gi, '')
    .replace(/<function_calls\b[^>]*>[\s\S]*?<\/function_calls\s*>/gi, '')
    .replace(/[◁＜]\s*(?:tool_call|function_calls|invoke)\s*[▷＞][\s\S]*?[◁＜]\s*\/(?:tool_call|function_calls|invoke)\s*[▷＞]/gi, '');
  const dangling = text.search(privateToolProtocolPattern);
  if (dangling >= 0) text = text.slice(0, dangling);
  return text;
}

export function normalizeBrowserChatFinalReplyText(value: string | undefined) {
  return stripBrowserChatContextMarkers(removePrivateToolProtocol((value || '').replace(/\r\n?/g, '\n')));
}

export function isBrowserChatDomObservationText(value: string | undefined) {
  const text = normalizeBrowserChatFinalReplyText(value);
  if (!text) return false;
  return /(?:^|\n)DOM snapshot (?:actionable|full|text):/i.test(text)
    || /(?:^|\n)Inter-action changes(?:\s|:)/i.test(text)
    || /\buid=dom-\d+-\d+\b/.test(text) && /<\/?[a-z][^>]*>/i.test(text)
    || /\buid=\d+\s+(?:RootWebArea|button|link|textbox|combobox|StaticText)\b/.test(text);
}
