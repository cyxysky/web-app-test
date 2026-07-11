import assert from 'node:assert/strict';
import test from 'node:test';
import { browserActionRules, screenshotObservationRule, snapshotHardRules } from './runtime-prompt-rules';

function combinedRules(screenshotAvailable: boolean) {
  return [
    ...snapshotHardRules(screenshotAvailable),
    ...browserActionRules(screenshotAvailable),
    screenshotObservationRule(screenshotAvailable),
  ].join('\n');
}

test('screenshot-capable models receive the screenshot tool guidance', () => {
  assert.match(combinedRules(true), /takeScreenshot/);
});

test('models without image input receive snapshot-only guidance', () => {
  const rules = combinedRules(false);

  assert.doesNotMatch(rules, /takeScreenshot/);
  assert.match(rules, /takeSnapshot/);
  assert.match(rules, /fresh UID/);
  assert.match(rules, /Never invent a room id/);
  assert.match(rules, /Never conclude.*absent.*truncated snapshot slice/);
});
