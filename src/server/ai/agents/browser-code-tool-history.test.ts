import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelMessage } from 'ai';
import { compactOlderBrowserCodeToolResults } from './browser-code-tool-history';

function browserCodeToolMessage(id: string, actual: string): ModelMessage {
  return {
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId: id,
      toolName: 'browserCode',
      output: {
        type: 'json',
        value: { ok: true, actual },
      },
    }],
  };
}

test('older browserCode results are compacted while the latest result stays exact', () => {
  const oldActual = JSON.stringify({
    ok: true,
    result: { found: 3 },
    finalPage: { url: 'https://example.test/old', title: 'Old' },
    domSnapshot: { content: 'x'.repeat(20_000), generationId: 'g1', nodeCount: 300 },
  });
  const latestActual = JSON.stringify({
    ok: true,
    result: { completed: true },
    finalPage: { url: 'https://example.test/current', title: 'Current' },
    postActionObservation: { captured: true, reason: 'browser-action' },
  });
  const genericTool: ModelMessage = {
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId: 'download-1',
      toolName: 'downloadFile',
      output: { type: 'text', value: 'keep this exact' },
    }],
  };
  const source = [browserCodeToolMessage('old', oldActual), genericTool, browserCodeToolMessage('latest', latestActual)];
  const compacted = compactOlderBrowserCodeToolResults(source);
  const oldOutput = (compacted[0] as unknown as { content: Array<{ output: { value: { actual: string } } }> }).content[0].output.value.actual;
  const latestOutput = (compacted[2] as unknown as { content: Array<{ output: { value: { actual: string } } }> }).content[0].output.value.actual;

  assert.ok(oldOutput.length < 4_000);
  assert.doesNotMatch(oldOutput, /x{100}/);
  assert.match(oldOutput, /"found":3/);
  assert.match(oldOutput, /Full historical DOM content removed/);
  assert.equal(latestOutput, latestActual);
  assert.equal(compacted[1], genericTool);
});

test('a single browserCode result is not rewritten', () => {
  const source = [browserCodeToolMessage('only', '{"ok":true}')];
  assert.equal(compactOlderBrowserCodeToolResults(source), source);
});
