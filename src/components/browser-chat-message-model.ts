export type BrowserChatLogRecordLike = {
  messageId?: string;
  stepIndex?: number;
};

export type BrowserChatMessageLike = {
  activity?: { phase?: string };
  content?: string;
  createdAt?: string;
  id: string;
  role: 'user' | 'assistant';
  status?: string;
  stepIndexes?: number[];
  updatedAt?: string;
};

export type BrowserChatLogIndex<TLog extends BrowserChatLogRecordLike> = {
  byMessageId: Map<string, TLog[]>;
  order: Map<TLog, number>;
};

export type BrowserChatAiOutputCycleLike = {
  id: string;
  output: {
    reasoning?: string[];
    texts: string[];
    tools?: unknown[];
  };
};

export function browserChatMessageIsTextStreaming(message: BrowserChatMessageLike) {
  return message.role === 'assistant'
    && message.status === 'running'
    && message.activity?.phase === 'ai:text:streaming';
}

export function normalizeBrowserChatMessageRunStates<TMessage extends BrowserChatMessageLike>(
  messages: TMessage[],
  input: { currentAssistantMessageId?: string; sessionBusy: boolean },
) {
  let changed = false;
  const normalized = messages.map((message) => {
    if (
      message.role !== 'assistant'
      || message.status !== 'running'
      || (input.sessionBusy && message.id === input.currentAssistantMessageId)
    ) return message;
    changed = true;
    return {
      ...message,
      activity: undefined,
      status: 'interrupted',
    } as TMessage;
  });
  return changed ? normalized : messages;
}

export type BrowserChatAiCycleRenderEntry<TCycle extends BrowserChatAiOutputCycleLike> =
  | { cycle: TCycle; kind: 'cycle' }
  | { cycles: TCycle[]; id: string; kind: 'executed' };

export type BrowserChatMessageRenderEntry<TMessage extends BrowserChatMessageLike> =
  | { item: TMessage; kind: 'message' }
  | { id: string; items: TMessage[]; kind: 'executed-group' };

function hasVisibleText(value: unknown) {
  return typeof value === 'string' && Boolean(value.trim());
}

function normalizedVisibleText(value: unknown) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

export function isBrowserChatManualVerificationStatusText(text: string) {
  const normalized = normalizedVisibleText(text);
  return /^AI requested a manual verification pause\. Ask the user to inspect the browser and continue after completing any required verification\.$/i.test(normalized)
    || /^Manual verification is visible \(.+\)\. The run UI should pause and wait for the user to complete it\.$/i.test(normalized)
    || /^已暂停自动操作(?:[：:,，；;]|\s)/.test(normalized)
    || /^已暂停(?:自动操作)?[，,]?\s*等待您检查浏览器/.test(normalized);
}

export function browserChatAiCycleAnchorsText(
  cycle: BrowserChatAiOutputCycleLike,
  text: string,
) {
  const normalizedText = normalizedVisibleText(text);
  if (!normalizedText || !cycle.output.tools?.length) return false;
  return cycle.output.texts.some((candidate) => normalizedVisibleText(candidate) === normalizedText);
}

export function browserChatAiCycleTextIsAccepted(
  messageStatus: string | undefined,
  cycle: BrowserChatAiOutputCycleLike,
  isTerminalAnswerCycle = false,
) {
  return messageStatus === undefined
    || (messageStatus !== 'running' && Boolean(cycle.output.tools?.length))
    || (messageStatus === 'passed' && isTerminalAnswerCycle);
}

export function browserChatTerminalAnswerCycleIndex(cycles: BrowserChatAiOutputCycleLike[]) {
  for (let index = cycles.length - 1; index >= 0; index -= 1) {
    const cycle = cycles[index];
    if (cycle.output.tools?.length) continue;
    if (cycle.output.texts.some(hasVisibleText)) return index;
  }
  return -1;
}

export function browserChatAssistantMessageHasExecutionMetadata(message: BrowserChatMessageLike) {
  return message.role === 'assistant' && Boolean(message.stepIndexes?.length);
}

export function browserChatMessageElapsedMs(
  message: Pick<BrowserChatMessageLike, 'createdAt' | 'updatedAt'>,
  liveNowMs?: number,
) {
  const startedAt = Date.parse(message.createdAt || '');
  const completedAt = Number.isFinite(liveNowMs)
    ? Number(liveNowMs)
    : Date.parse(message.updatedAt || message.createdAt || '');
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) return undefined;
  return Math.max(0, completedAt - startedAt);
}

export function formatBrowserChatElapsedTime(value: number | undefined) {
  if (!Number.isFinite(value)) return '';
  const totalSeconds = Math.max(0, Math.round(Number(value) / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [
    hours ? `${hours}h` : '',
    minutes ? `${minutes}m` : '',
    `${seconds}s`,
  ].filter(Boolean).join(' ');
}

export function buildBrowserChatLogIndex<TLog extends BrowserChatLogRecordLike>(logs: TLog[]): BrowserChatLogIndex<TLog> {
  const byMessageId = new Map<string, TLog[]>();
  const order = new Map<TLog, number>();

  for (const [index, log] of logs.entries()) {
    order.set(log, index);
    if (log.messageId) {
      const entries = byMessageId.get(log.messageId) || [];
      entries.push(log);
      byMessageId.set(log.messageId, entries);
    }
  }

  return { byMessageId, order };
}

export function browserChatLogsForMessage<TMessage extends BrowserChatMessageLike, TLog extends BrowserChatLogRecordLike>(
  message: TMessage,
  logIndex: BrowserChatLogIndex<TLog>,
) {
  const directLogs = logIndex.byMessageId.get(message.id) || [];
  return directLogs.length
    ? [...directLogs].sort((left, right) => (
      (logIndex.order.get(left) ?? Number.MAX_SAFE_INTEGER) - (logIndex.order.get(right) ?? Number.MAX_SAFE_INTEGER)
    ))
    : [];
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
  hasExecutedTool: (cycle: TCycle) => boolean = () => true,
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
    const hasVisibleOutput = cycle.output.texts.some(hasVisibleText)
      || (cycle.output.reasoning || []).some(hasVisibleText);
    if (!hasVisibleOutput && hasExecutedTool(cycle)) {
      pendingExecuted.push(cycle);
      continue;
    }
    if (!hasVisibleOutput) continue;
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
  assistantMessageHasExecutedTool: (message: TMessage) => boolean,
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

  for (const item of messages) {
    const itemLogs = item.role === 'assistant' ? browserChatLogsForMessage(item, logIndex) : [];
    const emptyAssistantMessage = item.role === 'assistant' && !assistantMessageHasVisibleText(item, itemLogs);
    if (emptyAssistantMessage) {
      if (item.status === 'running') {
        flushExecutedGroup();
        entries.push({ item, kind: 'message' });
        continue;
      }
      if (assistantMessageHasExecutedTool(item)) pendingExecutedGroup.push(item);
      continue;
    }
    flushExecutedGroup();
    entries.push({ item, kind: 'message' });
  }
  flushExecutedGroup();

  return entries;
}
