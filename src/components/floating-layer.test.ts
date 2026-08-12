import assert from 'node:assert/strict';
import test from 'node:test';
import { floatingLayerZIndex } from './FloatingLayer';

test('keeps ordinary floating layers on the shared base layer', () => {
  assert.equal(floatingLayerZIndex({ closest: () => null }), undefined);
});

test('raises floating layers triggered inside a modal above the modal overlay', () => {
  assert.equal(floatingLayerZIndex({ closest: () => ({}) as Element }), 2147483003);
});
