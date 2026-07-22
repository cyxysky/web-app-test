import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cloneRuntimeObservationStore,
  compactStaleSnapshotMessages,
  decodeRuntimeObservationCursor,
  encodeRuntimeObservationCursor,
  invalidateRuntimeObservation,
  readStoredSnapshot,
  restoreRuntimeObservationStore,
  staleSnapshotText,
  storeRuntimeObservation,
  type RuntimeObservationStore,
} from './runtime-observation';

test('readStoredSnapshot requires an explicit refreshed store entry', () => {
  const store: RuntimeObservationStore = new Map();
  const result = readStoredSnapshot(store, 'run-1');

  assert.equal(result.ok, false);
  assert.match(String(result.actual), /inspect/);
  assert.equal(store.size, 0);
});

test('runtime observation cursors round-trip generation view and index', () => {
  const cursor = encodeRuntimeObservationCursor({ generation: 3, index: 120, view: 'actionable' });

  assert.deepEqual(decodeRuntimeObservationCursor(cursor), { generation: 3, index: 120, view: 'actionable' });
  assert.equal(decodeRuntimeObservationCursor('not-json'), undefined);
});

test('storeRuntimeObservation advances generation only when storing a new page state', () => {
  const store: RuntimeObservationStore = new Map();

  const first = storeRuntimeObservation(store, 'run-1', 'inspect', 'first page');
  const second = storeRuntimeObservation(store, 'run-1', 'inspect', 'second page');
  const read = readStoredSnapshot(store, 'run-1', 0, 10000);

  assert.equal(first.generation, 1);
  assert.equal(second.generation, 2);
  assert.equal(second.defaultType, 'actionable');
  assert.equal(read.ok, true);
  assert.match(String(read.actual), /generation 2/);
  assert.match(String(read.actual), /second page/);
});

test('storeRuntimeObservation exposes previous-to-current changes view', () => {
  const store: RuntimeObservationStore = new Map();

  const first = storeRuntimeObservation(store, 'run-1', 'inspect', 'first page', {
    defaultType: 'actionable',
    actionable: 'uid=1 button "Open"\nuid=2 textbox "Name" value="old"',
    text: 'Old value\nShared text',
    full: 'uid=0 main "Old value"',
  });
  const firstRead = readStoredSnapshot(store, 'run-1', 0, 10000, 'changes');

  assert.equal(first.generation, 1);
  assert.equal(firstRead.ok, true);
  assert.match(String(firstRead.actual), /baseline snapshot/);

  const second = storeRuntimeObservation(store, 'run-1', 'inspect', 'second page', {
    defaultType: 'actionable',
    actionable: 'uid=1 button "Open"\nuid=2 textbox "Name" value="new"\nuid=3 button "Save"',
    text: 'New value\nShared text',
    full: 'uid=0 main "New value"',
  });
  const read = readStoredSnapshot(store, 'run-1', 0, 10000, 'changes');

  assert.equal(second.generation, 2);
  assert.equal(read.ok, true);
  assert.match(String(read.actual), /Type changes/);
  assert.match(String(read.actual), /Added interactive elements/);
  assert.match(String(read.actual), /uid=3/);
  assert.match(String(read.actual), /Changed interactive elements/);
  assert.match(String(read.actual), /uid=2/);
  assert.match(String(read.actual), /"New value"/);
  assert.match(String(read.actual), /"Old value"/);
});

test('clone and restore keep observation stores isolated', () => {
  const source: RuntimeObservationStore = new Map();
  const target: RuntimeObservationStore = new Map();
  storeRuntimeObservation(source, 'run-1', 'inspect', 'source page');

  const cloned = cloneRuntimeObservationStore(source);
  storeRuntimeObservation(source, 'run-1', 'inspect', 'changed page');
  restoreRuntimeObservationStore(target, cloned);

  const read = readStoredSnapshot(target, 'run-1', 0, 10000);

  assert.equal(read.ok, true);
  assert.match(String(read.actual), /source page/);
  assert.doesNotMatch(String(read.actual), /changed page/);
});

test('invalidated observations cannot be reused without a refresh', () => {
  const store: RuntimeObservationStore = new Map();
  storeRuntimeObservation(store, 'run-1', 'inspect', 'first page', {
    defaultType: 'actionable',
    actionable: 'uid=1 button "Open"',
    text: 'First page',
  });

  invalidateRuntimeObservation(store, 'run-1', 'interact');
  const staleRead = readStoredSnapshot(store, 'run-1', 0, 10000, 'actionable');

  assert.equal(staleRead.ok, false);
  assert.match(String(staleRead.actual), /stale/);
  assert.match(String(staleRead.actual), /interact/);

  storeRuntimeObservation(store, 'run-1', 'inspect', 'second page', {
    defaultType: 'actionable',
    actionable: 'uid=2 button "Save"',
    text: 'Second page',
  });
  const changes = readStoredSnapshot(store, 'run-1', 0, 10000, 'changes');

  assert.equal(changes.ok, true);
  assert.match(String(changes.actual), /Previous generation: 1/);
  assert.match(String(changes.actual), /Current generation: 2/);
  assert.match(String(changes.actual), /uid=2/);
});

test('compactStaleSnapshotMessages stales snapshot results before browser actions', () => {
  type RuntimeObservationTestMessage = Parameters<typeof compactStaleSnapshotMessages>[0][number];
  const toolActual = (message: unknown) => {
    const content = (message as { content?: unknown }).content;
    assert.ok(Array.isArray(content));
    const [part] = content as Array<{ output?: { value?: { actual?: unknown } } }>;
    const actual = part.output?.value?.actual;
    assert.equal(typeof actual, 'string');
    return actual;
  };
  const messages = [
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'read-1', toolName: 'inspect', input: { action: 'capture', mode: 'full' } }],
    },
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'read-1', toolName: 'inspect', output: { type: 'json', value: { ok: true, actual: 'old uid=1' } } }],
    },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'search-1', toolName: 'inspect', input: { action: 'search', query: 'Open' } }],
    },
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'search-1', toolName: 'inspect', output: { type: 'json', value: { ok: true, actual: 'match uid=1' } } }],
    },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'click-1', toolName: 'interact', input: { action: 'click', uid: '1' } }],
    },
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'click-1', toolName: 'interact', output: { type: 'json', value: { ok: true, actual: 'clicked' } } }],
    },
  ];

  const compacted = compactStaleSnapshotMessages(messages as RuntimeObservationTestMessage[]);

  assert.equal(toolActual(compacted[1]), staleSnapshotText);
  assert.equal(toolActual(compacted[3]), staleSnapshotText);
  assert.equal(toolActual(compacted[5]), 'clicked');
});
