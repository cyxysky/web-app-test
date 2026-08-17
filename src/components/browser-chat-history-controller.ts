export type BrowserChatHistoryPageState = {
  cursor?: string;
  hasMore: boolean;
};

export type BrowserChatHistoryState = {
  logs: BrowserChatHistoryPageState;
  messages: BrowserChatHistoryPageState;
  steps: BrowserChatHistoryPageState;
};

type MessageLike = { clientMessageId?: string; createdAt?: string; id: string; role?: string };
type StepLike = { index: number };
type LogLike = { id: string; time?: string };
type HistorySession<TMessage extends MessageLike, TStep extends StepLike, TLog extends LogLike> = {
  history?: BrowserChatHistoryState;
  id: string;
  logs: TLog[];
  messages: TMessage[];
  steps: TStep[];
  outputCycles?: unknown[];
  subagents?: unknown[];
};

export function normalizeBrowserChatHistory(value: BrowserChatHistoryState | undefined) {
  if (!value) return undefined;
  return {
    messages: { cursor: value.messages?.cursor, hasMore: Boolean(value.messages?.hasMore) },
    steps: { cursor: value.steps?.cursor, hasMore: Boolean(value.steps?.hasMore) },
    logs: { cursor: value.logs?.cursor, hasMore: Boolean(value.logs?.hasMore) },
  } satisfies BrowserChatHistoryState;
}

export function browserChatHasEarlierMessages(value: BrowserChatHistoryState | undefined) {
  return Boolean(value?.messages.hasMore && value.messages.cursor);
}

export function beginHistoricalSubagentQuery(queriedKeys: Set<string>, key: string) {
  if (queriedKeys.has(key)) return false;
  queriedKeys.add(key);
  return true;
}

function messageKey(message: MessageLike) {
  return message.clientMessageId && message.role
    ? `client:${message.clientMessageId}:${message.role}`
    : `id:${message.id}`;
}

function historyRecordId(value: unknown) {
  if (!value || typeof value !== 'object' || !('id' in value)) return undefined;
  const id = value.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined;
}

function mergeHistoryRecords<T>(existing: T[] | undefined, incoming: T[] | undefined) {
  const merged = [...(existing || [])];
  const indexes = new Map<string, number>();
  merged.forEach((value, index) => {
    const id = historyRecordId(value);
    if (id !== undefined) indexes.set(id, index);
  });
  for (const value of incoming || []) {
    const id = historyRecordId(value);
    const index = id === undefined ? undefined : indexes.get(id);
    if (index === undefined) {
      if (id !== undefined) indexes.set(id, merged.length);
      merged.push(value);
    } else {
      merged[index] = value;
    }
  }
  return merged;
}

export function mergeBrowserChatSessionWindowData<
  TMessage extends MessageLike,
  TStep extends StepLike,
  TLog extends LogLike,
  TSession extends HistorySession<TMessage, TStep, TLog>,
>(existing: TSession | null | undefined, incoming: TSession): TSession {
  if (!existing || existing.id !== incoming.id || !incoming.history) return incoming;
  const messages = new Map(existing.messages.map((message) => [messageKey(message), message]));
  for (const message of incoming.messages) messages.set(messageKey(message), message);
  const steps = new Map(existing.steps.map((step) => [step.index, step]));
  for (const step of incoming.steps) steps.set(step.index, step);
  const logs = new Map(existing.logs.map((log) => [log.id, log]));
  for (const log of incoming.logs) logs.set(log.id, log);
  return {
    ...incoming,
    messages: [...messages.values()].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '')),
    steps: [...steps.values()].sort((a, b) => a.index - b.index),
    logs: [...logs.values()].sort((a, b) => (a.time || '').localeCompare(b.time || '')),
    outputCycles: mergeHistoryRecords(existing.outputCycles, incoming.outputCycles),
    subagents: mergeHistoryRecords(existing.subagents, incoming.subagents),
    history: existing.history || incoming.history,
  };
}

export function mergeBrowserChatHistoryChunkData<
  TMessage extends MessageLike,
  TStep extends StepLike,
  TLog extends LogLike,
  TSession extends HistorySession<TMessage, TStep, TLog>,
>(
  current: TSession,
  chunk: {
    history?: Partial<BrowserChatHistoryState>;
    logs?: TLog[];
    messages?: TMessage[];
    steps?: TStep[];
    outputCycles?: unknown[];
    subagents?: unknown[];
  },
): TSession {
  const messages = new Map(current.messages.map((message) => [messageKey(message), message]));
  for (const message of chunk.messages || []) messages.set(messageKey(message), message);
  const steps = new Map(current.steps.map((step) => [step.index, step]));
  for (const step of chunk.steps || []) steps.set(step.index, step);
  const logs = new Map(current.logs.map((log) => [log.id, log]));
  for (const log of chunk.logs || []) logs.set(log.id, log);
  const previousHistory = current.history || {
    messages: { hasMore: false },
    steps: { hasMore: false },
    logs: { hasMore: false },
  };
  return {
    ...current,
    messages: [...messages.values()].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '')),
    steps: [...steps.values()].sort((a, b) => a.index - b.index),
    logs: [...logs.values()].sort((a, b) => (a.time || '').localeCompare(b.time || '')),
    outputCycles: mergeHistoryRecords(current.outputCycles, chunk.outputCycles),
    subagents: mergeHistoryRecords(current.subagents, chunk.subagents),
    history: {
      messages: chunk.history?.messages || previousHistory.messages,
      steps: chunk.history?.steps || previousHistory.steps,
      logs: chunk.history?.logs || previousHistory.logs,
    },
  };
}
