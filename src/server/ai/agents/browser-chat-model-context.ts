import { modelMessageSchema, type ModelMessage } from 'ai';
import { browserChatInterruptedTurnContextMarker } from './browser-chat-reply-text';

export type BrowserChatModelContextCompression = {
  compressedAt: string;
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
};

function serializableData(value: unknown, mediaType?: string): unknown {
  if (Buffer.isBuffer(value)) {
    return `data:${mediaType || 'application/octet-stream'};base64,${value.toString('base64')}`;
  }
  if (value instanceof ArrayBuffer) {
    return `data:${mediaType || 'application/octet-stream'};base64,${Buffer.from(value).toString('base64')}`;
  }
  if (ArrayBuffer.isView(value)) {
    return `data:${mediaType || 'application/octet-stream'};base64,${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64')}`;
  }
  return value;
}

function serializableValue(value: unknown, parentMediaType?: string): unknown {
  const binary = serializableData(value, parentMediaType);
  if (binary !== value) return binary;
  if (Array.isArray(value)) return value.map((item) => serializableValue(item));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const mediaType = typeof record.mediaType === 'string' ? record.mediaType : parentMediaType;
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [
    key,
    key === 'data' ? serializableData(child, mediaType) : serializableValue(child, mediaType),
  ]));
}

export function serializableBrowserChatModelMessages(messages: ModelMessage[]) {
  return normalizeBrowserChatModelMessages(serializableValue(messages));
}

export function compactBrowserChatModelTranscript(messages: ModelMessage[]) {
  return [...messages];
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

export function normalizeBrowserChatModelMessages(value: unknown): ModelMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((message) => {
    const parsed = modelMessageSchema.safeParse(message);
    return parsed.success ? [parsed.data] : [];
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
  return {
    version: 1,
    transcript,
    activeMessages: activeMessages.length ? activeMessages : transcript,
    ...(compression && typeof compression === 'object' ? { lastCompression: compression } : {}),
  };
}
