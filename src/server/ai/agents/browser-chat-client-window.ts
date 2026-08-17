import type {
  BrowserChatAiOutputCycle,
  BrowserChatSubagentRecord,
} from '@/server/ai/schemas/runtime.schema';

type BrowserChatClientMessage = {
  id: string;
  role: 'user' | 'assistant';
  status?: string;
  stepIndexes?: number[];
};

type BrowserChatClientRecordSource<TMessage extends BrowserChatClientMessage = BrowserChatClientMessage> = {
  messages?: TMessage[];
  outputCycles?: BrowserChatAiOutputCycle[];
  subagents?: BrowserChatSubagentRecord[];
};

type BrowserChatActiveRecordSource<TMessage extends BrowserChatClientMessage = BrowserChatClientMessage> = BrowserChatClientRecordSource<TMessage> & {
  busy?: boolean;
  status?: string;
  pendingToolConfirmation?: { messageId?: string };
};

export function activeBrowserChatAssistantMessage<TMessage extends BrowserChatClientMessage>(
  source: BrowserChatActiveRecordSource<TMessage>,
) {
  if (!source.busy && source.status !== 'running') return undefined;
  const messages = source.messages || [];
  const pendingMessageId = source.pendingToolConfirmation?.messageId;
  if (pendingMessageId) {
    const pendingMessage = messages.find((message) => (
      message.id === pendingMessageId && message.role === 'assistant'
    ));
    if (pendingMessage) return pendingMessage;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant' && message.status === 'running') return message;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant' && message.status === 'blocked') return message;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant') return message;
  }
  return undefined;
}

export function browserChatClientRecordsForMessage(
  source: BrowserChatClientRecordSource,
  messageId: string,
  options: { includeSubagents?: boolean } = {},
) {
  const message = (source.messages || []).find((item) => item.id === messageId);
  const stepIndexes = new Set(message?.stepIndexes || []);
  const belongsToMessage = (record: { messageId?: string; stepIndex?: number }) => (
    record.messageId
      ? record.messageId === messageId
      : record.stepIndex !== undefined && stepIndexes.has(record.stepIndex)
  );
  return {
    outputCycles: (source.outputCycles || []).filter((cycle) => (
      !cycle.subagentId && belongsToMessage(cycle)
    )),
    subagents: options.includeSubagents
      ? (source.subagents || []).filter((subagent) => subagent.messageId === messageId)
      : [],
  };
}
