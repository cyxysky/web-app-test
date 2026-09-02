import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserCodeRuntimeSkillContent,
  browserCodeRuntimeSkillId,
  browserCodeRuntimeSkillSummary,
} from '@webpilot/capability-browser/runtime-skill';

test('hidden browser code-action runtime Skill documents the complete required operating sequence', () => {
  assert.equal(browserCodeRuntimeSkillId, 'system-browser-code-runtime');
  assert.match(browserCodeRuntimeSkillSummary, /<system_skill>/);
  assert.match(browserCodeRuntimeSkillSummary, /<required>true<\/required>/);
  assert.match(browserCodeRuntimeSkillContent, /skill\(\{ action: "read"/);
  assert.match(browserCodeRuntimeSkillContent, /includes its complete result in `prerequisiteResults`/);
  assert.match(browserCodeRuntimeSkillContent, /still executes the supplied code in the same tool call/);
  assert.match(browserCodeRuntimeSkillContent, /browser\.tabs\.new\("https:\/\/example\.com\/"\)/);
  assert.match(browserCodeRuntimeSkillContent, /browser\.tabs\.new\(\{ url: "https:\/\/example\.com\/" \}\)/);
  assert.match(browserCodeRuntimeSkillContent, /page\.activeSurface\(\)/);
  assert.match(browserCodeRuntimeSkillContent, /page\.getByUid\(uid\)/);
  assert.match(browserCodeRuntimeSkillContent, /STALE_DOM_EVIDENCE/);
  assert.match(browserCodeRuntimeSkillContent, /coveredBySurfaceId/);
  assert.doesNotMatch(browserCodeRuntimeSkillContent, /requiredNextAction/);
  assert.match(browserCodeRuntimeSkillContent, /nodeRepl\.write/);
  assert.match(browserCodeRuntimeSkillContent, /attachmentVault\.setInputFiles/);
  assert.match(browserCodeRuntimeSkillContent, /credentialVault\.fill/);
  assert.match(browserCodeRuntimeSkillContent, /## Runtime API reference/);
  assert.match(browserCodeRuntimeSkillContent, /## Host tool boundary/);
  assert.match(browserCodeRuntimeSkillContent, /browser\(\{ action: "state", reason \}\)/);
  assert.match(browserCodeRuntimeSkillContent, /browser\(\{ action: "code", reason, code, maxOutputChars\? \}\)/);
  assert.match(browserCodeRuntimeSkillContent, /failureCategory\?/);
  assert.match(browserCodeRuntimeSkillContent, /Promise<RuntimeTab>/);
  assert.match(browserCodeRuntimeSkillContent, /page\.expectNavigation\(action, options\?\)/);
  assert.match(browserCodeRuntimeSkillContent, /page\.verifyState\(input\)/);
  assert.match(browserCodeRuntimeSkillContent, /setTextSelection\(locator, spec\)/);
  assert.match(browserCodeRuntimeSkillContent, /Custom dropdown that stays open/);
  assert.match(browserCodeRuntimeSkillContent, /Date\/time picker with an explicit confirmation/);
  assert.match(browserCodeRuntimeSkillContent, /authorizes multiple coordinate\/CUA clicks/);
  assert.match(browserCodeRuntimeSkillContent, /screenshot-to-coordinate interaction is the visual fallback/i);
  assert.match(browserCodeRuntimeSkillContent, /Do not keep probing selectors indefinitely/);
  assert.match(browserCodeRuntimeSkillContent, /In the next model step/);
  assert.match(browserCodeRuntimeSkillContent, /controls that are genuinely visible but unavailable through usable DOM evidence/i);
  assert.match(browserCodeRuntimeSkillContent, /non-visual model/);
  assert.match(browserCodeRuntimeSkillContent, /var menuRect = await menuTrigger\.boundingBox\(\)/);
  assert.match(browserCodeRuntimeSkillContent, /Rect-derived clicks must stay inside the recorded rect/);
  assert.match(browserCodeRuntimeSkillContent, /Do not catch an exception and write/);
  assert.match(browserCodeRuntimeSkillContent, /top-level result object with `ok: false` is treated as a failed tool result/);
  assert.match(browserCodeRuntimeSkillContent, /agent\.state\.set/);
  assert.match(browserCodeRuntimeSkillContent, /survives JavaScript-kernel recycling/i);
  assert.match(browserCodeRuntimeSkillContent, /optimistic concurrency/i);
  assert.match(browserCodeRuntimeSkillContent, /### Data collection priority/);
  assert.match(browserCodeRuntimeSkillContent, /prefer the current application's authenticated HTTP API/i);
  assert.match(browserCodeRuntimeSkillContent, /context\.request\.get\/post/);
  assert.match(browserCodeRuntimeSkillContent, /fall back to Playwright locators/i);
  assert.match(browserCodeRuntimeSkillContent, /does not authorize create, update, delete/i);
  assert.match(browserCodeRuntimeSkillContent, /```js[\s\S]+nodeRepl\.write/);
});
