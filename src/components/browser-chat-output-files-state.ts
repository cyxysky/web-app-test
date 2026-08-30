type BrowserChatTurnMessage = {
  id: string;
  role: 'user' | 'assistant';
};

export function browserChatCurrentTurnAssistantMessageId(messages: readonly BrowserChatTurnMessage[]) {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      latestUserIndex = index;
      break;
    }
  }
  for (let index = messages.length - 1; index > latestUserIndex; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant') return message.id;
  }
  return undefined;
}
