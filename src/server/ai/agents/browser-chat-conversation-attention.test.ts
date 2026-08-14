import assert from 'node:assert/strict';
import test from 'node:test';
import { browserChatConversationAttentionContext } from './browser-chat-conversation-attention';

test('builds a bounded attention index from prior completed exchanges and the current request', () => {
  const context = browserChatConversationAttentionContext([
    { role: 'user', content: '先分析八个链接' },
    { role: 'assistant', content: '已经并行读取并给出结论。', status: 'passed' },
    { role: 'user', content: '再根据结论生成文档' },
    { role: 'assistant', content: '文档已经生成。', status: 'passed' },
    { role: 'user', content: '确认文档是否覆盖了第一个问题' },
    { role: 'assistant', content: '仍在运行，不应进入锚点', status: 'running' },
  ]);

  assert.match(context, /Current user request \(highest priority\):\n确认文档是否覆盖了第一个问题/);
  assert.match(context, /User: 先分析八个链接/);
  assert.match(context, /Assistant: 已经并行读取并给出结论/);
  assert.doesNotMatch(context, /仍在运行/);
});

test('does not add attention noise to the first conversation turn', () => {
  assert.equal(browserChatConversationAttentionContext([
    { role: 'user', content: '第一个问题' },
  ]), '');
});

test('keeps only the four most recent completed exchanges', () => {
  const messages = Array.from({ length: 6 }, (_, index) => ([
    { role: 'user' as const, content: `问题 ${index + 1}` },
    { role: 'assistant' as const, content: `回复 ${index + 1}`, status: 'passed' },
  ])).flat();
  messages.push({ role: 'user', content: '当前问题' });
  const context = browserChatConversationAttentionContext(messages);
  assert.doesNotMatch(context, /问题 1/);
  assert.doesNotMatch(context, /问题 2/);
  assert.match(context, /问题 3/);
  assert.match(context, /问题 6/);
});
