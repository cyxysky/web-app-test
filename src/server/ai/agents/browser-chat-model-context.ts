import { createHash } from 'node:crypto';
import { modelMessageSchema, type ModelMessage } from 'ai';
import type { RuntimeContextManifest, RuntimeTaskState } from './runtime-context-assembler';
import type { RuntimeKnowledgeState } from './runtime-knowledge-context';
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
  version: 2;
  /** Immutable content-addressed records. Storage moves these out of the session header. */
  records: Record<string, ModelMessage>;
  history: string[];
  active: string[];
  taskState?: RuntimeTaskState;
  lastRequest?: RuntimeContextManifest;
  knowledge?: RuntimeKnowledgeState;
  branches?: Record<string, {
    recordIds: string[];
    active: string[];
    history: string[];
    taskState?: RuntimeTaskState;
    lastRequest?: RuntimeContextManifest;
    continuationSummary?: string;
    knowledge?: RuntimeKnowledgeState;
  }>;
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
  // An interrupted/pending exchange is evidence too. Repair only the request view.
  return serializableBrowserChatModelMessages(messages);
}

export function browserChatContextRecordId(message: ModelMessage) {
  return `ctx_${createHash('sha256').update(JSON.stringify(message)).digest('hex')}`;
}

export function browserChatTranscript(context: BrowserChatModelContext) {
  return context.history.map((id) => context.records[id]).filter(Boolean);
}

export function browserChatActiveMessages(context: BrowserChatModelContext) {
  return completeRuntimeModelToolChain(context.active.map((id) => context.records[id]).filter(Boolean));
}

export function archiveBrowserChatContextMessages(context: BrowserChatModelContext, messages: ModelMessage[]) {
  const records = { ...context.records };
  for (const message of serializableBrowserChatModelMessages(messages)) {
    records[browserChatContextRecordId(message)] = message;
  }
  return { ...context, records };
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
    ? value as Partial<BrowserChatModelContext> & { transcript?: unknown; activeMessages?: unknown }
    : {};
  const records: Record<string, ModelMessage> = { ...record.records };
  const register = (messages: ModelMessage[]) => messages.map((message) => {
    const id = browserChatContextRecordId(message);
    records[id] = message;
    return id;
  });
  const history = record.transcript !== undefined
    ? register(normalizeBrowserChatModelMessages(record.transcript))
    : (record.history || []).filter((id) => Boolean(records[id]));
  const active = record.activeMessages !== undefined
    ? register(normalizeBrowserChatModelMessages(record.activeMessages))
    : (record.active || history).filter((id) => Boolean(records[id]));
  const compression = record.lastCompression;
  const continuationSummary = typeof record.continuationSummary === 'string'
    ? record.continuationSummary.trim()
    : '';
  return {
    version: 2,
    records,
    history,
    active,
    ...(record.taskState ? { taskState: record.taskState } : {}),
    ...(record.lastRequest ? { lastRequest: record.lastRequest } : {}),
    ...(record.knowledge ? { knowledge: record.knowledge } : {}),
    ...(record.branches ? { branches: record.branches } : {}),
    ...(compression && typeof compression === 'object' ? { lastCompression: compression } : {}),
    ...(continuationSummary ? { continuationSummary } : {}),
  };
}
