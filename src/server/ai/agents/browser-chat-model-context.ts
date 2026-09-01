import { modelMessageSchema, type ModelMessage } from 'ai';
import { browserChatInterruptedTurnContextMarker } from './browser-chat-reply-text';
import { completeRuntimeModelToolChain } from './runtime-context-compression';

export type BrowserChatModelContextCompression = {
  compressedAt: string;
  continuationSummary: string;
  estimatedTokensAfter: number;
  estimatedTokensBefore: number;
  retainedMessageCount: number;
  summarizedMessageCount: number;
  targetCeilingTokens: number;
  targetFloorTokens: number;
  thresholdTokens: number;
  windowTokens: number;
};

export type BrowserChatModelContext = {
  version: 1;
  transcript: ModelMessage[];
  activeMessages: ModelMessage[];
  lastCompression?: BrowserChatModelContextCompression;
  continuationSummary?: string;
};

const persistentBinaryOmissionText = '[Binary visual input omitted from persistent model context; use the conversation file registry to read it again.]';

function withoutPersistentBinaryParts(message: ModelMessage): ModelMessage {
  if (!Array.isArray(message.content)) return message;
  const content = message.content.filter((part) => (
    !part || typeof part !== 'object' || !('type' in part) || (part.type !== 'file' && part.type !== 'image')
  ));
  if (content.length) return { ...message, content } as ModelMessage;
  return { ...message, content: persistentBinaryOmissionText } as ModelMessage;
}

export function serializableBrowserChatModelMessages(messages: ModelMessage[]) {
  return normalizeBrowserChatModelMessages(messages.map(withoutPersistentBinaryParts));
}

export function compactBrowserChatModelTranscript(messages: ModelMessage[]) {
  return completeRuntimeModelToolChain(messages);
}

function modelMessageText(message: ModelMessage) {
  if (typeof message.content === 'string') return message.content.trim();
  if (!Array.isArray(message.content)) return '';
  return message.content.flatMap((part) => {
    if (!part || typeof part !== 'object') return [];
    const text = 'text' in part && typeof part.text === 'string' ? part.text.trim() : '';
    return text ? [text] : [];
  }).join('\n').trim();
}

function messagesContainText(messages: ModelMessage[], role: 'user' | 'assistant', text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return messages.slice(-16).some((message) => {
    if (message.role !== role) return false;
    const candidate = modelMessageText(message).replace(/\s+/g, ' ').trim();
    return Boolean(candidate) && (candidate === normalized || candidate.includes(normalized) || normalized.includes(candidate));
  });
}

export function appendInterruptedBrowserChatTurn(
  messages: ModelMessage[],
  userContent: string,
  assistantContent: string,
) {
  const next = [...messages];
  const partial = assistantContent.trim();
  const interruptionMarker = browserChatInterruptedTurnContextMarker;
  if (!messagesContainText(next, 'user', userContent)) {
    next.push({ role: 'user', content: userContent });
  }
  const partialAlreadyStored = partial && messagesContainText(next, 'assistant', partial);
  if (!messagesContainText(next, 'assistant', interruptionMarker)) {
    next.push({
      role: 'assistant',
      content: partialAlreadyStored ? interruptionMarker : [partial, interruptionMarker].filter(Boolean).join('\n\n'),
    });
  }
  return serializableBrowserChatModelMessages(next);
}

export function appendTerminalBrowserChatTurn(
  messages: ModelMessage[],
  userContent: string,
  assistantContent: string,
) {
  const next = [...messages];
  if (!messagesContainText(next, 'user', userContent)) {
    next.push({ role: 'user', content: userContent });
  }
  if (!messagesContainText(next, 'assistant', assistantContent)) {
    next.push({ role: 'assistant', content: assistantContent });
  }
  return serializableBrowserChatModelMessages(next);
}

export function normalizeBrowserChatModelMessages(value: unknown): ModelMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((message) => {
    const parsed = modelMessageSchema.safeParse(message);
    return parsed.success ? [withoutPersistentBinaryParts(parsed.data)] : [];
  });
}

export function normalizeBrowserChatModelContext(value: unknown): BrowserChatModelContext {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<BrowserChatModelContext>
    : {};
  const transcript = compactBrowserChatModelTranscript(normalizeBrowserChatModelMessages(record.transcript));
  const activeMessages = compactBrowserChatModelTranscript(
    normalizeBrowserChatModelMessages(record.activeMessages),
  );
  const compression = record.lastCompression;
  const continuationSummary = typeof record.continuationSummary === 'string'
    ? record.continuationSummary.trim().slice(0, 24_000)
    : '';
  return {
    version: 1,
    transcript,
    activeMessages: activeMessages.length ? activeMessages : transcript,
    ...(compression && typeof compression === 'object' ? { lastCompression: compression } : {}),
    ...(continuationSummary ? { continuationSummary } : {}),
  };
}
