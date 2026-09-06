import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelMessage } from 'ai';
import { normalizeSemanticSummary, summarizeSemanticRecords } from './runtime-semantic-summary';
import { fallbackRuntimeContinuationSummary } from './runtime-context-compression';
import { normalizeBrowserChatModelContext } from './browser-chat-model-context';
import { assembleRuntimeContext, deriveRuntimeTaskState, runtimeContextMessageRef } from './runtime-context-assembler';
import { hiddenRuntimeSkillContent, hiddenRuntimeSkillIdsInModelContext, requireHiddenRuntimeSkillRead } from './hidden-runtime-skills';
import { fileArtifactRuntimeSkillId } from '@webpilot/capability-file/runtime-skill';
import { chartRuntimeSkillId } from '@webpilot/capability-chart/runtime-skill';
import { runtimeSummaryRecord } from './runtime-context-materials';

function state(ref = 'ctx_user') {
  return { version: 2, goal: 'Repair report', currentState: 'Awaiting edits',
    constraints: [{ text: 'Keep the current document ID', sourceRefs: [ref] }], completed: [], decisions: [], keyFacts: [], failedAttempts: [], openItems: [],
    nextActions: [{ text: 'Read the source before editing', sourceRefs: [ref] }],
    instructionCoverage: [{ ref, status: 'active', reason: 'Constraint retained' }] };
}
function skillExchange(id: string, skillId: string): ModelMessage[] {
  return [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: 'skill', input: { action: 'read', skillId } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 'skill', output: { type: 'json', value: { ok: true, actual: hiddenRuntimeSkillContent(skillId)! } } }] },
  ];
}

test('semantic state rejects invented refs, uncovered corrections and discarded active constraints', () => {
  const summary = state();
  const input = { candidate: JSON.stringify(summary), allowedRefs: new Set(['ctx_user', 'ctx_correction']), requiredInstructionRefs: ['ctx_user'] };
  assert.ok(normalizeSemanticSummary(input));
  assert.equal(normalizeSemanticSummary({ ...input, requiredInstructionRefs: ['ctx_user', 'ctx_correction'] }), '');
  assert.equal(normalizeSemanticSummary({ ...input, candidate: JSON.stringify({ ...summary, nextActions: [{ text: 'Invented', sourceRefs: ['ctx_fake'] }] }) }), '');
  assert.equal(normalizeSemanticSummary({ ...input, previousSummary: input.candidate, candidate: JSON.stringify({ ...summary, constraints: [] }) }), '');
  const reconciled = { ...summary, instructionCoverage: [{ ref: 'ctx_user', status: 'superseded', reason: 'User corrected the document identity' }, { ref: 'ctx_correction', status: 'active', reason: 'Latest constraint' }], constraints: [{ text: 'Use corrected document ID', sourceRefs: ['ctx_correction'] }] };
  assert.ok(normalizeSemanticSummary({ ...input, previousSummary: input.candidate, candidate: JSON.stringify(reconciled), requiredInstructionRefs: ['ctx_correction'] }));
  const restored = JSON.parse(fallbackRuntimeContinuationSummary({ goal: 'Repair', agentStep: 2, stepIndex: 1, previousSummary: input.candidate, recentToolAttempts: 'read', runtimeState: { currentState: 'Document open' } }));
  assert.equal(restored.version, 2);
  assert.deepEqual(restored.instructionCoverage, summary.instructionCoverage);
  const long = JSON.stringify({ ...summary, keyFacts: [{ text: 'Evidence '.repeat(4000), sourceRefs: ['ctx_user'] }] });
  assert.equal(normalizeBrowserChatModelContext({ continuationSummary: long }).continuationSummary, long);
});

test('large built-in Skill is evicted; a fresh read restores visibility without resurrecting the old body', () => {
  const messages: ModelMessage[] = [{ role: 'user', content: 'Prepare the report' }, ...skillExchange('file-old', fileArtifactRuntimeSkillId), ...skillExchange('chart-small', chartRuntimeSkillId)];
  const context = normalizeBrowserChatModelContext({ transcript: messages });
  const options = { messages, records: context.records, inputBudgetTokens: 100000, baseTokens: 1000, compressionTriggerTokens: 15000, compressionTargetTokens: 6000 };
  const compact = assembleRuntimeContext(options);
  assert.equal(compact.compacting, true);
  const visible = hiddenRuntimeSkillIdsInModelContext(compact.messages);
  assert.equal(visible.has(fileArtifactRuntimeSkillId), false);
  assert.equal(visible.has(chartRuntimeSkillId), true);
  assert.equal(requireHiddenRuntimeSkillRead('file', { action: 'edit' }, visible)?.ok, false);
  assert.equal(visible.has(fileArtifactRuntimeSkillId), false, 'Returning rules must not authorize another action in the same model step');
  const reread = skillExchange('file-new', fileArtifactRuntimeSkillId);
  const next = assembleRuntimeContext({ ...options, messages: [...messages, ...reread], previousState: compact.taskState, compressionTriggerTokens: 50000 });
  assert.equal(next.compacting, false);
  const nextVisible = hiddenRuntimeSkillIdsInModelContext(next.messages);
  assert.equal(nextVisible.has(fileArtifactRuntimeSkillId), true);
  assert.equal(requireHiddenRuntimeSkillRead('file', { action: 'edit' }, nextVisible), undefined);
  assert.equal(JSON.stringify(next.messages).split('File Artifact Runtime').length - 1, 1);
});

test('source bodies, patches and fenced user code stay out of compaction output and summary input', () => {
  const code = 'SOURCE_SENTINEL = 123\n'.repeat(20000);
  const messages: ModelMessage[] = [{ role: 'user', content: `Keep the current document.\n\`\`\`python\n${code}\`\`\`` },
    { role: 'assistant', content: [
      { type: 'tool-call', toolCallId: 'generate', toolName: 'file', input: { action: 'generate', documentId: 'doc-1', program: code } },
      { type: 'tool-call', toolCallId: 'chart-read', toolName: 'skill', input: { action: 'read', skillId: chartRuntimeSkillId } },
    ] },
    { role: 'tool', content: [
      { type: 'tool-result', toolCallId: 'generate', toolName: 'file', output: { type: 'json', value: { ok: false, actual: { documentId: 'doc-1', readKind: 'source', program: code, patchBaseDigest: 'a'.repeat(64), sourceLineRange: { startLine: 21, endLine: 80, coordinateSpace: 'global' }, code: 'INVALID_CELL', error: 'D8 is incorrect' } } } },
      { type: 'tool-result', toolCallId: 'chart-read', toolName: 'skill', output: { type: 'json', value: { ok: true, actual: hiddenRuntimeSkillContent(chartRuntimeSkillId)! } } },
    ] }];
  const context = normalizeBrowserChatModelContext({ transcript: messages });
  const result = assembleRuntimeContext({ messages, records: context.records, baseTokens: 1000, inputBudgetTokens: 50000, planning: true });
  assert.doesNotMatch(JSON.stringify(result.messages), /SOURCE_SENTINEL/);
  assert.doesNotMatch(JSON.stringify(result.summaryRecords), /SOURCE_SENTINEL/);
  assert.match(JSON.stringify(result.messages), /Keep the current document/);
  assert.match(JSON.stringify(result.summaryRecords), /D8 is incorrect/);
  assert.match(JSON.stringify(result.summaryRecords), /INVALID_CELL/);
  assert.equal(result.taskState.materials!.find((item) => item.identity.documentId === 'doc-1' && item.identity.startLine)?.identity.startLine, 21);
  assert.match(JSON.stringify(context.records), /SOURCE_SENTINEL/);
});

test('summary batches preserve whole exchanges and do not acknowledge invalid outputs', async () => {
  const user: ModelMessage = { role: 'user', content: 'Keep the existing document ID' };
  const ref = runtimeContextMessageRef(user);
  const records = [runtimeSummaryRecord(user, ref, [])];
  let calls = 0;
  const result = await summarizeSemanticRecords({ groups: [records], previousSummary: '', runtimeState: {}, allowedRefs: new Set([ref]), instructionRefs: new Set([ref]), maximumInputTokens: 10000,
    generate: async (prompt) => { calls++; assert.match(prompt, /instructionCoverage/); return calls === 1 ? 'not JSON' : JSON.stringify(state(ref)); } });
  assert.equal(calls, 2); assert.equal(result.incomplete, false); assert.deepEqual(result.summarizedRefs, [ref]);
  const failed = await summarizeSemanticRecords({ groups: [records], previousSummary: '', runtimeState: {}, allowedRefs: new Set([ref]), instructionRefs: new Set([ref]), maximumInputTokens: 10000, generate: async () => '{}' });
  assert.equal(failed.incomplete, true); assert.deepEqual(failed.summarizedRefs, []);
  const pending = deriveRuntimeTaskState([{ role: 'assistant', content: [{ type: 'tool-call', toolName: 'file', toolCallId: 'pending-write', input: { action: 'edit' } }] }]);
  assert.deepEqual(pending.pendingToolCallIds, ['pending-write']);
});
