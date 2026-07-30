import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelMessage } from 'ai';
import { compactOlderBrowserCodeToolResults, compactOlderBrowserToolResults } from './browser-code-tool-history';

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
    domChanges: {
      epoch: 7,
      added: [`<button>${'x'.repeat(20_000)}</button>`],
      updated: [],
      removed: [],
      extra: { added: [], updated: [], errors: [], validationErrors: [] },
      overflow: false,
    },
  });
  const latestActual = JSON.stringify({
    ok: true,
    result: { completed: true },
    finalPage: { url: 'https://example.test/current', title: 'Current' },
    domChanges: {
      epoch: 8,
      added: ['<status>Done'],
      updated: [],
      removed: [],
      extra: { added: [], updated: [], errors: [], validationErrors: [] },
      overflow: false,
    },
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
  assert.match(oldOutput, /"addedCount":1/);
  assert.equal(latestOutput, latestActual);
  assert.equal(compacted[1], genericTool);
});

test('a single browserCode result is not rewritten', () => {
  const source = [browserCodeToolMessage('only', '{"ok":true}')];
  assert.equal(compactOlderBrowserCodeToolResults(source), source);
});

function domToolMessage(id: string, text: string): ModelMessage {
  return {
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId: id,
      toolName: 'interact',
      output: {
        type: 'json',
        value: {
          ok: true,
          actual: `clicked ${id}`,
          domChanges: {
            epoch: 1,
            added: [`<div>${text}</div>`],
            updated: [],
            removed: [],
            extra: { added: [], updated: [], errors: [], validationErrors: [] },
            overflow: false,
          },
        },
      },
    }],
  };
}

test('DOM mode retains only the latest full post-action DOM update', () => {
  const source = [domToolMessage('old', 'old-update'), domToolMessage('latest', 'latest-update')];
  const compacted = compactOlderBrowserToolResults(source, 'dom');
  const oldValue = (compacted[0] as unknown as { content: Array<{ output: { value: Record<string, unknown> } }> }).content[0].output.value;
  const latestValue = (compacted[1] as unknown as { content: Array<{ output: { value: Record<string, unknown> } }> }).content[0].output.value;

  assert.equal(oldValue.actual, 'clicked old');
  assert.deepEqual(oldValue.domChanges, {
    epoch: 1,
    addedCount: 1,
    updatedCount: 0,
    removedCount: 0,
    validationErrors: [],
    errors: [],
    overflow: false,
  });
  assert.equal(oldValue.historicalDomUpdate, true);
  assert.match(JSON.stringify(latestValue.domChanges), /latest-update/);
});

test('code mode does not rewrite DOM-tool updates', () => {
  const source = [domToolMessage('old', 'old-update'), domToolMessage('latest', 'latest-update')];
  assert.deepEqual(compactOlderBrowserToolResults(source, 'code'), source);
});
