import assert from 'node:assert/strict';
import test from 'node:test';
import {
  domObservationPageStarts,
  encodeDomObservationCursor,
  parseDomObservationCursor,
  readDomObservationPage,
} from '@webpilot/capability-browser/node';

test('DOM observation pagination preserves cursor mode and entry boundaries', () => {
  const lines = ['alpha', 'bravo', 'charlie'];
  const pageStarts = domObservationPageStarts(lines, 11);
  const record = { id: 'snapshot-1', lines, mode: 'actionable' as const, pageMaxChars: 11, pageStarts };
  const first = readDomObservationPage(record, 0);
  assert.equal(first.content, 'alpha\nbravo');
  assert.equal(first.hasMore, true);
  assert.deepEqual(parseDomObservationCursor(first.nextCursor || ''), {
    id: 'snapshot-1',
    index: 2,
    mode: 'actionable',
  });
  assert.equal(encodeDomObservationCursor(record, 2), first.nextCursor);
  assert.equal(readDomObservationPage(record, 2).content, 'charlie');
});

test('DOM observation cursor rejects malformed and unsupported modes', () => {
  assert.equal(parseDomObservationCursor('not-base64-json'), undefined);
  const invalid = Buffer.from(JSON.stringify({ id: 'snapshot-1', index: 0, mode: 'visual' })).toString('base64url');
  assert.equal(parseDomObservationCursor(invalid), undefined);
});
