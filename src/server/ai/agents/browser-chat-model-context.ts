import { modelMessageSchema, type ModelMessage } from 'ai';

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
  const transcript = normalizeBrowserChatModelMessages(record.transcript);
  const activeMessages = normalizeBrowserChatModelMessages(record.activeMessages);
  const compression = record.lastCompression;
  return {
    version: 1,
    transcript,
    activeMessages: activeMessages.length ? activeMessages : transcript,
    ...(compression && typeof compression === 'object' ? { lastCompression: compression } : {}),
  };
}
