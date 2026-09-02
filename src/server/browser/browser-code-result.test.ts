import assert from 'node:assert/strict';
import test from 'node:test';
import { browserCodeReportedFailure } from '@webpilot/capability-browser/node';

test('browserCode explicit top-level ok false is a semantic execution failure', () => {
  assert.equal(browserCodeReportedFailure({ ok: false, error: 'capture failed' }), 'capture failed');
  assert.equal(browserCodeReportedFailure({ ok: false, error: { name: 'TimeoutError', message: 'timed out' } }), 'timed out');
  assert.equal(
    browserCodeReportedFailure({ ok: false }),
    'browserCode returned a top-level { ok: false } result.',
  );
});

test('browserCode observed negative facts do not become execution failures', () => {
  assert.equal(browserCodeReportedFailure({ available: false }), undefined);
  assert.equal(browserCodeReportedFailure({ ok: true, matched: false }), undefined);
  assert.equal(browserCodeReportedFailure([{ ok: false }]), undefined);
  assert.equal(browserCodeReportedFailure(false), undefined);
});
