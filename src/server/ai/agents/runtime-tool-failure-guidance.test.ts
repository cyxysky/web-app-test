import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyRuntimeToolFailure,
  withToolFailureGuidance,
} from './runtime-tool-failure-guidance';

test('every failed runtime tool result receives a concrete required next action', () => {
  const plain = withToolFailureGuidance('file', { ok: false, actual: 'revision mismatch' });
  assert.ok(plain.requiredNextAction);
  assert.match(plain.actual, /Required next action:/);
  assert.equal(plain.failureCategory, 'file-workflow');

  const structured = withToolFailureGuidance('readBrowserState', {
    ok: false,
    actual: JSON.stringify({ error: 'browser unavailable' }),
  });
  assert.ok(structured.requiredNextAction);
  assert.equal(JSON.parse(structured.actual).requiredNextAction, structured.requiredNextAction);
  assert.equal(JSON.parse(structured.actual).failureCategory, 'browser-unavailable');
});

test('actionability guidance names the exact blocking surface id and requests inspection', () => {
  const result = withToolFailureGuidance('browserCode', {
    ok: false,
    actual: 'ACTIONABILITY_FAILED: covered by div#backdrop; coveredBySurfaceId=surface-42',
  });
  assert.match(result.requiredNextAction || '', /surface id=surface-42/);
  assert.match(result.requiredNextAction || '', /page\.activeSurface\(\)/);
  assert.match(result.requiredNextAction || '', /只读 browserCode/);
  assert.equal(result.failureCategory, 'actionability');
});

test('browserCode failures receive category-specific recovery', () => {
  const screenshot = withToolFailureGuidance('browserCode', {
    ok: false,
    actual: JSON.stringify({ error: 'page.screenshot timed out after 30000ms' }),
  });
  assert.equal(screenshot.failureCategory, 'screenshot-timeout');
  assert.match(screenshot.requiredNextAction || '', /不要继续尝试不同截图参数/);
  assert.match(screenshot.requiredNextAction || '', /page\.domSnapshot\(\)/);

  const context = withToolFailureGuidance('browserCode', {
    ok: false,
    actual: 'Execution context was destroyed, most likely because of a navigation',
  });
  assert.equal(context.failureCategory, 'execution-context');
  assert.match(context.requiredNextAction || '', /等待一次明确的 URL\/load state/);

  const serialization = withToolFailureGuidance('browserCode', {
    ok: false,
    actual: 'TypeError: Converting circular structure to JSON',
  });
  assert.equal(serialization.failureCategory, 'serialization');
  assert.match(serialization.requiredNextAction || '', /小型普通对象/);
});

test('failure classifier recognizes explicit cell failure and verification failure', () => {
  assert.equal(classifyRuntimeToolFailure('browserCode', {
    actual: JSON.stringify({ ok: false, result: { ok: false }, error: 'browserCode returned a top-level { ok: false } result.' }),
  }), 'reported-failure');
  assert.equal(classifyRuntimeToolFailure('browserCode', {
    actual: 'BUSINESS_STATE_VERIFICATION_FAILED: Save did not produce a confirmation',
  }), 'verification');
});

test('successful runtime tool results remain unchanged', () => {
  const result = { ok: true, actual: 'done' } as const;
  assert.equal(withToolFailureGuidance('browserCode', result), result);
});
