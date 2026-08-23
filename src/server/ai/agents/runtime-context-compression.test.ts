import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelMessage } from 'ai';
import {
  atomicRuntimeModelMessageBlocks,
  buildRuntimeContinuationSummaryPrompt,
  fallbackRuntimeContinuationSummary,
  mergeRuntimeModelMessageChain,
  normalizeRuntimeContinuationSummary,
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
  assert.equal(runtimeContextWindowTokens({ provider: 'openai-compatible', model: 'glm-5.3' }), 1_000_000);
  assert.equal(runtimeContextCompressionThresholdRatio(), 0.85);
  assert.equal(runtimeContextCompressionThresholdRatio({ provider: 'openai-compatible', model: 'glm-5.3' }), 0.85);
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

test('a prose response cannot replace a structured continuation checkpoint', () => {
  assert.equal(normalizeRuntimeContinuationSummary({
    candidate: 'The document is complete, so start the original task again.',
    goal: 'Create three documents.',
    previousSummary: JSON.stringify({ completed: ['PPT rendered'], nextStep: 'Inspect page 2.' }),
    runtimeState: {},
  }), '');
});

test('continuation normalization keeps durable completion facts across segments', () => {
  const normalized = JSON.parse(normalizeRuntimeContinuationSummary({
    candidate: JSON.stringify({
      completed: ['DOC QA 22/22'],
      currentPage: 'PPT preview',
      confirmedFacts: ['PPT is 94MB'],
      negativeResults: [],
      failedAttempts: [],
      importantEvidence: [],
      openObservations: [],
      remaining: ['Inspect PPT pages'],
      nextStep: 'Inspect the current PPT artifact.',
    }),
    goal: 'Create PPT, DOCX, and PDF.',
    previousSummary: JSON.stringify({
      completed: ['Wiki research complete'],
      confirmedFacts: ['Assets downloaded'],
      nextStep: 'Continue QA.',
    }),
    runtimeState: { completed: ['Latest render complete'] },
  }));
  assert.deepEqual(normalized.completed, ['Wiki research complete', 'DOC QA 22/22', 'Latest render complete']);
  assert.deepEqual(normalized.confirmedFacts, ['Assets downloaded', 'PPT is 94MB']);
  assert.equal(normalized.nextStep, 'Inspect the current PPT artifact.');
});

test('fallback compression preserves previous progress instead of reducing to the original goal', () => {
  const fallback = JSON.parse(fallbackRuntimeContinuationSummary({
    agentStep: 8,
    goal: 'Create PPT, DOCX, and PDF.',
    previousSummary: JSON.stringify({
      completed: ['Wiki research complete', 'DOC rendered'],
      confirmedFacts: ['DOC QA 22/22'],
      remaining: ['PPT QA'],
      nextStep: 'Read the remaining PPT screenshots.',
    }),
    recentToolAttempts: '[none]',
    runtimeState: {},
    stepIndex: 3,
  }));
  assert.deepEqual(fallback.completed, ['Wiki research complete', 'DOC rendered']);
  assert.deepEqual(fallback.confirmedFacts, ['DOC QA 22/22']);
  assert.deepEqual(fallback.remaining, ['PPT QA']);
  assert.equal(fallback.nextStep, 'Read the remaining PPT screenshots.');
});

test('a runtime continuation gate overrides a model attempt to restart the goal', () => {
  const normalized = JSON.parse(normalizeRuntimeContinuationSummary({
    candidate: JSON.stringify({
      completed: [],
      currentPage: '',
      confirmedFacts: [],
      negativeResults: [],
      failedAttempts: [],
      importantEvidence: [],
      openObservations: [],
      remaining: ['Research the wiki again'],
      nextStep: 'Research the wiki again.',
    }),
    goal: 'Create PPT, DOCX, and PDF.',
    previousSummary: JSON.stringify({ completed: ['Wiki research complete'], nextStep: 'Continue QA.' }),
    runtimeState: { userConstraints: ['Read pages 19-22 of the current DOC artifact.'] },
  }));
  assert.equal(normalized.nextStep, 'Read pages 19-22 of the current DOC artifact.');
  assert.deepEqual(normalized.remaining, ['Read pages 19-22 of the current DOC artifact.']);
  assert.deepEqual(normalized.completed, ['Wiki research complete']);
});
