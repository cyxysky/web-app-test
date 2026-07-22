import assert from 'node:assert/strict';
import test from 'node:test';
import { browserActionRules, browserCodeRules, screenshotObservationRule } from './runtime-prompt-rules';

function combinedRules(screenshotAvailable: boolean) {
  return [
    ...browserCodeRules(),
    ...browserActionRules(screenshotAvailable),
    screenshotObservationRule(screenshotAvailable),
  ].join('\n');
}

test('browserCode rules describe direct Playwright execution with bounded operations', () => {
  const rules = combinedRules(true);
  assert.match(rules, /only browser inspection and operation tool/);
  assert.match(rules, /ordinary JavaScript cell/);
  assert.match(rules, /real Playwright page and context objects/);
  assert.match(rules, /ordinary Playwright APIs directly/);
  assert.match(rules, /locator\.selectOption/);
  assert.match(rules, /page\.evaluate/);
  assert.match(rules, /page\.domSnapshot/);
  assert.match(rules, /nodeRepl\.write/);
  assert.match(rules, /bindings persist across calls/);
  assert.match(rules, /no whole-cell deadline/);
  assert.match(rules, /default to 3000ms/);
  assert.match(rules, /navigation defaults to 30000ms/);
  assert.match(rules, /nodeRepl\.emitImage/);
  assert.match(rules, /browser\.tabs\.list/);
  assert.match(rules, /credentialVault\.fill/);
  assert.match(rules, /never read the filled field value/);
  assert.doesNotMatch(rules, /function body|takeSnapshot|searchSnapshot|page\.uid|compatibility facade|per-operation tool protocol/);
});

test('screenshot guidance stays inside browserCode', () => {
  assert.match(combinedRules(true), /nodeRepl\.emitImage/);
  assert.match(combinedRules(true), /page\.screenshot/);
  assert.doesNotMatch(combinedRules(false), /takeScreenshot/);
  assert.match(combinedRules(false), /browserCode for inspection and browser operations/);
});
