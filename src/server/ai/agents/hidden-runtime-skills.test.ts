import assert from 'node:assert/strict';
import test from 'node:test';
import { browserCodeRuntimeSkillId } from './browser-code-runtime-skill';
import {
  browserApiRuntimeSkillContent,
  browserApiRuntimeSkillId,
} from './browser-api-runtime-skill';
import {
  fileArtifactRuntimeSkillContent,
  fileArtifactRuntimeSkillId,
} from './file-artifact-runtime-skill';
import {
  hiddenRuntimeSkillContent,
  hiddenRuntimeSkillGateResult,
  hiddenRuntimeSkillIdsReadFromTraces,
  hiddenRuntimeSkillSummariesForMode,
  requiredHiddenRuntimeSkillId,
  runtimeToolTypesAfterHiddenSkillGate,
} from './hidden-runtime-skills';
import {
  subagentRuntimeSkillContent,
  subagentRuntimeSkillId,
} from './subagent-runtime-skill';

test('hidden runtime policy gates only the configured tool actions', () => {
  assert.equal(requiredHiddenRuntimeSkillId('browserCode', { code: 'nodeRepl.write(1)' }, 'free'), browserCodeRuntimeSkillId);
  assert.equal(requiredHiddenRuntimeSkillId('browserCode', { code: 'nodeRepl.write(1)' }, 'restricted'), browserApiRuntimeSkillId);
  assert.equal(requiredHiddenRuntimeSkillId('readBrowserState', {}), undefined);

  for (const action of ['plan', 'generate', 'edit', 'render', 'convert', 'jsApi', 'unoApi']) {
    assert.equal(requiredHiddenRuntimeSkillId('file', { action }), fileArtifactRuntimeSkillId);
  }
  for (const action of ['list', 'read', 'download']) {
    assert.equal(requiredHiddenRuntimeSkillId('file', { action }), undefined);
  }

  assert.equal(requiredHiddenRuntimeSkillId('fileVisual', { action: 'index' }), fileArtifactRuntimeSkillId);
  assert.equal(requiredHiddenRuntimeSkillId('fileVisual', { action: 'read' }), fileArtifactRuntimeSkillId);
  assert.equal(requiredHiddenRuntimeSkillId('subagent', { action: 'spawn' }), subagentRuntimeSkillId);
  assert.equal(requiredHiddenRuntimeSkillId('subagent', { action: 'read' }), undefined);
});

test('successful hidden Skill reads persist across model steps only through the run-scoped set', () => {
  const traces = [{
    name: 'skill',
    input: { action: 'read', skillId: fileArtifactRuntimeSkillId },
    result: { ok: true },
  }];
  const loaded = hiddenRuntimeSkillIdsReadFromTraces(traces);
  assert.deepEqual([...loaded], [fileArtifactRuntimeSkillId]);
  assert.equal(hiddenRuntimeSkillGateResult('file', { action: 'plan' }, loaded), undefined);
  assert.ok(hiddenRuntimeSkillGateResult('subagent', { action: 'spawn' }, loaded));

  const newAgentRun = new Set<string>();
  assert.ok(hiddenRuntimeSkillGateResult('file', { action: 'plan' }, newAgentRun));
  assert.deepEqual([...hiddenRuntimeSkillIdsReadFromTraces([{
    ...traces[0],
    result: { ok: false },
  }])], []);
});

test('all tool protocols receive the same structured prerequisite failure', () => {
  const result = hiddenRuntimeSkillGateResult('subagent', { action: 'spawn' }, new Set());
  assert.ok(result);
  assert.equal(result.ok, false);
  assert.equal(result.requiredSkillId, subagentRuntimeSkillId);
  assert.match(result.requiredNextAction || '', /skill action=read/);
  assert.deepEqual(JSON.parse(result.actual), {
    ok: false,
    requiredSkillId: subagentRuntimeSkillId,
    requiredNextAction: result.requiredNextAction,
  });
});

test('browserCode is not advertised until the mode-specific runtime Skill is loaded', () => {
  const tools = ['readBrowserState', 'skill', 'browserCode', 'file'];
  assert.deepEqual(runtimeToolTypesAfterHiddenSkillGate(tools, new Set(), 'restricted'), [
    'readBrowserState', 'skill', 'file',
  ]);
  assert.deepEqual(runtimeToolTypesAfterHiddenSkillGate(
    tools,
    new Set([browserApiRuntimeSkillId]),
    'restricted',
  ), tools);
  assert.deepEqual(runtimeToolTypesAfterHiddenSkillGate(
    tools,
    new Set([browserCodeRuntimeSkillId]),
    'restricted',
  ), ['readBrowserState', 'skill', 'file']);
});

test('hidden built-in Skills are directly readable without entering the user Skill catalog', () => {
  assert.equal(hiddenRuntimeSkillContent(browserApiRuntimeSkillId), browserApiRuntimeSkillContent);
  assert.equal(hiddenRuntimeSkillContent(fileArtifactRuntimeSkillId), fileArtifactRuntimeSkillContent);
  assert.equal(hiddenRuntimeSkillContent(subagentRuntimeSkillId), subagentRuntimeSkillContent);
  assert.equal(hiddenRuntimeSkillContent('user-managed-skill'), undefined);
  const freeSummaries = hiddenRuntimeSkillSummariesForMode('free');
  assert.match(freeSummaries, /system-browser-code-runtime/);
  assert.doesNotMatch(freeSummaries, /system-browser-api-runtime/);
  assert.match(freeSummaries, /system-file-artifact-runtime/);
  assert.match(freeSummaries, /system-subagent-runtime/);

  const restrictedSummaries = hiddenRuntimeSkillSummariesForMode('restricted');
  assert.match(restrictedSummaries, /system-browser-api-runtime/);
  assert.doesNotMatch(restrictedSummaries, /system-browser-code-runtime/);
  assert.match(restrictedSummaries, /system-file-artifact-runtime/);
  assert.match(restrictedSummaries, /system-subagent-runtime/);
});

test('file and subagent runtime Skills carry the state, QA, and browser ownership contracts', () => {
  assert.match(fileArtifactRuntimeSkillContent, /list.*read.*download/);
  assert.match(fileArtifactRuntimeSkillContent, /plan.*generate.*edit.*render/);
  assert.match(fileArtifactRuntimeSkillContent, /documentId/);
  assert.match(fileArtifactRuntimeSkillContent, /revision/);
  assert.match(fileArtifactRuntimeSkillContent, /sourceDigest/);
  assert.match(fileArtifactRuntimeSkillContent, /renderedDigest/);
  assert.match(fileArtifactRuntimeSkillContent, /UNO and JavaScript modes/);
  assert.match(fileArtifactRuntimeSkillContent, /transactionally/);
  assert.match(fileArtifactRuntimeSkillContent, /visualQaDigest equals renderedDigest/);
  assert.match(fileArtifactRuntimeSkillContent, /Continue the original document workflow/);
  assert.match(fileArtifactRuntimeSkillContent, /## file API signatures/);
  assert.match(fileArtifactRuntimeSkillContent, /declare function file\(input: FileInput\)/);
  assert.match(fileArtifactRuntimeSkillContent, /type FileLineEdit/);
  assert.match(fileArtifactRuntimeSkillContent, /action: "generate"/);
  assert.match(fileArtifactRuntimeSkillContent, /## fileVisual API signatures and examples/);
  assert.match(fileArtifactRuntimeSkillContent, /declare function fileVisual\(input: FileVisualInput\)/);
  assert.match(fileArtifactRuntimeSkillContent, /screenshot-0001/);

  assert.match(subagentRuntimeSkillContent, /independent and useful in parallel/);
  assert.match(subagentRuntimeSkillContent, /same interactive page/);
  assert.match(subagentRuntimeSkillContent, /Cookie-backed login state/);
  assert.match(subagentRuntimeSkillContent, /own page or tab/);
  assert.match(subagentRuntimeSkillContent, /must not steal foreground focus/);
  assert.match(subagentRuntimeSkillContent, /returned order/);
  assert.match(subagentRuntimeSkillContent, /parent Agent alone/);
  assert.match(subagentRuntimeSkillContent, /surface id/);
  assert.match(subagentRuntimeSkillContent, /## Host tool boundary and API signatures/);
  assert.match(subagentRuntimeSkillContent, /declare function subagent\(input: SubagentInput\)/);
  assert.match(subagentRuntimeSkillContent, /type SpawnActual/);
  assert.match(subagentRuntimeSkillContent, /type ReadActual/);
  assert.match(subagentRuntimeSkillContent, /## Spawn examples/);
  assert.match(subagentRuntimeSkillContent, /## Ordered read examples/);
});
