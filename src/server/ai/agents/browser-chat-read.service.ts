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
import {
  browserChatHistoryLimit,
  readBrowserChatLogsPage,
  readBrowserChatMessagesPage,
  readBrowserChatSessionHeader,
  readBrowserChatSessionWindow,
  readBrowserChatStepsPage,
} from '@/server/storage/browser-chat-history-store';
import { readBrowserChatSessionSummaries } from '@/server/storage/sqlite-record-store';

function belongsToUser(session: Pick<BrowserChatSessionSnapshot, 'userId'>, userId?: string | number) {
  return normalizeApplicationUserId(session.userId) === normalizeApplicationUserId(userId);
}

function compactStepForClient(step: StepExecutionResult): StepExecutionResult {
  const compacted = { ...step };
  delete compacted.aiRequest;
  delete compacted.visualContext;
  delete compacted.workingMemory;
  return compacted;
}

export function listBrowserChatSessionSummaries(
  userId?: string | number,
  input: { beforeId?: string; beforeUpdatedAt?: string; limit?: number } = {},
) {
  return readBrowserChatSessionSummaries<BrowserChatSessionSnapshot>({
    ...input,
    hasMessagesOnly: true,
    userId: normalizeApplicationUserId(userId),
  }).filter((session) => session?.id && belongsToUser(session, userId));
}

export function readBrowserChatSessionPage(sessionId: string, userId?: string | number) {
  const persisted = readBrowserChatSessionWindow<
    BrowserChatSessionSnapshot,
    BrowserChatMessage,
    StepExecutionResult,
    BrowserChatLogRecord
  >(sessionId);
  if (!persisted || !belongsToUser(persisted, userId)) return undefined;
  return {
    ...persisted,
    steps: persisted.steps.map(compactStepForClient),
    logs: compactBrowserChatLogsForClient(persisted.logs),
  };
}

export function readBrowserChatSessionHistoryPage(
  sessionId: string,
  userId: string | number | undefined,
  input: {
    logCursor?: string;
    logLimit?: number;
    messageCursor?: string;
    messageLimit?: number;
    stepCursor?: string;
    stepLimit?: number;
  },
) {
  const session = readBrowserChatSessionHeader<BrowserChatSessionSnapshot>(sessionId);
  if (!session || !belongsToUser(session, userId)) return undefined;
  const messages = input.messageCursor
    ? readBrowserChatMessagesPage<BrowserChatMessage>(sessionId, {
        cursor: input.messageCursor,
        limit: browserChatHistoryLimit(input.messageLimit, 80),
      })
    : undefined;
  const steps = input.stepCursor
    ? readBrowserChatStepsPage<StepExecutionResult>(sessionId, {
        cursor: input.stepCursor,
        limit: browserChatHistoryLimit(input.stepLimit, 120),
      })
    : undefined;
  const logs = input.logCursor
    ? readBrowserChatLogsPage<BrowserChatLogRecord>(sessionId, {
        cursor: input.logCursor,
        limit: browserChatHistoryLimit(input.logLimit, 200),
      })
    : undefined;
  return {
    outputCycles: session.outputCycles || [],
    subagents: session.subagents || [],
    ...(messages ? { messages: messages.items } : {}),
    ...(steps ? { steps: steps.items.map(compactStepForClient) } : {}),
    ...(logs ? { logs: compactBrowserChatLogsForClient(logs.items) } : {}),
    history: {
      ...(messages ? { messages: { cursor: messages.cursor, hasMore: messages.hasMore } } : {}),
      ...(steps ? { steps: { cursor: steps.cursor, hasMore: steps.hasMore } } : {}),
      ...(logs ? { logs: { cursor: logs.cursor, hasMore: logs.hasMore } } : {}),
    },
  };
}

export function readBrowserChatSessionLogs(
  sessionId: string,
  userId?: string | number,
  input: { cursor?: string; limit?: number; messageId?: string } = {},
) {
  const session = readBrowserChatSessionHeader<BrowserChatSessionSnapshot>(sessionId);
  if (!session || !belongsToUser(session, userId)) return undefined;
  const page = readBrowserChatLogsPage<BrowserChatLogRecord>(sessionId, input);
  return {
    logs: page.items,
    history: { cursor: page.cursor, hasMore: page.hasMore },
  };
}
