import { jsonRecordFromUnknown, jsonValueFromString } from '@webpilot/capability-sdk';
import type { BrowserChatSubagentRecord } from '@/server/ai/schemas/runtime.schema';

export function browserChatSubagentBatchIdFromToolResult(value: unknown) {
  const result = jsonRecordFromUnknown(value);
  const actual = typeof result?.actual === 'string' ? result.actual : typeof value === 'string' ? value : '';
  const batchId = jsonRecordFromUnknown(jsonValueFromString(actual))?.batchId;
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
