import { normalizeApplicationUserId } from '@/server/auth/user-context';
import type { StepExecutionResult } from '@/server/ai/schemas/runtime.schema';
import {
  compactBrowserChatLogsForClient,
} from '@/server/ai/agents/browser-chat-log-client';
import {
  recoverOrphanedBrowserChatSession,
  type BrowserChatLogRecord,
  type BrowserChatMessage,
  type BrowserChatSessionSnapshot,
} from '@/server/ai/agents/browser-chat.service';
// Session list/detail reads use database projections rather than the in-memory
// service list, so reconcile persisted `running` flags with the live registry.
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
import { executeBrowserCodeRuntimeStateOperation } from '@/server/storage/browser-code-runtime-state';
import { readBrowserChatDefectReports } from '@/server/storage/browser-chat-defect-store';
import { readBrowserChatSessionSummaries } from '@/server/storage/database-record-store';

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
  const effectiveMaxTokens = runtimeContextWindowTokens({
    provider: session.modelProvider,
    model: session.model,
  });
  const activeMessages = session.modelContext?.activeMessages || [];
  const source = activeMessages.length
    ? activeMessages
    : messages.map((message) => ({
        role: message.role,
        content: message.content,
        attachments: (message.attachments || []).map((attachment) => ({
          name: attachment.name,
          type: attachment.kind === 'image' || attachment.type.startsWith('image/') ? 'image' : attachment.type,
        })),
      }));
  const estimated = estimateRuntimeMessageContext(source);
  if (!activeMessages.length && stored && stored.currentTokens > 0) {
    return { ...stored, maxTokens: effectiveMaxTokens };
  }
  const toolTokens = stored?.toolTokens || 0;
  return {
    currentTokens: estimated.totalTokens + toolTokens,
    imageTokens: estimated.imageTokens,
    maxTokens: effectiveMaxTokens,
    textTokens: estimated.textTokens,
    toolTokens,
  };
}

export async function listBrowserChatSessionSummaries(
  userId?: string | number,
  input: { beforeId?: string; beforeUpdatedAt?: string; limit?: number } = {},
) {
  return (await readBrowserChatSessionSummaries<BrowserChatPersistedHeader>({
    ...input,
    hasMessagesOnly: true,
    userId: normalizeApplicationUserId(userId),
  }))
    .filter((session) => session?.id && belongsToUser(session, userId))
    .map(recoverOrphanedBrowserChatSession)
    .map(compactSessionSummary);
}

export async function readBrowserChatSessionPage(sessionId: string, userId?: string | number) {
  const storedSession = await readBrowserChatSessionHeader<BrowserChatPersistedHeader>(sessionId);
  const persistedSession = storedSession
    ? recoverOrphanedBrowserChatSession(storedSession) as BrowserChatPersistedHeader
    : undefined;
  if (!persistedSession || !belongsToUser(persistedSession, userId)) return undefined;
  const { modelContext: _modelContext, ...session } = persistedSession;
  void _modelContext;
  let messages = await readBrowserChatMessagesPage<BrowserChatMessage>(sessionId, {
    limit: BROWSER_CHAT_MESSAGE_PAGE_SIZE,
  });
  const pendingMessage = session.pendingToolConfirmation?.messageId
    ? await readBrowserChatMessageById<BrowserChatMessage>(sessionId, session.pendingToolConfirmation.messageId)
    : undefined;
  const persistedActiveMessage = session.busy || session.status === 'running'
    ? pendingMessage?.role === 'assistant'
      ? pendingMessage
      : await readBrowserChatLatestActiveAssistantMessage<BrowserChatMessage>(sessionId)
    : undefined;
  const activeMessage = persistedActiveMessage
    || activeBrowserChatAssistantMessage({ ...session, messages: messages.items });
  if (activeMessage && !messages.items.some((message) => message.id === activeMessage.id)) {
    const latestMessages = await readBrowserChatMessagesPage<BrowserChatMessage>(sessionId, {
      limit: BROWSER_CHAT_MESSAGE_PAGE_SIZE - 1,
    });
    messages = {
      ...latestMessages,
      items: [activeMessage, ...latestMessages.items]
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    };
  }
  const activeSteps = activeMessage
    ? (await readBrowserChatStepsByIndexes<StepExecutionResult>(sessionId, activeMessage.stepIndexes || []))
        .filter((step) => !step.messageId || step.messageId === activeMessage.id)
    : [];
  const activeLogs = activeMessage
    ? (await readBrowserChatLogsPage<BrowserChatLogRecord>(sessionId, { limit: 500, messageId: activeMessage.id })).items
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

export async function readBrowserChatRuntimeState(sessionId: string, userId?: string | number) {
  const session = await readBrowserChatSessionOwner(sessionId);
  if (!session || !belongsToUser(session, userId)) return undefined;
  const runtimeState = await executeBrowserCodeRuntimeStateOperation(sessionId, {
    action: 'list',
    input: {},
  });
  return {
    ...runtimeState,
    defects: await readBrowserChatDefectReports(sessionId),
  };
}

export async function readBrowserChatSessionHistoryPage(
  sessionId: string,
  userId: string | number | undefined,
  input: {
    messageCursor?: string;
    messageLimit?: number;
  },
) {
  const session = await readBrowserChatSessionOwner(sessionId);
  if (!session || !belongsToUser(session, userId)) return undefined;
  const messages = input.messageCursor
      ? await readBrowserChatMessagesPage<BrowserChatMessage>(sessionId, {
        cursor: input.messageCursor,
        limit: Math.min(
          BROWSER_CHAT_MESSAGE_PAGE_SIZE,
          browserChatHistoryLimit(input.messageLimit, BROWSER_CHAT_MESSAGE_PAGE_SIZE),
        ),
      })
    : undefined;
  return {
    ...(messages ? { messages: messages.items } : {}),
    history: {
      ...(messages ? {
        messages: { cursor: messages.cursor, hasMore: messages.hasMore },
      } : {}),
    },
  };
}

export async function readBrowserChatSessionLogs(
  sessionId: string,
  userId?: string | number,
  input: { cursor?: string; limit?: number; messageId?: string; subagentsOnly?: boolean } = {},
) {
  const session = await readBrowserChatSessionHeader<BrowserChatSessionSnapshot>(sessionId);
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
  const page = await readBrowserChatLogsPage<BrowserChatLogRecord>(sessionId, { ...input, messageId });
  const message = messageId && !input.cursor
    ? await readBrowserChatMessageById<BrowserChatMessage>(sessionId, messageId)
    : undefined;
  const steps = message
    ? (await readBrowserChatStepsByIndexes<StepExecutionResult>(sessionId, message.stepIndexes || []))
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
