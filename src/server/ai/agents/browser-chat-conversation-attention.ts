export type BrowserChatConversationAttentionMessage = {
  content: string;
  role: 'assistant' | 'user';
  status?: string;
};

type ConversationTurn = {
  assistant?: string;
  user: string;
};

function compactAttentionText(value: string, maxChars: number) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function conversationTurns(messages: BrowserChatConversationAttentionMessage[]) {
  const turns: ConversationTurn[] = [];
  for (const message of messages) {
    const content = compactAttentionText(message.content, 20_000);
    if (!content) continue;
    if (message.role === 'user') {
      turns.push({ user: content });
      continue;
    }
    if (message.status === 'running' || !turns.length) continue;
    turns[turns.length - 1]!.assistant = content;
  }
  return turns;
}

export function browserChatConversationAttentionContext(
  messages: BrowserChatConversationAttentionMessage[],
) {
  const turns = conversationTurns(messages);
  if (turns.length < 2) return '';
  const recentCompleted = turns
    .slice(0, -1)
    .filter((turn) => Boolean(turn.assistant))
    .slice(-4);
  if (!recentCompleted.length) return '';

  return [
    '[Conversation attention anchors]',
    'This is a bounded index of prior completed exchanges, not a user request and not a replacement for the native AI SDK message chain. Use it silently for continuity and never quote or summarize this index to the user.',
    'Recent completed user/assistant exchanges:',
    ...recentCompleted.flatMap((turn, index) => [
      `${index + 1}. User: ${compactAttentionText(turn.user, 900)}`,
      `   Assistant: ${compactAttentionText(turn.assistant || '', 1_400)}`,
    ]),
    'The latest real user message in the native message chain remains the only current request.',
  ].join('\n');
}
