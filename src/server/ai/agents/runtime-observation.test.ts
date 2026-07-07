import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cloneRuntimeObservationStore,
  readRuntimeObservation,
  restoreRuntimeObservationStore,
  storeRuntimeObservation,
  type RuntimeObservationStore,
} from './runtime-observation';

test('readRuntimeObservation requires an explicit getPageState-backed store entry', () => {
  const store: RuntimeObservationStore = new Map();
  const result = readRuntimeObservation(store, 'run-1');

  assert.equal(result.ok, false);
  assert.match(String(result.actual), /Call getPageState first/);
  assert.equal(store.size, 0);
});

test('storeRuntimeObservation advances generation only when storing a new page state', () => {
  const store: RuntimeObservationStore = new Map();

  const first = storeRuntimeObservation(store, 'run-1', 'getPageState', 'first page');
  const second = storeRuntimeObservation(store, 'run-1', 'getPageState', 'second page');
  const read = readRuntimeObservation(store, 'run-1', 0, 10000);

  assert.equal(first.generation, 1);
  assert.equal(second.generation, 2);
  assert.equal(second.defaultType, 'elements');
  assert.equal(read.ok, true);
  assert.match(String(read.actual), /generation 2/);
  assert.match(String(read.actual), /second page/);
});

test('clone and restore keep observation stores isolated', () => {
  const source: RuntimeObservationStore = new Map();
  const target: RuntimeObservationStore = new Map();
  storeRuntimeObservation(source, 'run-1', 'getPageState', 'source page');

  const cloned = cloneRuntimeObservationStore(source);
  storeRuntimeObservation(source, 'run-1', 'getPageState', 'changed page');
  restoreRuntimeObservationStore(target, cloned);

  const read = readRuntimeObservation(target, 'run-1', 0, 10000);

  assert.equal(read.ok, true);
  assert.match(String(read.actual), /source page/);
  assert.doesNotMatch(String(read.actual), /changed page/);
});
