import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserChatSubagentRecord } from '@/server/ai/schemas/runtime.schema';
import { browserChatSubagentRecordsForToolCall } from './browser-chat-subagent-model';

function subagent(id: string, batchId: string, index: number): BrowserChatSubagentRecord {
  return {
    id,
    messageId: 'assistant-1',
    batchId,
    index,
    title: id,
    instruction: `read ${id}`,
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    status: 'running',
    content: '',
    resumable: false,
    toolCount: 0,
    steps: [],
    outputCycles: [],
    messages: [],
  };
}

test('a later subagent tool call never renders records from an earlier batch while its result is pending', () => {
  const records = [
    subagent('old-child', 'call-old', 0),
    subagent('new-child-b', 'call-new', 1),
    subagent('new-child-a', 'call-new', 0),
  ];

  assert.deepEqual(
    browserChatSubagentRecordsForToolCall(records, undefined, 'call-new').map((item) => item.id),
    ['new-child-a', 'new-child-b'],
  );
  assert.deepEqual(browserChatSubagentRecordsForToolCall(records, undefined, undefined), []);
});

test('the returned batch id is authoritative after the spawn tool completes', () => {
  const records = [subagent('old-child', 'call-old', 0), subagent('new-child', 'call-new', 0)];
  const result = { ok: true, actual: JSON.stringify({ batchId: 'call-new' }) };

  assert.deepEqual(
    browserChatSubagentRecordsForToolCall(records, result, 'stale-call-id').map((item) => item.id),
    ['new-child'],
  );
});
