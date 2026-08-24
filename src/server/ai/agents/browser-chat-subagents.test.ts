import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelMessage } from 'ai';
import {
  browserChatSubagentConfirmationMessage,
  browserChatSubagentMessagesFromModelMessages,
  browserChatSubagentMessagesFromProgress,
  browserChatSubagentSuggestedSummaryChars,
  clearBrowserChatSubagentBatchRegistryForTests,
  preserveBrowserChatSubagentSummary,
  resolvedBrowserChatSubagentStatus,
  runBrowserChatSubagentAttemptWithRetry,
  runOrReuseBrowserChatSubagentBatch,
  settleBrowserChatSubagents,
} from './browser-chat-subagents';

test('a child Agent retries once after a thrown or zero-tool failure', async () => {
  const thrownAttempts: number[] = [];
  const thrownResult = await runBrowserChatSubagentAttemptWithRetry({
    run: async (attempt) => {
      thrownAttempts.push(attempt);
      if (attempt === 1) throw new Error('request unavailable');
      return { status: 'passed' as const, toolCount: 1 };
    },
    shouldRetryResult: () => false,
    retryReasonFromError: (error) => String(error),
    retryReasonFromResult: () => '',
    onRetry: () => undefined,
  });
  assert.deepEqual(thrownAttempts, [1, 2]);
  assert.equal(thrownResult.status, 'passed');

  const zeroToolAttempts: number[] = [];
  const zeroToolResult = await runBrowserChatSubagentAttemptWithRetry({
    run: async (attempt) => {
      zeroToolAttempts.push(attempt);
      return attempt === 1
        ? { status: 'failed' as const, toolCount: 0 }
        : { status: 'passed' as const, toolCount: 2 };
    },
    shouldRetryResult: (result) => result.status === 'failed' && result.toolCount === 0,
    retryReasonFromError: (error) => String(error),
    retryReasonFromResult: () => 'no tools executed',
    onRetry: () => undefined,
  });
  assert.deepEqual(zeroToolAttempts, [1, 2]);
  assert.equal(zeroToolResult.toolCount, 2);
});

test('running child Agent progress exposes tool calls and results before completion', () => {
  const messages = browserChatSubagentMessagesFromProgress({
    subagentId: 'child-live',
    instruction: '读取工资明细',
    steps: [{
      index: 1,
      action: '读取页面字段',
      expected: '返回工资明细',
      actual: '浏览器代码已返回页面文本',
      status: 'running',
      tools: [{
        id: 'call-live-1',
        name: 'browserCode',
        input: { code: 'return document.body.innerText' },
        ok: true,
        result: '工资明细页面文本',
      }],
    }],
    streamedText: '正在整理页面证据',
  });

  const serialized = JSON.stringify(messages);
  assert.match(serialized, /读取页面字段/);
  assert.match(serialized, /browserCode/);
  assert.match(serialized, /工资明细页面文本/);
  assert.match(serialized, /正在整理页面证据/);
});

test('a recovered child Agent result with a usable summary is passed', () => {
  const recoveredSteps = [{
    index: 1,
    action: '截图失败后改用页面文本',
    expected: '读取页面内容',
    actual: '文本证据已完整读取',
    status: 'failed' as const,
    tools: [{ name: 'browserCode', ok: false, result: '截图超时' }],
  }];
  assert.equal(resolvedBrowserChatSubagentStatus({
    status: 'failed',
    summary: '已基于文本证据完成工资明细总结。',
    steps: recoveredSteps,
  }), 'passed');
});

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

test('child Agents execute concurrently within the global limit and a failure does not cancel siblings', async () => {
  const previousConcurrency = process.env.AI_SUBAGENT_CONCURRENCY;
  process.env.AI_SUBAGENT_CONCURRENCY = '2';
  clearBrowserChatSubagentBatchRegistryForTests();
  const executionOrder: string[] = [];
  let active = 0;
  let peakActive = 0;
  try {
    const results = await settleBrowserChatSubagents(['prd-a', 'prd-b', 'prd-c'], async (task) => {
      executionOrder.push(`start:${task}`);
      active += 1;
      peakActive = Math.max(peakActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      executionOrder.push(`end:${task}`);
      if (task === 'prd-b') throw new Error('unavailable');
      return `${task}:ok`;
    });

    assert.equal(peakActive, 2);
    assert.deepEqual(executionOrder.slice(0, 2), ['start:prd-a', 'start:prd-b']);
    assert.deepEqual(results.map((item) => item.result), ['prd-a:ok', undefined, 'prd-c:ok']);
    assert.match(String(results[1].error), /unavailable/);

    process.env.AI_SUBAGENT_CONCURRENCY = '999';
    active = 0;
    peakActive = 0;
    await settleBrowserChatSubagents(
      Array.from({ length: 21 }, (_, index) => index),
      async () => {
        active += 1;
        peakActive = Math.max(peakActive, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active -= 1;
      },
    );
    assert.equal(peakActive, 21);
  } finally {
    if (previousConcurrency === undefined) delete process.env.AI_SUBAGENT_CONCURRENCY;
    else process.env.AI_SUBAGENT_CONCURRENCY = previousConcurrency;
    clearBrowserChatSubagentBatchRegistryForTests();
  }
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
