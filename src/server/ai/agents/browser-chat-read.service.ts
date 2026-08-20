import { normalizeApplicationUserId } from '@/server/auth/user-context';
import type { StepExecutionResult } from '@/server/ai/schemas/runtime.schema';
import {
  compactBrowserChatLogsForClient,
} from '@/server/ai/agents/browser-chat-log-client';
import type {
  BrowserChatLogRecord,
  BrowserChatMessage,
  BrowserChatSessionSnapshot,
} from '@/server/ai/agents/browser-chat.service';
import type { BrowserChatModelContext } from '@/server/ai/agents/browser-chat-model-context';
import {
  estimateRuntimeMessageContext,
  runtimeContextWindowTokens,
} from '@/server/ai/agents/runtime-context-budget';
import {
  activeBrowserChatAssistantMessage,
  browserChatClientRecordsForMessage,
} from '@/server/ai/agents/browser-chat-client-window';
import {
  BROWSER_CHAT_MESSAGE_PAGE_SIZE,
  browserChatHistoryLimit,
  readBrowserChatLatestActiveAssistantMessage,
  readBrowserChatLogsPage,
  readBrowserChatMessageById,
  readBrowserChatMessagesPage,
  readBrowserChatSessionHeader,
  readBrowserChatSessionOwner,
  readBrowserChatStepsByIndexes,
} from '@/server/storage/browser-chat-history-store';
import { readBrowserChatSessionSummaries } from '@/server/storage/sqlite-record-store';
import {
  browserChatArtifactsFromSteps,
  mergeBrowserChatArtifactSummaries,
} from '@/lib/browser-chat-artifacts';

function belongsToUser(session: Pick<BrowserChatSessionSnapshot, 'userId'>, userId?: string | number) {
  return normalizeApplicationUserId(session.userId) === normalizeApplicationUserId(userId);
}

function compactStepForClient(step: StepExecutionResult): StepExecutionResult {
  const compacted = { ...step };
  delete compacted.aiRequest;
  delete compacted.visualContext;
  return compacted;
}

type BrowserChatPersistedHeader = BrowserChatSessionSnapshot & {
  modelContext?: BrowserChatModelContext;
};

function compactSessionSummary(session: BrowserChatPersistedHeader): BrowserChatSessionSnapshot {
  const { modelContext: _modelContext, ...summary } = session;
  void _modelContext;
  return {
    ...summary,
    contextUsage: undefined,
    error: undefined,
    hasMessages: true,
    logs: [],
    messages: [],
    networkErrors: [],
    outputCycles: [],
    pendingToolConfirmation: undefined,
    queuedTurns: [],
    steps: [],
    subagents: [],
    targetUrl: '',
    consoleErrors: [],
  };
}

function resolvedContextUsage(
  session: BrowserChatPersistedHeader,
  messages: BrowserChatMessage[],
) {
  const stored = session.contextUsage;
  if (stored && stored.currentTokens > 0) return stored;
  const source = session.modelContext?.activeMessages?.length
    ? session.modelContext.activeMessages
    : messages.map((message) => ({
        role: message.role,
        content: message.content,
        attachments: (message.attachments || []).map((attachment) => ({
          name: attachment.name,
          type: attachment.kind === 'image' || attachment.type.startsWith('image/') ? 'image' : attachment.type,
        })),
      }));
  const estimated = estimateRuntimeMessageContext(source);
  return {
    currentTokens: estimated.totalTokens,
    imageTokens: estimated.imageTokens,
    maxTokens: stored?.maxTokens || runtimeContextWindowTokens(),
    textTokens: estimated.textTokens,
    toolTokens: stored?.toolTokens || 0,
  };
}

function withBrowserChatMessageArtifacts(sessionId: string, messages: BrowserChatMessage[]) {
  const messagesWithoutArtifactIndex = messages.filter((message) => (
    message.role === 'assistant' && message.artifacts === undefined
  ));
  const stepIndexes = Array.from(new Set(
    messagesWithoutArtifactIndex.flatMap((message) => message.stepIndexes || []),
  ));
  if (!stepIndexes.length) return messages;
  const steps = readBrowserChatStepsByIndexes<StepExecutionResult>(sessionId, stepIndexes);
  return messages.map((message) => {
    if (message.role !== 'assistant' || message.artifacts !== undefined) return message;
    const ownedIndexes = new Set(message.stepIndexes || []);
    const artifacts = mergeBrowserChatArtifactSummaries(
      message.artifacts,
      browserChatArtifactsFromSteps(steps.filter((step) => (
        step.messageId === message.id || ownedIndexes.has(step.index)
      ))),
    );
    return { ...message, artifacts };
  });
}

export function listBrowserChatSessionSummaries(
  userId?: string | number,
  input: { beforeId?: string; beforeUpdatedAt?: string; limit?: number } = {},
) {
  return readBrowserChatSessionSummaries<BrowserChatPersistedHeader>({
    ...input,
    hasMessagesOnly: true,
    userId: normalizeApplicationUserId(userId),
  })
    .filter((session) => session?.id && belongsToUser(session, userId))
    .map(compactSessionSummary);
}

export function readBrowserChatSessionPage(sessionId: string, userId?: string | number) {
  const persistedSession = readBrowserChatSessionHeader<BrowserChatPersistedHeader>(sessionId);
  if (!persistedSession || !belongsToUser(persistedSession, userId)) return undefined;
  const { modelContext: _modelContext, ...session } = persistedSession;
  void _modelContext;
  let messages = readBrowserChatMessagesPage<BrowserChatMessage>(sessionId, {
    limit: BROWSER_CHAT_MESSAGE_PAGE_SIZE,
  });
  const pendingMessage = session.pendingToolConfirmation?.messageId
    ? readBrowserChatMessageById<BrowserChatMessage>(sessionId, session.pendingToolConfirmation.messageId)
    : undefined;
  const persistedActiveMessage = session.busy || session.status === 'running'
    ? pendingMessage?.role === 'assistant'
      ? pendingMessage
      : readBrowserChatLatestActiveAssistantMessage<BrowserChatMessage>(sessionId)
    : undefined;
  const activeMessage = persistedActiveMessage
    || activeBrowserChatAssistantMessage({ ...session, messages: messages.items });
  if (activeMessage && !messages.items.some((message) => message.id === activeMessage.id)) {
    const latestMessages = readBrowserChatMessagesPage<BrowserChatMessage>(sessionId, {
      limit: BROWSER_CHAT_MESSAGE_PAGE_SIZE - 1,
    });
    messages = {
      ...latestMessages,
      items: [activeMessage, ...latestMessages.items]
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    };
  }
  messages = { ...messages, items: withBrowserChatMessageArtifacts(sessionId, messages.items) };
  const activeSteps = activeMessage
    ? readBrowserChatStepsByIndexes<StepExecutionResult>(sessionId, activeMessage.stepIndexes || [])
        .filter((step) => !step.messageId || step.messageId === activeMessage.id)
    : [];
  const activeLogs = activeMessage
    ? readBrowserChatLogsPage<BrowserChatLogRecord>(sessionId, { limit: 500, messageId: activeMessage.id }).items
    : [];
  const activeRecords = activeMessage
    ? browserChatClientRecordsForMessage(
        { ...session, messages: [activeMessage] },
        activeMessage.id,
        { includeSubagents: true },
      )
    : { outputCycles: [], subagents: [] };
  return {
    ...session,
    contextUsage: resolvedContextUsage(persistedSession, messages.items),
    hasMessages: messages.items.length > 0 || session.hasMessages === true,
    messages: messages.items,
    steps: activeSteps.map(compactStepForClient),
    logs: compactBrowserChatLogsForClient(activeLogs),
    outputCycles: activeRecords.outputCycles,
    subagents: activeRecords.subagents,
    history: {
      messages: { cursor: messages.cursor, hasMore: messages.hasMore },
      steps: { hasMore: false },
      logs: { hasMore: false },
    },
  };
}

export function readBrowserChatSessionHistoryPage(
  sessionId: string,
  userId: string | number | undefined,
  input: {
    messageCursor?: string;
    messageLimit?: number;
  },
) {
  const session = readBrowserChatSessionOwner(sessionId);
  if (!session || !belongsToUser(session, userId)) return undefined;
  const messages = input.messageCursor
      ? readBrowserChatMessagesPage<BrowserChatMessage>(sessionId, {
        cursor: input.messageCursor,
        limit: Math.min(
          BROWSER_CHAT_MESSAGE_PAGE_SIZE,
          browserChatHistoryLimit(input.messageLimit, BROWSER_CHAT_MESSAGE_PAGE_SIZE),
        ),
      })
    : undefined;
  const enrichedMessages = messages
    ? { ...messages, items: withBrowserChatMessageArtifacts(sessionId, messages.items) }
    : undefined;
  return {
    ...(enrichedMessages ? { messages: enrichedMessages.items } : {}),
    history: {
      ...(enrichedMessages ? {
        messages: { cursor: enrichedMessages.cursor, hasMore: enrichedMessages.hasMore },
      } : {}),
    },
  };
}

export function readBrowserChatSessionLogs(
  sessionId: string,
  userId?: string | number,
  input: { cursor?: string; limit?: number; messageId?: string; subagentsOnly?: boolean } = {},
) {
  const session = readBrowserChatSessionHeader<BrowserChatSessionSnapshot>(sessionId);
  if (!session || !belongsToUser(session, userId)) return undefined;
  if (input.subagentsOnly) {
    return {
      logs: [],
      subagents: input.messageId
        ? (session.subagents || []).filter((subagent) => subagent.messageId === input.messageId)
        : [],
      history: { hasMore: false },
    };
  }
  const messageId = input.messageId?.trim();
  const page = readBrowserChatLogsPage<BrowserChatLogRecord>(sessionId, { ...input, messageId });
  const message = messageId && !input.cursor
    ? readBrowserChatMessageById<BrowserChatMessage>(sessionId, messageId)
    : undefined;
  const steps = message
    ? readBrowserChatStepsByIndexes<StepExecutionResult>(sessionId, message.stepIndexes || [])
        .filter((step) => !step.messageId || step.messageId === messageId)
    : [];
  const records = messageId && !input.cursor
    ? browserChatClientRecordsForMessage(
        { ...session, messages: message ? [message] : [] },
        messageId,
      )
    : { outputCycles: [], subagents: [] };
  return {
    logs: compactBrowserChatLogsForClient(page.items),
    ...(messageId && !input.cursor ? {
      outputCycles: records.outputCycles,
      subagents: records.subagents,
      steps: steps.map(compactStepForClient),
    } : {}),
    history: { cursor: page.cursor, hasMore: page.hasMore },
  };
}
