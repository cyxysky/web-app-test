import type { ModelMessage } from 'ai';
import type { BrowserChatSubagentMessage } from '@/server/ai/schemas/runtime.schema';

export type BrowserChatSubagentSettled<TTask, TResult> = {
  task: TTask;
  result?: TResult;
  error?: unknown;
};

export type BrowserChatSubagentConfirmationInteraction = {
  id: string;
  toolName: string;
  input: unknown;
  prompt: string;
  reason?: string;
  screenshotUrl?: string;
  requestedAt: string;
  decision: 'confirmed' | 'cancelled';
};

const subagentMessageMaxChars = 512_000;
const subagentMessageChainMaxChars = 2_000_000;

function serializableSubagentMessageContent(value: unknown) {
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(value, (key, item) => {
    if (key === 'rawResult' || key === 'providerMetadata' || key === 'providerOptions') return undefined;
    if (typeof item === 'bigint') return item.toString();
    if (typeof item === 'function' || typeof item === 'symbol') return undefined;
    if (typeof item === 'string' && item.startsWith('data:') && item.length > 8_192) {
      return `[内联二进制数据已省略，共 ${item.length} 个字符]`;
    }
    if (typeof item === 'string' && (key === 'data' || key === 'image' || key === 'file') && item.length > 8_192) {
      return `[二进制字段已省略，共 ${item.length} 个字符]`;
    }
    if (!item || typeof item !== 'object') return item;
    if ((item as { type?: unknown }).type === 'Buffer' && Array.isArray((item as { data?: unknown }).data)) {
      return `[Buffer ${(item as { data: unknown[] }).data.length} bytes]`;
    }
    if (item instanceof ArrayBuffer) return `[ArrayBuffer ${item.byteLength} bytes]`;
    if (ArrayBuffer.isView(item)) {
      const view = item as ArrayBufferView;
      return `[${item.constructor.name || 'TypedArray'} ${view.byteLength} bytes]`;
    }
    if (seen.has(item)) return '[Circular]';
    seen.add(item);
    return item;
  });
  if (serialized === undefined) return undefined;
  if (serialized.length <= subagentMessageMaxChars) return JSON.parse(serialized) as unknown;
  return {
    type: 'truncated-message',
    originalChars: serialized.length,
    preview: `${serialized.slice(0, subagentMessageMaxChars)}\n\n[消息内容过长，后续内容未持久化]`,
  };
}

/**
 * Persist child-Agent product data as a bounded, display-only copy of the real
 * AI SDK message chain. Debug metadata, duplicate raw tool results, and binary
 * payloads intentionally do not enter the conversation record.
 */
export function browserChatSubagentMessagesFromModelMessages(
  subagentId: string,
  messages: readonly ModelMessage[],
  idOffset = 0,
): BrowserChatSubagentMessage[] {
  const normalized = messages.flatMap((message, index) => {
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool') return [];
    const content = serializableSubagentMessageContent(message.content);
    return [{
      id: `${subagentId}:message:${idOffset + index}`,
      role: message.role,
      content,
    } satisfies BrowserChatSubagentMessage];
  });
  return limitBrowserChatSubagentMessages(subagentId, normalized, idOffset);
}

export function limitBrowserChatSubagentMessages(
  subagentId: string,
  messages: readonly BrowserChatSubagentMessage[],
  idOffset = 0,
) {
  let retainedChars = 0;
  const retained: BrowserChatSubagentMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const chars = (JSON.stringify(message.content) || '').length;
    if (retained.length && retainedChars + chars > subagentMessageChainMaxChars) continue;
    retained.unshift(message);
    retainedChars += chars;
  }
  const firstUser = messages.find((message) => message.role === 'user');
  if (firstUser && !retained.some((message) => message.id === firstUser.id)) retained.unshift(firstUser);
  if (retained.length < messages.length) {
    retained.splice(firstUser ? 1 : 0, 0, {
      id: `${subagentId}:message:omitted:${idOffset}`,
      role: 'assistant',
      content: `[较早的 ${messages.length - retained.length} 条子 Agent 消息因体积上限未持久化]`,
    });
  }
  return retained;
}

export function browserChatSubagentConfirmationMessage(
  subagentId: string,
  interaction: BrowserChatSubagentConfirmationInteraction,
): BrowserChatSubagentMessage {
  return {
    id: `${subagentId}:message:confirmation:${interaction.id}`,
    role: 'tool',
    content: serializableSubagentMessageContent({
      type: 'tool-confirmation',
      ...interaction,
    }),
  };
}

export function browserChatSubagentInputMessage(
  subagentId: string,
  instruction: string,
): BrowserChatSubagentMessage {
  return { id: `${subagentId}:message:input`, role: 'user', content: instruction };
}

export function browserChatSubagentSuggestedSummaryChars() {
  const configured = Number(process.env.AI_SUBAGENT_RESULT_MAX_CHARS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : undefined;
}

export function preserveBrowserChatSubagentSummary(value: unknown) {
  const summary = typeof value === 'string' ? value : String(value || '');
  return {
    summary,
    summaryChars: summary.length,
    summaryOriginalChars: summary.length,
    summaryTruncated: false,
  };
}

const inFlightBatches = new Map<string, Promise<unknown>>();
const completedBatches = new Map<string, unknown>();
let activeSubagents = 0;
const subagentWaiters: Array<() => void> = [];

function subagentConcurrency() {
  const configured = Number(process.env.AI_SUBAGENT_CONCURRENCY || 3);
  return Number.isFinite(configured) ? Math.min(12, Math.max(1, Math.floor(configured))) : 3;
}

async function withSubagentSlot<TResult>(runner: () => Promise<TResult>) {
  if (activeSubagents >= subagentConcurrency()) {
    await new Promise<void>((resolve) => subagentWaiters.push(resolve));
  } else {
    activeSubagents += 1;
  }
  try {
    return await runner();
  } finally {
    const next = subagentWaiters.shift();
    if (next) next();
    else activeSubagents = Math.max(0, activeSubagents - 1);
  }
}

/** Reuse the original child-Agent barrier when a main-Agent attempt repeats a batch. */
export async function runOrReuseBrowserChatSubagentBatch<TResult>(
  key: string,
  runner: () => Promise<TResult>,
): Promise<TResult> {
  if (completedBatches.has(key)) return completedBatches.get(key) as TResult;
  const existing = inFlightBatches.get(key);
  if (existing) return existing as Promise<TResult>;

  const promise = runner();
  inFlightBatches.set(key, promise);
  try {
    const result = await promise;
    completedBatches.set(key, result);
    while (completedBatches.size > 200) {
      const oldest = completedBatches.keys().next().value as string | undefined;
      if (!oldest) break;
      completedBatches.delete(oldest);
    }
    return result;
  } finally {
    if (inFlightBatches.get(key) === promise) inFlightBatches.delete(key);
  }
}

export function clearBrowserChatSubagentBatchRegistryForTests() {
  inFlightBatches.clear();
  completedBatches.clear();
  activeSubagents = 0;
  subagentWaiters.splice(0).forEach((resolve) => resolve());
}

/** Run independent child Agents without allowing one rejected branch to cancel siblings. */
export async function settleBrowserChatSubagents<TTask, TResult>(
  tasks: TTask[],
  runner: (task: TTask, index: number) => Promise<TResult>,
): Promise<Array<BrowserChatSubagentSettled<TTask, TResult>>> {
  const settled = await Promise.allSettled(tasks.map((task, index) => (
    withSubagentSlot(() => runner(task, index))
  )));
  return settled.map((item, index) => item.status === 'fulfilled'
    ? { task: tasks[index], result: item.value }
    : { task: tasks[index], error: item.reason });
}
