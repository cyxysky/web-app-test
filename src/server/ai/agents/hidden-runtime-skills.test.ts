import assert from 'node:assert/strict';
import test from 'node:test';
import { browserCodeRuntimeSkillId } from './browser-code-runtime-skill';
import {
  fileArtifactRuntimeSkillContent,
  fileArtifactRuntimeSkillId,
} from './file-artifact-runtime-skill';
import {
  hiddenRuntimeSkillContent,
  automaticallyLoadHiddenRuntimeSkill,
  hiddenRuntimeSkillIdsReadFromTraces,
  hiddenRuntimeSkillSummaries,
  requiredHiddenRuntimeSkillId,
  runtimeToolTypesWithAutomaticSkills,
} from './hidden-runtime-skills';
import {
  subagentRuntimeSkillContent,
  subagentRuntimeSkillId,
} from './subagent-runtime-skill';

test('hidden runtime policy gates only the configured tool actions', () => {
  assert.equal(requiredHiddenRuntimeSkillId('browserCode', { code: 'nodeRepl.write(1)' }), browserCodeRuntimeSkillId);
  assert.equal(requiredHiddenRuntimeSkillId('readBrowserState', {}), undefined);

  for (const action of ['list', 'read', 'download', 'plan', 'generate', 'edit', 'render', 'convert', 'jsApi', 'unoApi']) {
    assert.equal(requiredHiddenRuntimeSkillId('file', { action }), fileArtifactRuntimeSkillId);
  }

  assert.equal(requiredHiddenRuntimeSkillId('fileVisual', { action: 'index' }), fileArtifactRuntimeSkillId);
  assert.equal(requiredHiddenRuntimeSkillId('fileVisual', { action: 'read' }), fileArtifactRuntimeSkillId);
  assert.equal(requiredHiddenRuntimeSkillId('subagent', { action: 'spawn' }), subagentRuntimeSkillId);
  assert.equal(requiredHiddenRuntimeSkillId('subagent', { action: 'read' }), undefined);
});

test('explicit and automatic hidden Skill loads share the run-scoped set', () => {
  const traces = [{
    name: 'skill',
    input: { action: 'read', skillId: fileArtifactRuntimeSkillId },
    result: { ok: true },
  }];
  const loaded = hiddenRuntimeSkillIdsReadFromTraces(traces);
  assert.deepEqual([...loaded], [fileArtifactRuntimeSkillId]);
  assert.equal(automaticallyLoadHiddenRuntimeSkill('file', { action: 'plan' }, loaded), undefined);
  const subagentLoad = automaticallyLoadHiddenRuntimeSkill('subagent', { action: 'spawn' }, loaded);
  assert.ok(subagentLoad && !('ok' in subagentLoad));
  assert.equal(subagentLoad?.loadedRuntimeSkill?.id, subagentRuntimeSkillId);
  assert.equal(loaded.has(subagentRuntimeSkillId), true);

  const newAgentRun = new Set<string>();
  const fileLoad = automaticallyLoadHiddenRuntimeSkill('file', { action: 'plan' }, newAgentRun);
  assert.ok(fileLoad && !('ok' in fileLoad));
  assert.equal(fileLoad?.loadedRuntimeSkill?.id, fileArtifactRuntimeSkillId);
  assert.equal(fileLoad?.loadedRuntimeSkill?.content, fileArtifactRuntimeSkillContent);
  assert.equal(newAgentRun.has(fileArtifactRuntimeSkillId), true);
  assert.equal(automaticallyLoadHiddenRuntimeSkill('file', { action: 'read' }, newAgentRun), undefined);
  assert.deepEqual([...hiddenRuntimeSkillIdsReadFromTraces([{
    ...traces[0],
    result: { ok: false },
  }])], []);
});

test('governed tools remain advertised while their Skills load automatically on first call', () => {
  const tools = ['readBrowserState', 'skill', 'browserCode', 'file', 'fileVisual', 'subagent'];
  assert.deepEqual(runtimeToolTypesWithAutomaticSkills(tools), tools);
});

test('hidden built-in Skills are directly readable without entering the user Skill catalog', () => {
  assert.match(hiddenRuntimeSkillContent(browserCodeRuntimeSkillId) || '', /Browser Code Runtime/);
  assert.equal(hiddenRuntimeSkillContent(fileArtifactRuntimeSkillId), fileArtifactRuntimeSkillContent);
  assert.equal(hiddenRuntimeSkillContent(subagentRuntimeSkillId), subagentRuntimeSkillContent);
  assert.equal(hiddenRuntimeSkillContent('user-managed-skill'), undefined);
  const summaries = hiddenRuntimeSkillSummaries();
  assert.match(summaries, /system-browser-code-runtime/);
  assert.match(summaries, /system-file-artifact-runtime/);
  assert.match(summaries, /system-subagent-runtime/);
});

test('file and subagent runtime Skills carry the state, QA, and browser ownership contracts', () => {
  assert.match(fileArtifactRuntimeSkillContent, /list.*read.*download/);
  assert.match(fileArtifactRuntimeSkillContent, /plan.*generate.*edit.*render/);
  assert.match(fileArtifactRuntimeSkillContent, /documentId/);
  assert.match(fileArtifactRuntimeSkillContent, /exactly one current editable source/);
  assert.doesNotMatch(fileArtifactRuntimeSkillContent, /currentRevision|restoreRevision/);
  assert.match(fileArtifactRuntimeSkillContent, /Source digests are informational runtime metadata/);
  assert.match(fileArtifactRuntimeSkillContent, /renderedDigest/);
  assert.match(fileArtifactRuntimeSkillContent, /UNO and JavaScript modes/);
  assert.match(fileArtifactRuntimeSkillContent, /single editable source buffer/);
  assert.match(fileArtifactRuntimeSkillContent, /validation failures keep the exact edited source/);
  assert.match(fileArtifactRuntimeSkillContent, /visualQaDigest equals renderedDigest/);
  assert.match(fileArtifactRuntimeSkillContent, /Prefer `slide\.addChart\(\)` for standard column charts, horizontal bar charts, and doughnut charts/);
  assert.match(fileArtifactRuntimeSkillContent, /Prefer `slide\.addTable\(\)` for standard tables/);
  assert.match(fileArtifactRuntimeSkillContent, /Use `slide\.addShape\(\)` to construct KPI progress bars, mini charts, and special infographics/);
  assert.match(fileArtifactRuntimeSkillContent, /job\.writer/);
  assert.doesNotMatch(fileArtifactRuntimeSkillContent, /job\.expert\(/);
  assert.match(fileArtifactRuntimeSkillContent, /elementId/);
  assert.match(fileArtifactRuntimeSkillContent, /Continue the original document workflow/);
  assert.match(fileArtifactRuntimeSkillContent, /## file API signatures/);
  assert.match(fileArtifactRuntimeSkillContent, /declare function file\(input: FileInput\)/);
  assert.match(fileArtifactRuntimeSkillContent, /type FileLineEdit/);
  assert.match(fileArtifactRuntimeSkillContent, /action: "generate"/);
  assert.match(fileArtifactRuntimeSkillContent, /startLine\?: number/);
  assert.match(fileArtifactRuntimeSkillContent, /Proven UNO suite decisions/);
  assert.match(fileArtifactRuntimeSkillContent, /pages\/s30-risk-matrix/);
  assert.match(fileArtifactRuntimeSkillContent, /Do not use a unified patch/);
  assert.match(fileArtifactRuntimeSkillContent, /atomically replace the one editable source/);
  assert.match(fileArtifactRuntimeSkillContent, /There is no caller-visible version handshake/);
  assert.doesNotMatch(fileArtifactRuntimeSkillContent, /baseDigest/);
  assert.doesNotMatch(fileArtifactRuntimeSkillContent, /replaceExisting/);
  assert.doesNotMatch(fileArtifactRuntimeSkillContent, /restoreRevision\?:/);
  assert.doesNotMatch(fileArtifactRuntimeSkillContent, /patch\?: string/);
  assert.match(fileArtifactRuntimeSkillContent, /## fileVisual API signatures and examples/);
  assert.match(fileArtifactRuntimeSkillContent, /declare function fileVisual\(input: FileVisualInput\)/);
  assert.match(fileArtifactRuntimeSkillContent, /screenshot-0001/);
  assert.match(fileArtifactRuntimeSkillContent, /placeholder categories such as 1\/2\/3/);
  assert.match(fileArtifactRuntimeSkillContent, /known visible defect is a failed review/i);
  assert.match(fileArtifactRuntimeSkillContent, /four images is not at least five/i);
  assert.match(fileArtifactRuntimeSkillContent, /Element IDs may use Unicode/);

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
