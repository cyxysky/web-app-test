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
  assert.match(rules, /multiple bounded state-changing operations/i);
  assert.match(rules, /beginning of every new or resumed user request/i);
  assert.match(rules, /browser\.user\.openTabs/);
  assert.match(rules, /active-tab and tab-group metadata/);
  assert.match(rules, /separate read-only/i);
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
  assert.match(rules, /incremental domChanges/);
  assert.match(rules, /added\/updated\/removed/);
  assert.match(rules, /extra contains mounted non-actionable records/);
  assert.match(rules, /not a full-page snapshot/);
  assert.match(rules, /AX tree rooted at the current page body/);
  assert.match(rules, /never an automatic axTree/);
  assert.match(rules, /data-testid/);
  assert.match(rules, /stable data-\*/);
  assert.match(rules, /unique exact href/);
  assert.match(rules, /targeted Playwright or read-only DOM inspection/);
  assert.match(rules, /code\/page console deltas/);
  assert.match(rules, /Never translate, invent, or replace returned attributes/);
  assert.match(rules, /never infer a control type, interaction sequence, or completion state/i);
  assert.match(rules, /force: true is forbidden/);
  assert.match(rules, /factory methods automatically exclude matches that do not currently exist as rendered elements/);
  assert.match(rules, /full actionability checks on every remaining candidate/);
  assert.match(rules, /exactly one candidate passes/);
  assert.match(rules, /action-specific Playwright trial/);
  assert.match(rules, /ancestor has pointer-events:none/);
  assert.match(rules, /multiple bounded state-changing operations/);
  assert.doesNotMatch(rules, /ONE ACTION|at most one state-changing operation/);
  assert.match(rules, /first\(\), last\(\), and nth\(\) are allowed/);
  assert.doesNotMatch(rules, /clickByUid/);
  assert.match(rules, /no UID-click tool/);
  assert.match(rules, /do not retry or fall back to CUA/i);
  assert.match(rules, /two separate model steps/);
  assert.match(rules, /Same-cell screenshot-and-click is forbidden/);
  assert.match(rules, /DOM redraw/);
  assert.match(rules, /Playwright delivery alone does not prove business success/);
  assert.match(rules, /no specific verification helper is mandatory/);
  assert.match(rules, /Every Playwright Locator\/Page element action/);
  assert.match(rules, /display:none/);
  assert.doesNotMatch(rules, /page\.verifyState|ACTION_EXECUTED_VERIFICATION_REQUIRED|verification-only/);
  assert.doesNotMatch(rules, /Date\/time pickers|cascaders|dropdowns, and menus/);
  assert.doesNotMatch(rules, /function body|takeSnapshot|searchSnapshot|page\.uid|compatibility facade|per-operation tool protocol/);
  assert.doesNotMatch(rules, /postActionObservation|dialogs\/notices\/focus/);
  assert.doesNotMatch(rules, /FRESH_OBSERVATION_REQUIRED|shared \[page-state\] observation|mandatory pre-action freshness gate/);
});

test('screenshot guidance stays inside browserCode', () => {
  assert.match(combinedRules(true), /nodeRepl\.emitImage/);
  assert.match(combinedRules(true), /page\.screenshot/);
  assert.doesNotMatch(combinedRules(false), /takeScreenshot/);
  assert.match(combinedRules(false), /browserCode for inspection and browser operations/);
});

test('browser chat keeps browserCode capabilities in a compact non-duplicated rule set', () => {
  const rules = browserChatCodeRules(true).join('\n');
  assert.equal(browserChatCodeRules(true).length, 8);
  assert.match(rules, /real Playwright page\/context/);
  assert.match(rules, /persistent top-level-await JavaScript kernel/);
  assert.match(rules, /incremental domChanges/);
  assert.match(rules, /never an automatic axTree/);
  assert.match(rules, /separate read-only cell/i);
  assert.match(rules, /browser\.user\.openTabs/);
  assert.match(rules, /active tab, its group, current page, and relevant rendered state/i);
  assert.match(rules, /added\/updated\/removed/);
  assert.match(rules, /not a full snapshot/);
  assert.match(rules, /never translate or invent a selector/);
  assert.match(rules, /never infer a control type or interaction sequence/);
  assert.match(rules, /choose a stable parent/i);
  assert.match(rules, /automatically remove hidden and zero-rectangle matches/);
  assert.match(rules, /trial to every remaining candidate/);
  assert.match(rules, /exactly one candidate passes all stages/);
  assert.match(rules, /first\(\), last\(\), and nth\(\) are allowed/);
  assert.match(rules, /Multiple bounded operations may run in the same cell/);
  assert.doesNotMatch(rules, /Perform exactly one state-changing operation/);
  assert.doesNotMatch(rules, /clickByUid/);
  assert.match(rules, /no UID-click tool/);
  assert.match(rules, /force:true/);
  assert.match(rules, /explicitly run page\.domSnapshot\(\)\/targeted Playwright reads/);
  assert.doesNotMatch(rules, /page\.verifyState|ACTION_EXECUTED_VERIFICATION_REQUIRED|verification-only/);
  assert.doesNotMatch(rules, /Date\/time pickers|cascaders|dropdowns, and menus/);
  assert.doesNotMatch(rules, /activeSurface|shared \[page-state\]|low-level observation object is returned/);
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
  assert.match(visualRules, /fresh inspect result/);
  assert.match(visualRules, /inspect again instead of acting/);
  assert.match(visualRules, /only kind="ref"/);
  assert.match(visualRules, /does not compare element text, attributes, or a semantic fingerprint/);
  assert.match(visualRules, /Playwright actionability/);
  assert.match(visualRules, /verification\.status="failed"/);
  assert.match(visualRules, /activeSurface/);
  assert.match(visualRules, /virtualized="possible"/);
  assert.match(visualRules, /backend scans the virtual list/);
  assert.doesNotMatch(visualRules, /kind="semantic"/);
  assert.doesNotMatch(browserChatDomRules(false).join('\n'), /takeScreenshot/);
});
