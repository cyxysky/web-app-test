import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activeBrowserChatAssistantMessage,
  browserChatClientRecordsForMessage,
} from './browser-chat-client-window';

test('selects records only for the active assistant message', () => {
  const source = {
    busy: true,
    status: 'running',
    messages: [
      { id: 'assistant-old', role: 'assistant' as const, status: 'passed', stepIndexes: [1] },
      { id: 'assistant-live', role: 'assistant' as const, status: 'running', stepIndexes: [2] },
    ],
    outputCycles: [
      { id: 'old', messageId: 'assistant-old', output: { parts: [], reasoning: [], texts: [], tools: [] } },
      { id: 'live', messageId: 'assistant-live', output: { parts: [], reasoning: [], texts: [], tools: [] } },
      { id: 'live-by-step', stepIndex: 2, output: { parts: [], reasoning: [], texts: [], tools: [] } },
      { id: 'child', messageId: 'assistant-live', subagentId: 'child-1', output: { parts: [], reasoning: [], texts: [], tools: [] } },
    ],
    subagents: [
      {
        id: 'child-1',
        messageId: 'assistant-live',
        batchId: 'batch-1',
        index: 0,
        title: 'child',
        instruction: 'read child data',
        createdAt: '2026-08-19T00:00:00.000Z',
        updatedAt: '2026-08-19T00:00:01.000Z',
        status: 'running' as const,
        content: '',
        resumable: false,
        toolCount: 1,
        steps: [],
        outputCycles: [],
        messages: [],
      },
    ],
  };

  const activeMessage = activeBrowserChatAssistantMessage(source);
  assert.equal(activeMessage?.id, 'assistant-live');
  const records = browserChatClientRecordsForMessage(source, activeMessage?.id || '', { includeSubagents: true });
  assert.deepEqual(records.outputCycles.map((cycle) => cycle.id), ['live', 'live-by-step']);
  assert.deepEqual(records.subagents.map((subagent) => subagent.id), ['child-1']);
  assert.equal(activeBrowserChatAssistantMessage({ ...source, busy: false, status: 'idle' }), undefined);
});
