import type { BrowserChatSubagentRecord } from '@/server/ai/schemas/runtime.schema';

function recordFromUnknown(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parsedRecordFromText(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    return recordFromUnknown(JSON.parse(value));
  } catch {
    return undefined;
  }
}

export function browserChatSubagentBatchIdFromToolResult(value: unknown) {
  const result = recordFromUnknown(value);
  const actual = typeof result?.actual === 'string' ? result.actual : typeof value === 'string' ? value : '';
  const batchId = parsedRecordFromText(actual)?.batchId;
  return typeof batchId === 'string' ? batchId.trim() : '';
}

export function browserChatSubagentRecordsForToolCall(
  records: BrowserChatSubagentRecord[],
  toolResult?: unknown,
  toolCallId?: string,
) {
  const batchId = browserChatSubagentBatchIdFromToolResult(toolResult) || toolCallId?.trim();
  if (!batchId) return [];
  return records
    .filter((record) => record.batchId === batchId)
    .sort((left, right) => left.index - right.index);
}
