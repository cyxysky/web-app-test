export type BrowserChatLogRecordLike = {
  messageId?: string;
  stepIndex?: number;
};

export type BrowserChatMessageLike = {
  content?: string;
  id: string;
  role: 'user' | 'assistant';
  stepIndexes?: number[];
};

export type BrowserChatLogIndex<TLog extends BrowserChatLogRecordLike> = {
  byMessageId: Map<string, TLog[]>;
  byStepIndex: Map<number, TLog[]>;
};

export type BrowserChatAiOutputCycleLike = {
  id: string;
  output: {
    texts: string[];
  };
};

export type BrowserChatAiCycleRenderEntry<TCycle extends BrowserChatAiOutputCycleLike> =
  | { cycle: TCycle; kind: 'cycle' }
  | { cycles: TCycle[]; id: string; kind: 'executed' };

export type BrowserChatMessageRenderEntry<TMessage extends BrowserChatMessageLike> =
  | { item: TMessage; kind: 'message' }
  | { id: string; items: TMessage[]; kind: 'executed-group' };

function hasVisibleText(value: unknown) {
  return typeof value === 'string' && Boolean(value.trim());
}

export function assignBrowserChatStepIndexesToLatestMessage<TMessage extends BrowserChatMessageLike>(messages: TMessage[]) {
  const claimedStepIndexes = new Set<number>();
  const normalized = [...messages];
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const message = normalized[index];
    if (message.role !== 'assistant' || !message.stepIndexes?.length) continue;
    const stepIndexes = message.stepIndexes.filter((stepIndex) => {
      if (claimedStepIndexes.has(stepIndex)) return false;
      claimedStepIndexes.add(stepIndex);
      return true;
    });
    if (stepIndexes.length !== message.stepIndexes.length) {
      normalized[index] = { ...message, stepIndexes };
    }
  }
  return normalized;
}

export function buildBrowserChatLogIndex<TLog extends BrowserChatLogRecordLike>(logs: TLog[]): BrowserChatLogIndex<TLog> {
  const byMessageId = new Map<string, TLog[]>();
  const byStepIndex = new Map<number, TLog[]>();

  for (const log of logs) {
    if (log.messageId) {
      const entries = byMessageId.get(log.messageId) || [];
      entries.push(log);
      byMessageId.set(log.messageId, entries);
      continue;
    }
    if (typeof log.stepIndex === 'number') {
      const entries = byStepIndex.get(log.stepIndex) || [];
      entries.push(log);
      byStepIndex.set(log.stepIndex, entries);
    }
  }

  return { byMessageId, byStepIndex };
}

export function browserChatLogsForMessage<TMessage extends BrowserChatMessageLike, TLog extends BrowserChatLogRecordLike>(
  message: TMessage,
  logIndex: BrowserChatLogIndex<TLog>,
) {
  const directLogs = logIndex.byMessageId.get(message.id) || [];
  const stepLogs = (message.stepIndexes || []).flatMap((stepIndex) => logIndex.byStepIndex.get(stepIndex) || []);
  return directLogs.length || stepLogs.length ? [...directLogs, ...stepLogs] : [];
}

export function browserChatAssistantMessageHasVisibleText<TMessage extends BrowserChatMessageLike, TLog extends BrowserChatLogRecordLike>(
  message: TMessage,
  logs: TLog[],
  logTextResolver: (logs: TLog[]) => string[],
) {
  if (hasVisibleText(message.content)) return true;
  return logTextResolver(logs).some(hasVisibleText);
}

export function buildBrowserChatAiCycleRenderEntries<TCycle extends BrowserChatAiOutputCycleLike>(
  cycles: TCycle[],
): BrowserChatAiCycleRenderEntry<TCycle>[] {
  const entries: BrowserChatAiCycleRenderEntry<TCycle>[] = [];
  let pendingExecuted: TCycle[] = [];

  const flushExecuted = () => {
    if (!pendingExecuted.length) return;
    const first = pendingExecuted[0];
    const last = pendingExecuted[pendingExecuted.length - 1];
    entries.push({
      cycles: pendingExecuted,
      id: `executed-cycles-${first.id}-${last.id}-${pendingExecuted.length}`,
      kind: 'executed',
    });
    pendingExecuted = [];
  };

  for (const cycle of cycles) {
    if (!cycle.output.texts.some(hasVisibleText)) {
      pendingExecuted.push(cycle);
      continue;
    }
    flushExecuted();
    entries.push({ cycle, kind: 'cycle' });
  }
  flushExecuted();
  return entries;
}

export function buildBrowserChatMessageRenderEntries<TMessage extends BrowserChatMessageLike, TLog extends BrowserChatLogRecordLike>(
  messages: TMessage[],
  logIndex: BrowserChatLogIndex<TLog>,
  assistantMessageHasVisibleText: (message: TMessage, logs: TLog[]) => boolean,
): BrowserChatMessageRenderEntry<TMessage>[] {
  const entries: BrowserChatMessageRenderEntry<TMessage>[] = [];
  let pendingExecutedGroup: TMessage[] = [];

  const flushExecutedGroup = () => {
    if (!pendingExecutedGroup.length) return;
    if (pendingExecutedGroup.length > 1) {
      const first = pendingExecutedGroup[0];
      const last = pendingExecutedGroup[pendingExecutedGroup.length - 1];
      entries.push({
        id: `executed-${first.id}-${last.id}-${pendingExecutedGroup.length}`,
        items: pendingExecutedGroup,
        kind: 'executed-group',
      });
    } else {
      entries.push({ item: pendingExecutedGroup[0], kind: 'message' });
    }
    pendingExecutedGroup = [];
  };

  for (const item of assignBrowserChatStepIndexesToLatestMessage(messages)) {
    const itemLogs = item.role === 'assistant' ? browserChatLogsForMessage(item, logIndex) : [];
    const emptyAssistantMessage = item.role === 'assistant' && !assistantMessageHasVisibleText(item, itemLogs);
    if (emptyAssistantMessage) {
      pendingExecutedGroup.push(item);
      continue;
    }
    flushExecutedGroup();
    entries.push({ item, kind: 'message' });
  }
  flushExecutedGroup();

  return entries;
}
