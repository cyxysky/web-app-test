import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cloneRuntimeObservationStore,
  decodeRuntimeObservationCursor,
  encodeRuntimeObservationCursor,
  readRuntimeObservation,
  restoreRuntimeObservationStore,
  storeRuntimeObservation,
  type RuntimeObservationStore,
} from './runtime-observation';

test('readRuntimeObservation requires an explicit refreshed store entry', () => {
  const store: RuntimeObservationStore = new Map();
  const result = readRuntimeObservation(store, 'run-1');

  assert.equal(result.ok, false);
  assert.match(String(result.actual), /refresh:true/);
  assert.equal(store.size, 0);
});

test('runtime observation cursors round-trip generation view and index', () => {
  const cursor = encodeRuntimeObservationCursor({ generation: 3, index: 120, view: 'actions' });

  assert.deepEqual(decodeRuntimeObservationCursor(cursor), { generation: 3, index: 120, view: 'actions' });
  assert.equal(decodeRuntimeObservationCursor('not-json'), undefined);
});

test('storeRuntimeObservation advances generation only when storing a new page state', () => {
  const store: RuntimeObservationStore = new Map();

  const first = storeRuntimeObservation(store, 'run-1', 'readObservation', 'first page');
  const second = storeRuntimeObservation(store, 'run-1', 'readObservation', 'second page');
  const read = readRuntimeObservation(store, 'run-1', 0, 10000);

  assert.equal(first.generation, 1);
  assert.equal(second.generation, 2);
  assert.equal(second.defaultType, 'actions');
  assert.equal(read.ok, true);
  assert.match(String(read.actual), /generation 2/);
  assert.match(String(read.actual), /second page/);
});

test('storeRuntimeObservation exposes previous-to-current changes view', () => {
  const store: RuntimeObservationStore = new Map();

  const first = storeRuntimeObservation(store, 'run-1', 'readObservation', 'first page', {
    defaultType: 'actions',
    actions: '<button node_id=1 data-ai-interactive="true">Open</button>\n<input node_id=2 value="old" data-ai-interactive="true" />',
    text: 'Old value\nShared text',
    tree: '<main node_id=0>Old value</main>',
  });
  const firstRead = readRuntimeObservation(store, 'run-1', 0, 10000, 'changes');

  assert.equal(first.generation, 1);
  assert.equal(firstRead.ok, true);
  assert.match(String(firstRead.actual), /baseline snapshot/);

  const second = storeRuntimeObservation(store, 'run-1', 'readObservation', 'second page', {
    defaultType: 'actions',
    actions: '<button node_id=1 data-ai-interactive="true">Open</button>\n<input node_id=2 value="new" data-ai-interactive="true" />\n<button node_id=3 data-ai-interactive="true">Save</button>',
    text: 'New value\nShared text',
    tree: '<main node_id=0>New value</main>',
  });
  const read = readRuntimeObservation(store, 'run-1', 0, 10000, 'changes');

  assert.equal(second.generation, 2);
  assert.equal(read.ok, true);
  assert.match(String(read.actual), /Type changes/);
  assert.match(String(read.actual), /Added interactive elements/);
  assert.match(String(read.actual), /node_id=3/);
  assert.match(String(read.actual), /Changed interactive elements/);
  assert.match(String(read.actual), /node_id=2/);
  assert.match(String(read.actual), /"New value"/);
  assert.match(String(read.actual), /"Old value"/);
});

test('clone and restore keep observation stores isolated', () => {
  const source: RuntimeObservationStore = new Map();
  const target: RuntimeObservationStore = new Map();
  storeRuntimeObservation(source, 'run-1', 'readObservation', 'source page');

  const cloned = cloneRuntimeObservationStore(source);
  storeRuntimeObservation(source, 'run-1', 'readObservation', 'changed page');
  restoreRuntimeObservationStore(target, cloned);

  const read = readRuntimeObservation(target, 'run-1', 0, 10000);

  assert.equal(read.ok, true);
  assert.match(String(read.actual), /source page/);
  assert.doesNotMatch(String(read.actual), /changed page/);
});
