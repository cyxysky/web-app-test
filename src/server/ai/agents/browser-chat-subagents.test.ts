import assert from 'node:assert/strict';
import test from 'node:test';
import { settleBrowserChatSubagents } from './browser-chat-subagents';

test('a failed child Agent does not cancel successful siblings', async () => {
  const results = await settleBrowserChatSubagents(['prd-a', 'prd-b', 'prd-c'], async (task) => {
    if (task === 'prd-b') throw new Error('unavailable');
    return `${task}:ok`;
  });

  assert.deepEqual(results.map((item) => item.result), ['prd-a:ok', undefined, 'prd-c:ok']);
  assert.match(String(results[1].error), /unavailable/);
});
