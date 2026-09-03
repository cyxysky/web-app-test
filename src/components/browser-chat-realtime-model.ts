export type BrowserChatRealtimeCollectionPatch<
  TMessage extends { clientMessageId?: string; id: string; role?: string; createdAt?: string; updatedAt?: string },
  TStep extends { index: number },
  TLog extends { id: string; time?: string },
> = {
  logs?: TLog[];
  messages?: TMessage[];
  removedLogIds?: string[];
  removedMessageIds?: string[];
  removedStepIndexes?: number[];
  steps?: TStep[];
};

export function parseBrowserChatRealtimePatch<T extends { session?: { id?: unknown } }>(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const patch = value as T;
  if (!patch.session || typeof patch.session.id !== 'string' || !patch.session.id) return undefined;
  return patch;
}

export function mergeBrowserChatRealtimeRecords<T extends { id: string }>(
  current: T[] | undefined,
  incoming: Array<Partial<T> & Pick<T, 'id'>> | undefined,
) {
  let records = current || [];
  for (const record of incoming || []) {
    const index = records.findIndex((item) => item.id === record.id);
    if (index < 0) {
      records = [...records, record as T];
      continue;
    }
    const next = [...records];
    next[index] = { ...records[index], ...record };
    records = next;
  }
  return records;
}

function removeRealtimeRecords<T>(
  current: T[],
  removedValues: readonly (string | number)[] | undefined,
  valueOf: (record: T) => string | number,
) {
  if (!removedValues?.length) return current;
  const removed = new Set(removedValues);
  const next = current.filter((record) => !removed.has(valueOf(record)));
  return next.length === current.length ? current : next;
}

function insertRealtimeRecord<T>(
  current: T[],
  record: T,
  comesAfter: (candidate: T) => boolean,
) {
  const index = current.findIndex(comesAfter);
  return index < 0
    ? [...current, record]
    : [...current.slice(0, index), record, ...current.slice(index)];
}

function mergeRealtimeStepTools(current: unknown[] = [], incoming: unknown[] = []) {
  const currentById = new Map<string, Record<string, unknown>>();
  for (const tool of current) {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) continue;
    const id = (tool as Record<string, unknown>).id;
    if (typeof id === 'string' && id) currentById.set(id, tool as Record<string, unknown>);
  }
  const merged = incoming.map((tool, index) => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return tool;
    const record = tool as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : '';
    const previous = (id ? currentById.get(id) : undefined)
      || (current[index] && typeof current[index] === 'object' && !Array.isArray(current[index])
        ? current[index] as Record<string, unknown>
        : undefined);
    if (!previous) return tool;
    const next = { ...previous, ...record };
    // Realtime events may arrive out of order. Once a tool is terminal, a stale
    // "started" snapshot must never erase its result and make it look active again.
    if (previous.ok !== undefined && record.ok === undefined) next.ok = previous.ok;
    for (const key of ['elapsedMs', 'error', 'rawResult', 'result'] as const) {
      if (previous[key] !== undefined && record[key] === undefined) next[key] = previous[key];
    }
    return next;
  });
  if (current.length > incoming.length) merged.push(...current.slice(incoming.length));
  return merged;
}

export function mergeBrowserChatRealtimeCollections<
  TMessage extends { clientMessageId?: string; id: string; role?: string; createdAt?: string; updatedAt?: string },
  TStep extends { index: number },
  TLog extends { id: string; time?: string },
>(
  current: { logs: TLog[]; messages: TMessage[]; steps: TStep[] },
  patch: BrowserChatRealtimeCollectionPatch<TMessage, TStep, TLog>,
) {
  const messageKey = (message: TMessage) => message.clientMessageId && message.role
    ? `client:${message.clientMessageId}:${message.role}`
    : `id:${message.id}`;
  let messages = removeRealtimeRecords(current.messages, patch.removedMessageIds, (message) => message.id);
  for (const message of patch.messages || []) {
    const key = messageKey(message);
    const index = messages.findIndex((item) => messageKey(item) === key);
    const existing = index >= 0 ? messages[index] : undefined;
    const existingTime = existing?.updatedAt || existing?.createdAt || '';
    const incomingTime = message.updatedAt || message.createdAt || '';
    if (existing && existing.id === message.id && incomingTime < existingTime) continue;
    if (index >= 0) {
      const next = [...messages];
      next[index] = message;
      messages = next;
      continue;
    }
    const createdAt = message.createdAt || '';
    messages = insertRealtimeRecord(messages, message, (candidate) => (candidate.createdAt || '') > createdAt);
  }

  let steps = removeRealtimeRecords(current.steps, patch.removedStepIndexes, (step) => step.index);
  for (const step of patch.steps || []) {
    const index = steps.findIndex((item) => item.index === step.index);
    const existing = (index >= 0 ? steps[index] : undefined) as (TStep & { status?: string; tools?: unknown[] }) | undefined;
    const incoming = step as TStep & { status?: string; tools?: unknown[] };
    const wouldRegressCompletedStep = existing
      && existing.status !== 'running'
      && incoming.status === 'running';
    if (wouldRegressCompletedStep) continue;
    if (!existing) {
      steps = insertRealtimeRecord(steps, step, (candidate) => candidate.index > step.index);
      continue;
    }
    const mergedStep = {
      ...existing,
      ...incoming,
    } as TStep & { tools?: unknown[] };
    if (existing.tools || incoming.tools) {
      mergedStep.tools = mergeRealtimeStepTools(existing.tools, incoming.tools);
    }
    const next = [...steps];
    next[index] = mergedStep as TStep;
    steps = next;
  }

  let logs = removeRealtimeRecords(current.logs, patch.removedLogIds, (log) => log.id);
  for (const log of patch.logs || []) {
    const index = logs.findIndex((item) => item.id === log.id);
    if (index >= 0) {
      const next = [...logs];
      next[index] = log;
      logs = next;
      continue;
    }
    const time = log.time || '';
    logs = insertRealtimeRecord(logs, log, (candidate) => (candidate.time || '') > time);
  }

  return { logs, messages, steps };
}
