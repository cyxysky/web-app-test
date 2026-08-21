import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelMessage } from 'ai';
import {
  atomicRuntimeModelMessageBlocks,
  buildRuntimeContinuationSummaryPrompt,
  mergeRuntimeModelMessageChain,
  sanitizeRuntimeContinuationSummary,
  selectRecentRuntimeMessageBlocks,
} from './runtime-context-compression';
import {
  runtimeContextCompressionTargetCeilingRatio,
  runtimeContextCompressionTargetFloorRatio,
  runtimeContextCompressionThresholdRatio,
  runtimeContextWindowTokens,
} from './runtime-context-budget';

test('runtime context uses an eighty-five percent trigger and a ten-to-twenty percent compression target', () => {
  assert.equal(runtimeContextWindowTokens(), 256000);
  assert.equal(runtimeContextCompressionThresholdRatio(), 0.85);
  assert.equal(runtimeContextCompressionTargetFloorRatio(), 0.1);
  assert.equal(runtimeContextCompressionTargetCeilingRatio(), 0.2);
});

test('compression never separates an assistant tool call from its tool result', () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: '检查页面' },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'tool-1', toolName: 'browserCode', input: { code: 'nodeRepl.write(await page.title())' } }],
    },
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'tool-1', toolName: 'browserCode', output: { type: 'text', value: 'done' } }],
    },
    { role: 'assistant', content: '页面检查完成' },
  ];
  const blocks = atomicRuntimeModelMessageBlocks(messages);
  assert.deepEqual(blocks.map((block) => block.map((message) => message.role)), [
    ['user'],
    ['assistant', 'tool'],
    ['assistant'],
  ]);
});

test('merges an SDK response chain without duplicating messages already prepared for the final step', () => {
  const user: ModelMessage = { role: 'user', content: '分析全部链接' };
  const firstCall: ModelMessage = {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: 'inspect-1', toolName: 'browserCode', input: {} }],
  };
  const firstResult: ModelMessage = {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'inspect-1', toolName: 'browserCode', output: { type: 'text', value: '9 links' } }],
  };
  const spawnCall: ModelMessage = {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: 'spawn-1', toolName: 'spawnSubagents', input: {} }],
  };
  const spawnResult: ModelMessage = {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'spawn-1', toolName: 'spawnSubagents', output: { type: 'text', value: 'completed' } }],
  };
  const merged = mergeRuntimeModelMessageChain(
    [user, firstCall, firstResult],
    [firstCall, firstResult, spawnCall, spawnResult],
  );
  assert.deepEqual(merged, [user, firstCall, firstResult, spawnCall, spawnResult]);
});

test('compression keeps only complete recent blocks that fit the ten-percent raw-tail budget', () => {
  const blocks: ModelMessage[][] = [
    [{ role: 'user', content: 'old' }],
    [{ role: 'assistant', content: 'middle' }],
    [{ role: 'assistant', content: 'recent' }],
  ];
  const weights = new Map([['old', 12], ['middle', 7], ['recent', 5]]);
  const selected = selectRecentRuntimeMessageBlocks(
    blocks,
    (block) => weights.get(String(block[0]?.content)) || 0,
    10,
  );
  assert.deepEqual(selected.retainedBlocks.flat().map((message) => message.content), ['recent']);
  assert.equal(selected.retainedTokens, 5);
  assert.equal(selected.olderBlocks.length, 2);
});

test('an oversized atomic tool block is summarized instead of breaking the twenty-percent ceiling', () => {
  const toolBlock: ModelMessage[] = [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'huge', toolName: 'browserCode', input: { code: 'nodeRepl.write(1)' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'huge', toolName: 'browserCode', output: { type: 'text', value: 'x'.repeat(10_000) } }] },
  ];
  const selected = selectRecentRuntimeMessageBlocks([toolBlock], () => 2_500, 1_000);
  assert.deepEqual(selected.retainedBlocks, []);
  assert.deepEqual(selected.olderBlocks, [toolBlock]);
});

test('continuation compression explicitly merges a previous summary with only a delta', () => {
  const prompt = buildRuntimeContinuationSummaryPrompt({
    agentStep: 3,
    deltaModelMessages: { messages: [{ role: 'tool', content: 'new evidence' }] },
    estimatedTokens: 200000,
    goal: '完成任务',
    previousSummary: '{"completed":["login"]}',
    runtimeState: { currentState: 'dashboard' },
    stepIndex: 2,
    thresholdTokens: 179200,
  });
  assert.match(prompt, /Previous continuation summary JSON/);
  assert.match(prompt, /New unsummarized message delta JSON/);
  assert.match(prompt, /Never copy raw screenshots, AX trees, page\.domSnapshot\(\) output, domChanges payloads/);
  assert.doesNotMatch(prompt, /Complete message history/);
});

test('continuation summaries discard raw AX and DOM-change payloads', () => {
  const sanitized = sanitizeRuntimeContinuationSummary(JSON.stringify({
    completed: ['login'],
    axTree: '- button "Old"',
    importantEvidence: [
      '[ax-tree]\n- dialog "Old"',
      'The login succeeded.',
    ],
    nested: { domChanges: { added: ['<dialog>Old</dialog>'] } },
  }));

  assert.match(sanitized, /login/);
  assert.match(sanitized, /The login succeeded/);
  assert.doesNotMatch(sanitized, /axTree|\[ax-tree\]|domChanges|button \\"Old\\"|dialog \\"Old\\"/);
});
