import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserCodeRuntimeSkillContent,
  browserCodeRuntimeSkillId,
  browserCodeRuntimeSkillSummary,
  browserCodeRuntimeSkillWasRead,
  browserCodeToolRequiresRuntimeSkill,
} from './browser-code-runtime-skill';

test('hidden browserCode runtime Skill documents the complete required operating sequence', () => {
  assert.equal(browserCodeRuntimeSkillId, 'system-browser-code-runtime');
  assert.match(browserCodeRuntimeSkillSummary, /<system_skill>/);
  assert.match(browserCodeRuntimeSkillSummary, /<required>true<\/required>/);
  assert.match(browserCodeRuntimeSkillContent, /skill\(\{ action: "read"/);
  assert.match(browserCodeRuntimeSkillContent, /Call `readBrowserState` in a separate model step/);
  assert.match(browserCodeRuntimeSkillContent, /browser\.tabs\.new\("https:\/\/example\.com\/"\)/);
  assert.match(browserCodeRuntimeSkillContent, /browser\.tabs\.new\(\{ url: "https:\/\/example\.com\/" \}\)/);
  assert.match(browserCodeRuntimeSkillContent, /page\.activeSurface\(\)/);
  assert.match(browserCodeRuntimeSkillContent, /coveredBySurfaceId/);
  assert.match(browserCodeRuntimeSkillContent, /requiredNextAction/);
  assert.match(browserCodeRuntimeSkillContent, /nodeRepl\.write/);
  assert.match(browserCodeRuntimeSkillContent, /attachmentVault\.setInputFiles/);
  assert.match(browserCodeRuntimeSkillContent, /credentialVault\.fill/);
});

test('browserCode is gated until the hidden runtime Skill has been read', () => {
  assert.equal(browserCodeToolRequiresRuntimeSkill('browserCode', false), true);
  assert.equal(browserCodeToolRequiresRuntimeSkill('browserCode', true), false);
  assert.equal(browserCodeToolRequiresRuntimeSkill('readBrowserState', false), false);
  assert.equal(browserCodeToolRequiresRuntimeSkill('skill', false), false);
  assert.equal(browserCodeRuntimeSkillWasRead([]), false);
  assert.equal(browserCodeRuntimeSkillWasRead([{
    name: 'skill',
    input: { skillId: browserCodeRuntimeSkillId },
    result: { ok: true },
  }]), true);
  assert.equal(browserCodeRuntimeSkillWasRead([{
    name: 'skill',
    input: { skillId: browserCodeRuntimeSkillId },
    result: { ok: false },
  }]), false);
});
