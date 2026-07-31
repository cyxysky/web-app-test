import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRuntimeContinuationSummaryPrompt, sanitizeRuntimeContinuationSummary } from './runtime-context-compression';
import { runtimeContextCompressionThresholdRatio, runtimeContextWindowTokens } from './runtime-context-budget';

test('runtime context defaults to a 256k window and seventy percent threshold', () => {
  assert.equal(runtimeContextWindowTokens(), 256000);
  assert.equal(runtimeContextCompressionThresholdRatio(), 0.7);
});

test('continuation compression explicitly merges a previous summary with only a delta', () => {
  const prompt = buildRuntimeContinuationSummaryPrompt({
    agentStep: 3,
    browserMode: 'code',
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
