import assert from 'node:assert/strict';
import test from 'node:test';
import { withToolFailureGuidance } from './runtime-tool-failure-guidance';

test('every failed runtime tool result receives a concrete required next action', () => {
  const plain = withToolFailureGuidance('file', { ok: false, actual: 'revision mismatch' });
  assert.ok(plain.requiredNextAction);
  assert.match(plain.actual, /Required next action:/);

  const structured = withToolFailureGuidance('readBrowserState', {
    ok: false,
    actual: JSON.stringify({ error: 'browser unavailable' }),
  });
  assert.ok(structured.requiredNextAction);
  assert.equal(JSON.parse(structured.actual).requiredNextAction, structured.requiredNextAction);
});

test('actionability guidance names the exact blocking surface id and requests inspection', () => {
  const result = withToolFailureGuidance('browserCode', {
    ok: false,
    actual: 'ACTIONABILITY_FAILED: covered by div#backdrop; coveredBySurfaceId=surface-42',
  });
  assert.match(result.requiredNextAction || '', /surface id=surface-42/);
  assert.match(result.requiredNextAction || '', /page\.activeSurface\(\)/);
  assert.match(result.requiredNextAction || '', /只读 browserCode/);
});

test('successful runtime tool results remain unchanged', () => {
  const result = { ok: true, actual: 'done' } as const;
  assert.equal(withToolFailureGuidance('browserCode', result), result);
});
