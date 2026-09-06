import type { ModelMessage } from 'ai';

export const runtimeOperationalContextMarker = '[WebPilot runtime operational context]';
export const runtimeCurrentTimeMarker = '[WebPilot runtime current time]';

function messageText(message: ModelMessage) {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.map((part) => (
    part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
      ? part.text
      : ''
  )).filter(Boolean).join('\n');
}

function markedMessageContent(message: ModelMessage, marker: string) {
  const text = messageText(message);
  return message.role === 'user' && text.startsWith(marker) ? text : undefined;
}

function latestMarkedMessageContent(messages: ModelMessage[], marker: string) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = markedMessageContent(messages[index], marker);
    if (content !== undefined) return content;
  }
  return undefined;
}

export function isRuntimePromptCacheMetadataMessage(message: ModelMessage) {
  return markedMessageContent(message, runtimeOperationalContextMarker) !== undefined
    || markedMessageContent(message, '[WebPilot knowledge context]') !== undefined
    || markedMessageContent(message, runtimeCurrentTimeMarker) !== undefined;
}

export function withoutRuntimePromptCacheMetadata(messages: ModelMessage[]) {
  return messages.filter((message) => !isRuntimePromptCacheMetadataMessage(message));
}

export function appendRuntimePromptCacheMetadata(input: {
  messages: ModelMessage[];
  operationalContext: string;
  currentTimeLine: string;
}) {
  const messages = [...input.messages];
  const metadataMessages: ModelMessage[] = [];
  const operationalContext = input.operationalContext.trim();
  const currentTimeLine = input.currentTimeLine.trim();
  const previousOperationalMessage = latestMarkedMessageContent(messages, runtimeOperationalContextMarker);
  const operationalMessage = operationalContext || previousOperationalMessage
    ? [
        runtimeOperationalContextMarker,
        'This is trusted runtime metadata, not a new user request. The newest snapshot supersedes earlier runtime snapshots.',
        operationalContext || 'No runtime operational context is currently active.',
      ].join('\n\n')
    : '';
  if (operationalMessage && previousOperationalMessage !== operationalMessage) {
    messages.push({ role: 'user', content: operationalMessage });
  }
  if (operationalMessage) metadataMessages.push({ role: 'user', content: operationalMessage });

  const timeMessage = currentTimeLine
    ? `${runtimeCurrentTimeMarker}\nThis is trusted runtime metadata, not a new user request.\n${currentTimeLine}`
    : '';
  if (timeMessage && latestMarkedMessageContent(messages, runtimeCurrentTimeMarker) !== timeMessage) {
    messages.push({ role: 'user', content: timeMessage });
  }
  if (timeMessage) metadataMessages.push({ role: 'user', content: timeMessage });

  return {
    messages,
    metadataMessages,
    operationalContextCharacters: operationalMessage.length,
  };
}
