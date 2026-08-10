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
  const removedMessageIds = new Set(patch.removedMessageIds || []);
  const messages = new Map(
    current.messages
      .filter((message) => !removedMessageIds.has(message.id))
      .map((message) => [messageKey(message), message]),
  );
  for (const message of patch.messages || []) {
    const key = messageKey(message);
    const existing = messages.get(key);
    const existingTime = existing?.updatedAt || existing?.createdAt || '';
    const incomingTime = message.updatedAt || message.createdAt || '';
    if (!existing || existing.id !== message.id || incomingTime >= existingTime) messages.set(key, message);
  }

  const removedStepIndexes = new Set(patch.removedStepIndexes || []);
  const steps = new Map(
    current.steps
      .filter((step) => !removedStepIndexes.has(step.index))
      .map((step) => [step.index, step]),
  );
  for (const step of patch.steps || []) {
    const existing = steps.get(step.index) as (TStep & { status?: string; tools?: unknown[] }) | undefined;
    const incoming = step as TStep & { status?: string; tools?: unknown[] };
    const wouldRegressCompletedStep = existing
      && existing.status !== 'running'
      && incoming.status === 'running';
    const wouldLoseToolDetails = existing
      && (existing.tools?.length || 0) > (incoming.tools?.length || 0);
    if (!wouldRegressCompletedStep && !wouldLoseToolDetails) steps.set(step.index, step);
  }

  const removedLogIds = new Set(patch.removedLogIds || []);
  const logs = new Map(
    current.logs
      .filter((log) => !removedLogIds.has(log.id))
      .map((log) => [log.id, log]),
  );
  for (const log of patch.logs || []) logs.set(log.id, log);

  return {
    logs: [...logs.values()].sort((a, b) => (a.time || '').localeCompare(b.time || '')),
    messages: [...messages.values()].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '')),
    steps: [...steps.values()].sort((a, b) => a.index - b.index),
  };
}
