import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearBrowserChatSubagentBatchRegistryForTests,
  runOrReuseBrowserChatSubagentBatch,
  settleBrowserChatSubagents,
} from './browser-chat-subagents';

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
