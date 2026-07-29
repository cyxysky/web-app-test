import assert from 'node:assert/strict';
import test from 'node:test';
import { browserActionRules, browserChatCodeRules, browserChatDomRules, browserCodeRules, screenshotObservationRule } from './runtime-prompt-rules';

function combinedRules(screenshotAvailable: boolean) {
  return [
    ...browserCodeRules(),
    ...browserActionRules(screenshotAvailable),
    screenshotObservationRule(screenshotAvailable),
  ].join('\n');
}

test('browserCode rules describe direct Playwright execution with bounded operations', () => {
  const rules = combinedRules(true);
  assert.match(rules, /primary browser inspection and operation tool/);
  assert.match(rules, /ordinary JavaScript cell/);
  assert.match(rules, /real Playwright page and context objects/);
  assert.match(rules, /ordinary Playwright APIs directly/);
  assert.match(rules, /Before every state-changing action/);
  assert.match(rules, /current page, active dialog or layer/);
  assert.match(rules, /do not act from assumptions or old history/);
  assert.match(rules, /locator\.selectOption/);
  assert.match(rules, /page\.evaluate/);
  assert.match(rules, /page\.domSnapshot/);
  assert.match(rules, /nodeRepl\.write/);
  assert.match(rules, /bindings persist across calls/);
  assert.match(rules, /infrastructure watchdog/);
  assert.match(rules, /default to 5000ms/);
  assert.match(rules, /navigation defaults to 30000ms/);
  assert.match(rules, /nodeRepl\.emitImage/);
  assert.match(rules, /browser\.tabs\.list/);
  assert.match(rules, /credentialVault\.fill/);
  assert.match(rules, /never read the filled field value/);
  assert.match(rules, /bounded postActionObservation/);
  assert.match(rules, /code\/page console deltas/);
  assert.match(rules, /Call page\.domSnapshot\(\) explicitly/);
  assert.match(rules, /force: true is forbidden/);
  assert.match(rules, /filter\(\{ visible: true \}\)/);
  assert.match(rules, /require count\(\) === 1/);
  assert.match(rules, /Never use first\(\), last\(\), or nth\(\)/);
  assert.doesNotMatch(rules, /clickByUid/);
  assert.match(rules, /no UID-click tool/);
  assert.match(rules, /do not fall back to CUA/);
  assert.match(rules, /two separate model steps/);
  assert.match(rules, /Same-cell screenshot-and-click is forbidden/);
  assert.match(rules, /DOM redraw/);
  assert.match(rules, /Playwright success does not equal business success/);
  assert.doesNotMatch(rules, /function body|takeSnapshot|searchSnapshot|page\.uid|compatibility facade|per-operation tool protocol/);
});

test('screenshot guidance stays inside browserCode', () => {
  assert.match(combinedRules(true), /nodeRepl\.emitImage/);
  assert.match(combinedRules(true), /page\.screenshot/);
  assert.doesNotMatch(combinedRules(false), /takeScreenshot/);
  assert.match(combinedRules(false), /browserCode for inspection and browser operations/);
});

test('browser chat keeps browserCode capabilities in a compact non-duplicated rule set', () => {
  const rules = browserChatCodeRules(true).join('\n');
  assert.equal(browserChatCodeRules(true).length, 7);
  assert.match(rules, /real Playwright page\/context/);
  assert.match(rules, /persistent top-level-await JavaScript kernel/);
  assert.match(rules, /bounded postActionObservation/);
  assert.match(rules, /explicit page\.domSnapshot\(\)/);
  assert.match(rules, /filter visible candidates and require exactly one/);
  assert.match(rules, /understand exactly what the user wants/);
  assert.match(rules, /if anything is uncertain, inspect instead of acting/i);
  assert.doesNotMatch(rules, /clickByUid/);
  assert.match(rules, /no UID-click tool/);
  assert.match(rules, /force:true/);
  assert.match(rules, /verify business state after every change/);
  assert.match(rules, /nodeRepl\.emitImage/);
  assert.match(rules, /next cell/);
  assert.match(rules, /context\.pages/);
  assert.match(rules, /credentialVault\.fill/);
});

test('DOM mode requests screenshots explicitly instead of receiving automatic captures', () => {
  const visualRules = browserChatDomRules(true).join('\n');
  assert.match(visualRules, /No screenshot is attached automatically/);
  assert.match(visualRules, /call takeScreenshot/);
  assert.match(visualRules, /end that model step/);
  assert.match(visualRules, /confirm from a fresh inspect result/);
  assert.match(visualRules, /inspect again instead of acting/);
  assert.doesNotMatch(browserChatDomRules(false).join('\n'), /takeScreenshot/);
});
