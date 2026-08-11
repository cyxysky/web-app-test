import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedQueryInteger } from './api-request';

test('bounded query integers use fallback for missing, blank, and invalid values', () => {
  const bounds = { fallback: 10, max: 100 };
  assert.equal(boundedQueryInteger(null, bounds), 10);
  assert.equal(boundedQueryInteger('', bounds), 10);
  assert.equal(boundedQueryInteger('   ', bounds), 10);
  assert.equal(boundedQueryInteger('invalid', bounds), 10);
  assert.equal(boundedQueryInteger('25', bounds), 25);
  assert.equal(boundedQueryInteger('1000', bounds), 100);
});
