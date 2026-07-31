import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { browserInteractToolShape, refineBrowserInteractTarget } from './browser-input-tool-schema';

test('DOM browser input schema accepts only backend-bound ref targets without snapshotId', () => {
  const interact = z.object(browserInteractToolShape).superRefine(refineBrowserInteractTarget);

  assert.equal(Object.hasOwn(browserInteractToolShape, 'snapshotId'), false);
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
    action: 'click',
    target: { kind: 'ref', ref: 'dom-4-4' },
    force: true,
  }).force, true);
});

test('DOM browser input schema rejects semantic, extra, or mixed target contracts', () => {
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
  assert.throws(() => interact.parse({ action: 'move', x_thousandth: 500, y_thousandth: 500, force: true }), /force is allowed only/);
  assert.throws(() => interact.parse({ action: 'move', x_thousandth: 0, y_thousandth: 500 }));
  assert.throws(() => interact.parse({ action: 'shortcut', keys: Array(7).fill('x') }));
});
