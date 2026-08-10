export type BrowserChatPersistenceCursor<
  TMessage extends { id: string },
  TStep extends { index: number },
  TLog extends { id: string },
> = {
  logs: Map<string, TLog>;
  messages: Map<string, TMessage>;
  steps: Map<number, TStep>;
};

export type BrowserChatDirtyRecords<
  TMessage extends { id: string },
  TStep extends { index: number },
  TLog extends { id: string },
> = BrowserChatPersistenceCursor<TMessage, TStep, TLog> & {
  removedLogIds: Set<string>;
  removedMessageIds: Set<string>;
  removedStepIndexes: Set<number>;
};

export type BrowserChatPersistenceDelta<TMessage, TStep, TLog> = {
  logs: TLog[];
  messages: TMessage[];
  removedLogIds: string[];
  removedMessageIds: string[];
  removedStepIndexes: number[];
  steps: TStep[];
};

type PersistenceItem<
  TMessage extends { id: string },
  TStep extends { index: number },
  TLog extends { id: string },
> = {
  id: string;
  logs: TLog[];
  messages: TMessage[];
  steps: TStep[];
};

export function collectBrowserChatPersistenceDelta<
  TMessage extends { id: string },
  TStep extends { index: number },
  TLog extends { id: string },
>(
  item: PersistenceItem<TMessage, TStep, TLog>,
  previous?: BrowserChatPersistenceCursor<TMessage, TStep, TLog>,
  dirty?: BrowserChatDirtyRecords<TMessage, TStep, TLog>,
): BrowserChatPersistenceDelta<TMessage, TStep, TLog> {
  if (dirty) {
    return {
      messages: [...dirty.messages.values()],
      steps: [...dirty.steps.values()],
      logs: [...dirty.logs.values()],
      removedMessageIds: [...dirty.removedMessageIds],
      removedStepIndexes: [...dirty.removedStepIndexes],
      removedLogIds: [...dirty.removedLogIds],
    };
  }
  const messageIds = new Set(item.messages.map((message) => message.id));
  const stepIndexes = new Set(item.steps.map((step) => step.index));
  const logIds = new Set(item.logs.map((log) => log.id));
  return {
    messages: item.messages.filter((message) => previous?.messages.get(message.id) !== message),
    steps: item.steps.filter((step) => previous?.steps.get(step.index) !== step),
    logs: item.logs.filter((log) => previous?.logs.get(log.id) !== log),
    removedMessageIds: previous ? [...previous.messages.keys()].filter((id) => !messageIds.has(id)) : [],
    removedStepIndexes: previous ? [...previous.steps.keys()].filter((index) => !stepIndexes.has(index)) : [],
    removedLogIds: previous ? [...previous.logs.keys()].filter((id) => !logIds.has(id)) : [],
  };
}

export function applyBrowserChatPersistenceDelta<
  TMessage extends { id: string },
  TStep extends { index: number },
  TLog extends { id: string },
>(
  cursor: BrowserChatPersistenceCursor<TMessage, TStep, TLog>,
  delta: BrowserChatPersistenceDelta<TMessage, TStep, TLog>,
) {
  for (const message of delta.messages) cursor.messages.set(message.id, message);
  for (const step of delta.steps) cursor.steps.set(step.index, step);
  for (const log of delta.logs) cursor.logs.set(log.id, log);
  for (const id of delta.removedMessageIds) cursor.messages.delete(id);
  for (const index of delta.removedStepIndexes) cursor.steps.delete(index);
  for (const id of delta.removedLogIds) cursor.logs.delete(id);
  return cursor;
}

export function seedBrowserChatPersistenceCursor<
  TMessage extends { id: string },
  TStep extends { index: number },
  TLog extends { id: string },
>(
  item: PersistenceItem<TMessage, TStep, TLog>,
  persisted: Pick<PersistenceItem<TMessage, TStep, TLog>, 'logs' | 'messages' | 'steps'> = item,
): BrowserChatPersistenceCursor<TMessage, TStep, TLog> {
  const messages = new Map(persisted.messages.map((message) => [message.id, message]));
  for (const message of item.messages) messages.set(message.id, message);
  const steps = new Map(persisted.steps.map((step) => [step.index, step]));
  for (const step of item.steps) steps.set(step.index, step);
  const logs = new Map(persisted.logs.map((log) => [log.id, log]));
  for (const log of item.logs) logs.set(log.id, log);
  return { logs, messages, steps };
}
