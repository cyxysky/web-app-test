import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { browserInteractToolShape, refineBrowserInteractTarget } from './browser-input-tool-schema';

test('DOM browser input schema accepts snapshot-bound semantic and ref targets', () => {
  const interact = z.object(browserInteractToolShape).superRefine(refineBrowserInteractTarget);
  const semanticTarget = {
    kind: 'semantic' as const,
    scope: { attributes: { 'data-row-id': '110' } },
    role: 'button',
    name: '需求',
  };

  assert.equal(interact.parse({ action: 'click', snapshotId: 'dom-observation-7', target: semanticTarget }).target?.kind, 'semantic');
  assert.equal(interact.parse({
    action: 'drag',
    snapshotId: 'dom-observation-7',
    target: { kind: 'ref', ref: 'dom-1' },
    toTarget: { kind: 'ref', ref: 'dom-2' },
  }).action, 'drag');
  assert.equal(interact.parse({
    action: 'selectOption',
    snapshotId: 'dom-observation-7',
    target: { kind: 'semantic', attributes: { 'aria-label': '故障分类' } },
    value: '15002',
  }).action, 'selectOption');
  assert.equal(interact.parse({
    action: 'click',
    snapshotId: 'dom-observation-7',
    target: { kind: 'ref', ref: 'dom-close' },
    force: true,
  }).force, true);
});

test('DOM browser input schema rejects ambiguous, stale-prone, or mixed target contracts', () => {
  const interact = z.object(browserInteractToolShape).superRefine(refineBrowserInteractTarget);

  assert.throws(() => interact.parse({ action: 'click', target: { kind: 'ref', ref: 'dom-110' } }), /snapshotId/);
  assert.throws(() => interact.parse({ action: 'click', snapshotId: 's1', target: { kind: 'semantic', role: 'button' } }), /name or at least one stable attribute/);
  assert.throws(() => interact.parse({ action: 'click', snapshotId: 's1', target: { kind: 'semantic', attributes: { class: 'button' } } }), /Unsupported target attribute/);
  assert.throws(() => interact.parse({ action: 'click', snapshotId: 's1', target: { kind: 'ref', ref: 'dom-1', name: '110' } }), /contains only kind and ref/);
  assert.throws(() => interact.parse({
    action: 'click',
    snapshotId: 's1',
    target: { kind: 'semantic', name: '110' },
    x_thousandth: 500,
    y_thousandth: 500,
  }), /either target or screenshot coordinates/);
  assert.throws(() => interact.parse({ action: 'drag', snapshotId: 's1', target: { kind: 'ref', ref: 'dom-1' } }), /toTarget/);
  assert.throws(() => interact.parse({ action: 'move', x_thousandth: 500, y_thousandth: 500, force: true }), /force is allowed only/);
  assert.throws(() => interact.parse({ action: 'move', x_thousandth: 0, y_thousandth: 500 }));
  assert.throws(() => interact.parse({ action: 'shortcut', keys: Array(7).fill('x') }));
});
