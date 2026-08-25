import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserCodeRuntimeSkillContent,
  browserCodeRuntimeSkillId,
  browserCodeRuntimeSkillSummary,
} from './browser-code-runtime-skill';
import {
  browserApiRuntimeSkillContent,
  browserApiRuntimeSkillId,
  browserApiRuntimeSkillSummary,
} from './browser-api-runtime-skill';

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
  assert.match(browserCodeRuntimeSkillContent, /## Runtime API reference/);
  assert.match(browserCodeRuntimeSkillContent, /## Host tool boundary/);
  assert.match(browserCodeRuntimeSkillContent, /readBrowserState\(\{ reason \}\)/);
  assert.match(browserCodeRuntimeSkillContent, /browserCode\(\{ reason, code, maxOutputChars\? \}\)/);
  assert.match(browserCodeRuntimeSkillContent, /failureCategory\?/);
  assert.match(browserCodeRuntimeSkillContent, /Promise<RuntimeTab>/);
  assert.match(browserCodeRuntimeSkillContent, /page\.expectNavigation\(action, options\?\)/);
  assert.match(browserCodeRuntimeSkillContent, /page\.verifyState\(input\)/);
  assert.match(browserCodeRuntimeSkillContent, /setTextSelection\(locator, spec\)/);
  assert.match(browserCodeRuntimeSkillContent, /Custom dropdown that stays open/);
  assert.match(browserCodeRuntimeSkillContent, /Date\/time picker with an explicit confirmation/);
  assert.match(browserCodeRuntimeSkillContent, /authorizes multiple coordinate\/CUA clicks/);
  assert.match(browserCodeRuntimeSkillContent, /non-visual model/);
  assert.match(browserCodeRuntimeSkillContent, /var menuRect = await menuTrigger\.boundingBox\(\)/);
  assert.match(browserCodeRuntimeSkillContent, /Rect-derived clicks must stay inside the recorded rect/);
  assert.match(browserCodeRuntimeSkillContent, /Do not catch an exception and write/);
  assert.match(browserCodeRuntimeSkillContent, /top-level result object with `ok: false` is treated as a failed tool result/);
  assert.match(browserCodeRuntimeSkillContent, /```js[\s\S]+nodeRepl\.write/);
});

test('restricted browser API Skill documents the complete plain-data browser surface', () => {
  assert.equal(browserApiRuntimeSkillId, 'system-browser-api-runtime');
  assert.match(browserApiRuntimeSkillSummary, /<required>true<\/required>/);
  assert.match(browserApiRuntimeSkillContent, /only browserApi, nodeRepl, and console/i);
  assert.match(browserApiRuntimeSkillContent, /nodeRepl\.write\(value: unknown\)/);
  assert.match(browserApiRuntimeSkillContent, /does not expose nodeRepl\.emitImage/);
  assert.match(browserApiRuntimeSkillContent, /type LocatorTarget/);
  assert.match(browserApiRuntimeSkillContent, /browserApi\.tabs\.list/);
  assert.match(browserApiRuntimeSkillContent, /browserApi\.navigate/);
  assert.match(browserApiRuntimeSkillContent, /browserApi\.snapshot/);
  assert.match(browserApiRuntimeSkillContent, /browserApi\.inspect/);
  assert.match(browserApiRuntimeSkillContent, /browserApi\.read/);
  assert.match(browserApiRuntimeSkillContent, /browserApi\.act/);
  assert.match(browserApiRuntimeSkillContent, /selectOption/);
  assert.match(browserApiRuntimeSkillContent, /setInputValue/);
  assert.match(browserApiRuntimeSkillContent, /YYYY-MM-DDTHH:mm/);
  assert.match(browserApiRuntimeSkillContent, /credentialFill/);
  assert.match(browserApiRuntimeSkillContent, /attachmentId/);
  assert.match(browserApiRuntimeSkillContent, /expectPopup/);
  assert.match(browserApiRuntimeSkillContent, /expectResponse/);
  assert.match(browserApiRuntimeSkillContent, /expectDownload/);
  assert.match(browserApiRuntimeSkillContent, /dialog/);
  assert.match(browserApiRuntimeSkillContent, /browserApi\.keyboard/);
  assert.match(browserApiRuntimeSkillContent, /browserApi\.pointer/);
  assert.match(browserApiRuntimeSkillContent, /browserApi\.setTextSelection/);
  assert.match(browserApiRuntimeSkillContent, /browserApi\.screenshot/);
  assert.match(browserApiRuntimeSkillContent, /browserApi\.viewport/);
  assert.match(browserApiRuntimeSkillContent, /browserApi\.wait/);
  assert.match(browserApiRuntimeSkillContent, /browserApi\.verify/);
  assert.match(browserApiRuntimeSkillContent, /browserApi\.auditForm/);
  assert.match(browserApiRuntimeSkillContent, /multiple coordinate clicks/i);
  assert.match(browserApiRuntimeSkillContent, /non-visual model/i);
  assert.match(browserApiRuntimeSkillContent, /Never reference page, context, browser, tab/i);
  assert.match(browserApiRuntimeSkillContent, /Do not wait for networkidle/i);
  assert.match(browserApiRuntimeSkillContent, /it belongs inside target/i);
  assert.match(browserApiRuntimeSkillContent, /CSS target.*browserApi\.read/i);
  assert.match(browserApiRuntimeSkillContent, /do not retry the same target with force/i);
});
