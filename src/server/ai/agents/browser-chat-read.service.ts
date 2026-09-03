import { normalizeApplicationUserId } from '@/server/auth/user-context';
import type { StepExecutionResult, StepToolCall } from '@/server/ai/schemas/runtime.schema';
import {
  compactBrowserChatLogsForClient,
} from '@/server/ai/agents/browser-chat-log-client';
import type {
  BrowserChatLogRecord,
  BrowserChatMessage,
  BrowserChatSessionSnapshot,
} from '@/server/ai/agents/browser-chat.service';
import { recoverOrphanedBrowserChatSession } from '@/server/ai/agents/browser-chat-session-recovery';
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

function browserChatLogDetails(value?: string) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function browserChatRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function browserChatRecoveredToolSteps(
  messageId: string,
  logs: readonly BrowserChatLogRecord[],
) {
  const steps = new Map<number, { order: string[]; tools: Map<string, StepToolCall> }>();
  for (const log of logs) {
    if (log.phase !== 'ai:tool' || typeof log.stepIndex !== 'number') continue;
    const details = browserChatLogDetails(log.details);
    const nested = browserChatRecord(details?.value);
    const trace = browserChatRecord(details?.trace) || browserChatRecord(nested?.trace);
    const name = typeof trace?.name === 'string' ? trace.name.trim() : '';
    if (!trace || !name) continue;
    const id = typeof trace.id === 'string' && trace.id.trim() ? trace.id.trim() : `${name}:${log.id}`;
    const group = steps.get(log.stepIndex) || { order: [], tools: new Map<string, StepToolCall>() };
    const result = browserChatRecord(trace.result);
    const actual = typeof result?.actual === 'string'
      ? result.actual
      : typeof result?.error === 'string'
        ? result.error
        : undefined;
    const input = trace.input;
    const inputRecord = browserChatRecord(input);
    const previous = group.tools.get(id);
    if (!previous) group.order.push(id);
    group.tools.set(id, {
      ...previous,
      id,
      name,
      ...(input !== undefined ? { input } : {}),
      ...(typeof inputRecord?.reason === 'string' && inputRecord.reason.trim()
        ? { reason: inputRecord.reason.trim() }
        : {}),
      ...(typeof result?.ok === 'boolean' ? { ok: result.ok } : {}),
      ...(actual ? { result: actual } : {}),
      ...(result ? { rawResult: result } : {}),
      ...(typeof trace.elapsedMs === 'number' ? { elapsedMs: trace.elapsedMs } : {}),
      ...(typeof trace.aiRequestElapsedMs === 'number' ? { aiRequestElapsedMs: trace.aiRequestElapsedMs } : {}),
      ...(browserChatRecord(trace.contextBefore) ? { contextBefore: trace.contextBefore as StepToolCall['contextBefore'] } : {}),
      ...(browserChatRecord(trace.contextAfter) ? { contextAfter: trace.contextAfter as StepToolCall['contextAfter'] } : {}),
      ...(Array.isArray(trace.screenshots) ? { screenshots: trace.screenshots as StepToolCall['screenshots'] } : {}),
    });
    steps.set(log.stepIndex, group);
  }
  return [...steps.entries()].map(([index, group]): StepExecutionResult => {
    const tools = group.order.flatMap((id) => {
      const tool = group.tools.get(id);
      return tool ? [tool] : [];
    });
    return {
      index,
      messageId,
      action: 'Recovered tool execution',
      expected: 'Persisted tool calls should remain visible after reopening the conversation.',
      actual: `Recovered ${tools.length} tool call${tools.length === 1 ? '' : 's'} from the persisted execution log.`,
      status: tools.some((tool) => tool.ok === false) ? 'failed' : 'passed',
      tools,
    };
  }).filter((step) => Boolean(step.tools?.length));
}

function mergeBrowserChatRecoveredToolSteps(
  persistedSteps: readonly StepExecutionResult[],
  recoveredSteps: readonly StepExecutionResult[],
) {
  const merged = new Map(persistedSteps.map((step) => [step.index, step]));
  for (const recovered of recoveredSteps) {
    const persisted = merged.get(recovered.index);
    if (!persisted) {
      merged.set(recovered.index, recovered);
      continue;
    }
    const persistedToolIds = new Set((persisted.tools || []).flatMap((tool) => tool.id ? [tool.id] : []));
    const missingTools = (recovered.tools || []).filter((tool) => !tool.id || !persistedToolIds.has(tool.id));
    if (!missingTools.length) continue;
    merged.set(recovered.index, {
      ...persisted,
      tools: [...(persisted.tools || []), ...missingTools],
    });
  }
  return [...merged.values()].sort((left, right) => left.index - right.index);
}

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
  const persistedSteps = message
    ? (await readBrowserChatStepsByIndexes<StepExecutionResult>(sessionId, message.stepIndexes || []))
        .filter((step) => !step.messageId || step.messageId === messageId)
    : [];
  const records = messageId && !input.cursor
    ? browserChatClientRecordsForMessage(
        { ...session, messages: message ? [message] : [] },
        messageId,
      )
    : { outputCycles: [], subagents: [] };
  const persistedToolIds = new Set(persistedSteps.flatMap((step) => (
    (step.tools || []).flatMap((tool) => tool.id ? [`${step.index}:${tool.id}`] : [])
  )));
  const hasUnresolvedCycleTool = records.outputCycles.some((cycle) => cycle.output.tools.some((tool) => (
    !tool.invalid
    && tool.ok === undefined
    && (!tool.id || !persistedToolIds.has(`${cycle.stepIndex ?? ''}:${tool.id}`))
  )));
  const recoveryLogs = message && hasUnresolvedCycleTool
    ? (await readBrowserChatLogsPage<BrowserChatLogRecord>(sessionId, {
        limit: 500,
        messageId,
      })).items
    : [];
  const steps = mergeBrowserChatRecoveredToolSteps(
    persistedSteps,
    browserChatRecoveredToolSteps(messageId || '', recoveryLogs),
  );
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
