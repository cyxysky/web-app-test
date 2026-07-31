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
  assert.doesNotMatch(oldOutput, /domChanges|addedCount/);
  assert.equal(latestOutput, latestActual);
  assert.equal(compacted[1], genericTool);
});

test('a single browserCode result is not rewritten', () => {
  const source = [browserCodeToolMessage('only', '{"ok":true}')];
  assert.equal(compactOlderBrowserCodeToolResults(source), source);
});

test('the latest operation evidence stays exact after a later read-only browserCode result', () => {
  const oldOperation = browserCodeToolMessage('old-operation', JSON.stringify({
    ok: true,
    domChanges: {
      epoch: 1,
      added: ['<button>Old</button>'],
      updated: [],
      removed: [],
      extra: { added: [], updated: [], errors: [], validationErrors: [] },
      overflow: false,
    },
    axTree: '- button "Old"',
  }));
  const latestOperationActual = JSON.stringify({
    ok: true,
    domChanges: {
      epoch: 2,
      added: ['<button>Current</button>'],
      updated: [],
      removed: [],
      extra: { added: [], updated: [], errors: [], validationErrors: [] },
      overflow: false,
    },
    axTree: '- button "Current"',
  });
  const latestOperation = browserCodeToolMessage('latest-operation', latestOperationActual);
  const readOnly = browserCodeToolMessage('read-only', JSON.stringify({
    ok: true,
    result: { url: 'https://example.test/current' },
  }));

  const compacted = compactOlderBrowserCodeToolResults([oldOperation, latestOperation, readOnly]);
  const oldOutput = (compacted[0] as unknown as { content: Array<{ output: { value: { actual: string } } }> }).content[0].output.value.actual;
  const latestOperationOutput = (compacted[1] as unknown as { content: Array<{ output: { value: { actual: string } } }> }).content[0].output.value.actual;
  const latestOperationValue = JSON.parse(latestOperationOutput) as {
    axTree?: string;
    domChanges?: { added?: string[] };
  };

  assert.match(oldOutput, /historicalToolResult/);
  assert.doesNotMatch(oldOutput, /button \\"Old\\"/);
  assert.equal(latestOperationValue.axTree, '- button "Current"');
  assert.deepEqual(latestOperationValue.domChanges?.added, ['<button>Current</button>']);
  assert.equal(compacted[2], readOnly);
});

test('the latest top-level AX replaces an older nested AX in the same stored result', () => {
  const source = [browserCodeToolMessage('operation', JSON.stringify({
    ok: true,
    result: [{
      openTabs: [{ url: 'https://example.test' }],
      domSnapshot: '[ax-tree]\n- button "Before"',
    }],
    axTree: '- button "After"',
  }))];

  const compacted = compactOlderBrowserCodeToolResults(source);
  const output = (compacted[0] as unknown as { content: Array<{ output: { value: { actual: string } } }> }).content[0].output.value.actual;
  const parsed = JSON.parse(output) as { axTree?: string; result?: Array<Record<string, unknown>> };

  assert.equal(parsed.axTree, '- button "After"');
  assert.equal(parsed.result?.[0]?.domSnapshot, undefined);
  assert.doesNotMatch(output, /button \\"Before\\"/);
});

test('AX and domChanges retain their newest occurrences independently', () => {
  const operation = browserCodeToolMessage('operation', JSON.stringify({
    ok: true,
    domChanges: {
      epoch: 3,
      added: ['<dialog>Current change</dialog>'],
      updated: [],
      removed: [],
    },
    axTree: '- dialog "Operation tree"',
  }));
  const laterInspection = browserCodeToolMessage('inspection', JSON.stringify({
    ok: true,
    result: { snapshot: '[ax-tree]\n- dialog "Latest tree"' },
  }));

  const compacted = compactOlderBrowserCodeToolResults([operation, laterInspection]);
  const operationOutput = (compacted[0] as unknown as { content: Array<{ output: { value: { actual: string } } }> }).content[0].output.value.actual;
  const inspectionOutput = (compacted[1] as unknown as { content: Array<{ output: { value: { actual: string } } }> }).content[0].output.value.actual;

  assert.match(operationOutput, /Current change/);
  assert.doesNotMatch(operationOutput, /Operation tree/);
  assert.match(inspectionOutput, /Latest tree/);
  assert.doesNotMatch(inspectionOutput, /domChanges/);
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
  assert.equal(oldValue.domChanges, undefined);
  assert.equal(oldValue.historicalDomUpdate, undefined);
  assert.match(JSON.stringify(latestValue.domChanges), /latest-update/);
});

test('code mode does not rewrite DOM-tool updates', () => {
  const source = [domToolMessage('old', 'old-update'), domToolMessage('latest', 'latest-update')];
  assert.deepEqual(compactOlderBrowserToolResults(source, 'code'), source);
});
