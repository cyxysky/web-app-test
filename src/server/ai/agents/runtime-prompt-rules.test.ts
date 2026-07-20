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

test('native selects require selectOption instead of mouse or keyboard selection', () => {
  const rules = combinedRules(true);

  assert.match(rules, /MUST call selectOption directly/);
  assert.match(rules, /Never click the select first/);
  assert.match(rules, /never use keyboard letters\/ArrowUp\/ArrowDown\/Enter/i);
});

test('models without image input receive snapshot-only guidance', () => {
  const rules = combinedRules(false);

  assert.doesNotMatch(rules, /takeScreenshot/);
  assert.match(rules, /takeSnapshot/);
  assert.match(rules, /fresh UID/);
  assert.match(rules, /Never invent a room id/);
  assert.match(rules, /mode="full"/);
  assert.match(rules, /mode="text"/);
  assert.match(rules, /mode="changes"/);
  assert.match(rules, /nextCursor/);
  assert.doesNotMatch(rules, /mode="actionable"/);
});

test('snapshot rules distinguish frozen pagination from page scrolling and overflow', () => {
  const rules = combinedRules(true);

  assert.match(rules, /ALL text.*complete full DOM/i);
  assert.match(rules, /including offscreen text/i);
  assert.match(rules, /never scroll for snapshot pagination/i);
  assert.match(rules, /pure read that never scrolls, consumes the mutation queue, or changes snapshot pagination/i);
  assert.match(rules, /domChanges\.overflow.*MutationObserver/i);
  assert.match(rules, /NEVER means there is more page content below/i);
  assert.match(rules, /child-Agent tasks/i);
});
