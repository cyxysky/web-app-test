import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserChatSessionSnapshot } from '@/server/ai/agents/browser-chat.service';
import { compileConversationMessagesCase } from './conversation-case-compiler';

function sessionFixture(): BrowserChatSessionSnapshot {
  return {
    id: 'chat-1',
    title: '创建并检查需求',
    userId: '1',
    browserGroupId: 'session:chat-1',
    targetUrl: 'https://example.com/requirements',
    mode: 'code',
    safetyMode: 'strict',
    modelProvider: 'deepseek',
    model: 'deepseek-v4-flash',
    status: 'idle',
    busy: false,
    tabs: [],
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
    consoleErrors: [],
    networkErrors: [],
    logs: [],
    messages: [
      { id: 'user-1', role: 'user', content: '创建需求', createdAt: '2026-08-04T00:00:00.000Z' },
      { id: 'assistant-1', role: 'assistant', content: '已创建', createdAt: '2026-08-04T00:00:01.000Z', status: 'passed', stepIndexes: [1] },
      { id: 'user-2', role: 'user', content: '检查结果', createdAt: '2026-08-04T00:00:02.000Z' },
      { id: 'assistant-2', role: 'assistant', content: '检查完成', createdAt: '2026-08-04T00:00:03.000Z', status: 'passed', stepIndexes: [2] },
    ],
    steps: [
      {
        index: 1,
        messageId: 'assistant-1',
        action: '填写并提交',
        expected: '创建成功',
        actual: '创建成功',
        status: 'passed',
        tools: [{ id: 'tool-1', name: 'browserCode', input: { code: 'submit()' }, ok: true }],
      },
      {
        index: 2,
        messageId: 'assistant-2',
        action: '检查需求',
        expected: '需求存在',
        actual: '需求存在',
        status: 'passed',
        tools: [{ id: 'tool-2', name: 'browserCode', input: { code: 'check()' }, ok: true }],
      },
    ],
  };
}

test('compiles multiple selected messages from one conversation', () => {
  const compiled = compileConversationMessagesCase({
    session: sessionFixture(),
    assistantMessageIds: ['assistant-1', 'assistant-2'],
  });

  assert.equal(compiled.operations.length, 2);
  assert.deepEqual(compiled.operations.map((item) => item.index), [1, 2]);
  assert.deepEqual(compiled.sourceMessageIds, ['user-1', 'assistant-1', 'user-2', 'assistant-2']);
  assert.match(compiled.instruction, /1\. 创建需求/);
  assert.match(compiled.instruction, /2\. 检查结果/);
});

test('does not include unselected messages from the same conversation', () => {
  const compiled = compileConversationMessagesCase({
    session: sessionFixture(),
    assistantMessageIds: ['assistant-2'],
  });

  assert.equal(compiled.operations.length, 1);
  assert.equal(compiled.operations[0]?.input && (compiled.operations[0].input as { code?: string }).code, 'check()');
  assert.deepEqual(compiled.sourceMessageIds, ['user-2', 'assistant-2']);
  assert.equal(compiled.instruction, '检查结果');
});
