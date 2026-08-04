import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { browserInteractToolShape, refineBrowserInteractTarget } from './browser-input-tool-schema';

test('DOM browser input schema accepts backend-bound refs and atomic text edits', () => {
  const interact = z.object(browserInteractToolShape).superRefine(refineBrowserInteractTarget);

  assert.equal(Object.hasOwn(browserInteractToolShape, 'snapshotId'), false);
  assert.equal(Object.hasOwn(browserInteractToolShape, 'offset'), false);
  assert.equal(interact.parse({ action: 'click', target: { kind: 'ref', ref: 'dom-4-110' } }).target?.ref, 'dom-4-110');
  assert.equal(interact.parse({
    action: 'drag',
    target: { kind: 'ref', ref: 'dom-4-1' },
    toTarget: { kind: 'ref', ref: 'dom-4-2' },
  }).action, 'drag');
  assert.equal(interact.parse({
    action: 'selectOption',
    target: { kind: 'ref', ref: 'dom-4-3' },
    value: '15002',
  }).action, 'selectOption');
  assert.equal(interact.parse({
    action: 'editText',
    target: { kind: 'ref', ref: 'dom-4-5' },
    selection: { start: { afterText: 'existing text', occurrence: 2 } },
    operation: 'insert',
    text: 'new text',
  }).action, 'editText');
  assert.equal(interact.parse({
    action: 'editText',
    target: { kind: 'ref', ref: 'dom-4-5' },
    selection: { exactText: 'old text', occurrence: 1 },
    operation: 'replace',
    text: 'new text',
  }).operation, 'replace');
  assert.equal(interact.parse({
    action: 'editText',
    target: { kind: 'ref', ref: 'dom-4-5' },
    selection: { start: { offset: 2 }, end: { offset: 5 } },
    operation: 'delete',
  }).operation, 'delete');
  assert.equal(interact.parse({
    action: 'click',
    target: { kind: 'ref', ref: 'dom-4-4' },
    force: true,
  }).force, true);
});

test('DOM browser input schema rejects invalid text selection contracts', () => {
  const interact = z.object(browserInteractToolShape).superRefine(refineBrowserInteractTarget);

  assert.throws(() => interact.parse({ action: 'click', target: { kind: 'semantic', name: '110' } }));
  assert.throws(() => interact.parse({ action: 'click', target: { kind: 'ref', ref: 'dom-4-1', name: '110' } }));
  assert.throws(() => interact.parse({ action: 'click', target: { kind: 'ref', ref: '' } }));
  assert.throws(() => interact.parse({
    action: 'click',
    target: { kind: 'ref', ref: 'dom-4-110' },
    x_thousandth: 500,
    y_thousandth: 500,
  }), /either target or screenshot coordinates/);
  assert.throws(() => interact.parse({ action: 'drag', target: { kind: 'ref', ref: 'dom-4-1' } }), /toTarget/);
  assert.throws(() => interact.parse({ action: 'selectOption', target: { kind: 'ref', ref: 'dom-4-3' } }), /exact value or full label/);
  assert.throws(() => interact.parse({ action: 'editText', operation: 'insert', selection: { start: { offset: 1 } }, text: 'new' }), /requires target/);
  assert.throws(() => interact.parse({ action: 'editText', target: { kind: 'ref', ref: 'dom-4-5' }, operation: 'insert', text: 'new' }), /requires selection/);
  assert.throws(() => interact.parse({ action: 'editText', target: { kind: 'ref', ref: 'dom-4-5' }, selection: { start: { offset: 1 } }, text: 'new' }), /requires operation/);
  assert.throws(() => interact.parse({ action: 'editText', target: { kind: 'ref', ref: 'dom-4-5' }, selection: { start: { offset: 1, afterText: 'old' } }, operation: 'insert', text: 'new' }), /exactly one/);
  assert.throws(() => interact.parse({ action: 'editText', target: { kind: 'ref', ref: 'dom-4-5' }, selection: { exactText: 'old' }, operation: 'insert', text: 'new' }), /collapsed/);
  assert.throws(() => interact.parse({ action: 'editText', target: { kind: 'ref', ref: 'dom-4-5' }, selection: { start: { offset: 1 } }, operation: 'replace', text: 'new' }), /non-collapsed/);
  assert.throws(() => interact.parse({ action: 'editText', target: { kind: 'ref', ref: 'dom-4-5' }, selection: { exactText: 'old' }, operation: 'replace' }), /non-empty text/);
  assert.throws(() => interact.parse({ action: 'editText', target: { kind: 'ref', ref: 'dom-4-5' }, selection: { exactText: 'old' }, operation: 'delete', text: 'new' }), /does not accept text/);
  assert.throws(() => interact.parse({ action: 'editText', target: { kind: 'ref', ref: 'dom-4-5' }, selection: { start: { offset: 1 } }, operation: 'setSelection', credentialRef: 'secret' }), /credentialRef is allowed only/);
  assert.throws(() => interact.parse({ action: 'move', x_thousandth: 500, y_thousandth: 500, force: true }), /force is allowed only/);
  assert.throws(() => interact.parse({ action: 'move', x_thousandth: 0, y_thousandth: 500 }));
  assert.throws(() => interact.parse({ action: 'shortcut', keys: Array(7).fill('x') }));
});
