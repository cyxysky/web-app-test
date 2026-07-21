import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserChatSubagentSuggestedSummaryChars,
  clearBrowserChatSubagentBatchRegistryForTests,
  preserveBrowserChatSubagentSummary,
  runOrReuseBrowserChatSubagentBatch,
  settleBrowserChatSubagents,
} from './browser-chat-subagents';

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
