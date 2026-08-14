import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelMessage } from 'ai';
import {
  browserChatSubagentConfirmationMessage,
  browserChatSubagentMessagesFromModelMessages,
  browserChatSubagentSuggestedSummaryChars,
  clearBrowserChatSubagentBatchRegistryForTests,
  preserveBrowserChatSubagentSummary,
  runOrReuseBrowserChatSubagentBatch,
  settleBrowserChatSubagents,
} from './browser-chat-subagents';

test('child Agent persistence keeps messages while removing debug duplicates and binary payloads', () => {
  const messages = browserChatSubagentMessagesFromModelMessages('child-1', [
    { role: 'user', content: [{ type: 'text', text: '读取页面内容' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'browserCode', input: { code: 'return 1' } }],
    },
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'browserCode',
        output: {
          type: 'json',
          value: {
            result: '可见结果',
            rawResult: '不应重复持久化',
            image: `data:image/png;base64,${'a'.repeat(10_000)}`,
            buffer: Buffer.alloc(10_000, 1),
          },
        },
      }],
    },
  ] as unknown as ModelMessage[]);

  const serialized = JSON.stringify(messages);
  assert.match(serialized, /读取页面内容/);
  assert.match(serialized, /browserCode/);
  assert.match(serialized, /可见结果/);
  assert.doesNotMatch(serialized, /不应重复持久化/);
  assert.doesNotMatch(serialized, /a{1000}/);
  assert.match(serialized, /内联二进制数据已省略/);
  assert.match(serialized, /Buffer 10000 bytes/);
});

test('a single oversized child Agent message is replaced by a bounded preview', () => {
  const messages = browserChatSubagentMessagesFromModelMessages('child-2', [{
    role: 'assistant',
    content: [{ type: 'text', text: 'x'.repeat(700_000) }],
  }] as unknown as ModelMessage[]);

  const serialized = JSON.stringify(messages);
  assert.ok(serialized.length < 520_000);
  assert.match(serialized, /truncated-message/);
  assert.match(serialized, /消息内容过长/);
});

test('a child Agent confirmation is stored as a message with its screenshot reference', () => {
  const message = browserChatSubagentConfirmationMessage('child-3', {
    id: 'confirmation-1',
    toolName: 'browserCode',
    input: { code: 'await page.click("button")', rawResult: 'duplicate' },
    prompt: '确认提交页面',
    screenshotUrl: '/api/artifacts/session/confirmation.png',
    requestedAt: '2026-08-14T00:00:00.000Z',
    decision: 'confirmed',
  });

  const serialized = JSON.stringify(message);
  assert.match(serialized, /tool-confirmation/);
  assert.match(serialized, /confirmation\.png/);
  assert.match(serialized, /confirmed/);
  assert.doesNotMatch(serialized, /duplicate/);
});

test('child Agent summary length is prompt guidance from configuration and never a backend truncation limit', () => {
  const previous = process.env.AI_SUBAGENT_RESULT_MAX_CHARS;
  process.env.AI_SUBAGENT_RESULT_MAX_CHARS = '12345';
  assert.equal(browserChatSubagentSuggestedSummaryChars(), 12_345);
  if (previous === undefined) delete process.env.AI_SUBAGENT_RESULT_MAX_CHARS;
  else process.env.AI_SUBAGENT_RESULT_MAX_CHARS = previous;

  const source = `  ${'a'.repeat(50_001)}\n`;
  const complete = preserveBrowserChatSubagentSummary(source);
  assert.equal(complete.summary, source);
  assert.equal(complete.summary.length, 50_004);
  assert.equal(complete.summaryOriginalChars, 50_004);
  assert.equal(complete.summaryTruncated, false);
});

test('a failed child Agent does not cancel successful siblings', async () => {
  const results = await settleBrowserChatSubagents(['prd-a', 'prd-b', 'prd-c'], async (task) => {
    if (task === 'prd-b') throw new Error('unavailable');
    return `${task}:ok`;
  });

  assert.deepEqual(results.map((item) => item.result), ['prd-a:ok', undefined, 'prd-c:ok']);
  assert.match(String(results[1].error), /unavailable/);
});

test('a repeated child-Agent batch waits for and reuses the original result', async () => {
  clearBrowserChatSubagentBatchRegistryForTests();
  let executions = 0;
  let release!: (value: { results: string[] }) => void;
  const barrier = new Promise<{ results: string[] }>((resolve) => { release = resolve; });
  const runner = () => {
    executions += 1;
    return barrier;
  };

  const original = runOrReuseBrowserChatSubagentBatch('same-turn:same-tasks', runner);
  const retry = runOrReuseBrowserChatSubagentBatch('same-turn:same-tasks', runner);
  assert.equal(executions, 1);

  release({ results: ['complete child result'] });
  assert.deepEqual(await original, { results: ['complete child result'] });
  assert.deepEqual(await retry, { results: ['complete child result'] });

  const completedRetry = await runOrReuseBrowserChatSubagentBatch('same-turn:same-tasks', runner);
  assert.equal(executions, 1);
  assert.deepEqual(completedRetry, { results: ['complete child result'] });
});
