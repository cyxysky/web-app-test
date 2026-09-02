import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyRuntimeToolFailure,
  withToolFailureGuidance,
} from './runtime-tool-failure-guidance';

test('failed runtime results retain a category without requiredNextAction metadata', () => {
  const plain = withToolFailureGuidance('file', { ok: false, actual: 'revision mismatch' });
  assert.equal(plain.failureCategory, 'file-workflow');
  assert.match(plain.actual, /Failure category: file-workflow/);
  assert.doesNotMatch(plain.actual, /Required next action:/i);

  const structured = withToolFailureGuidance('browser', {
    ok: false,
    actual: JSON.stringify({ error: 'browser unavailable' }),
  });
  const parsed = JSON.parse(structured.actual) as Record<string, unknown>;
  assert.equal(parsed.failureCategory, 'browser-unavailable');
  assert.equal('requiredNextAction' in parsed, false);
  assert.equal('requiredNextAction' in structured, false);
});

test('failure classifier preserves useful failure categories', () => {
  assert.equal(classifyRuntimeToolFailure('browser', {
    actual: 'ACTIONABILITY_FAILED: covered by div#backdrop; coveredBySurfaceId=surface-42',
  }), 'actionability');
  assert.equal(classifyRuntimeToolFailure('browser', {
    actual: JSON.stringify({ error: 'page.screenshot timed out after 30000ms' }),
  }), 'screenshot-timeout');
  assert.equal(classifyRuntimeToolFailure('browser', {
    actual: 'Execution context was destroyed, most likely because of a navigation',
  }), 'execution-context');
  assert.equal(classifyRuntimeToolFailure('browser', {
    actual: 'TypeError: Converting circular structure to JSON',
  }), 'serialization');
  assert.equal(classifyRuntimeToolFailure('browser', {
    actual: JSON.stringify({ ok: false, result: { ok: false }, error: 'browserCode returned a top-level { ok: false } result.' }),
  }), 'reported-failure');
  assert.equal(classifyRuntimeToolFailure('browser', {
    actual: 'BUSINESS_STATE_VERIFICATION_FAILED: Save did not produce a confirmation',
  }), 'verification');
  assert.equal(classifyRuntimeToolFailure('browser', {
    actual: 'Error: agent.state.set input must be an object.',
  }), 'invalid-input');
  assert.equal(classifyRuntimeToolFailure('browser', {
    actual: 'Error: agent.state revision conflict for key "task.progress": expected 1, current 2.',
  }), 'state-conflict');
});

test('successful runtime tool results remain unchanged', () => {
  const result = { ok: true, actual: 'done' } as const;
  assert.equal(withToolFailureGuidance('browser', result), result);
});
