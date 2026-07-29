import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { browserInteractToolShape } from './browser-input-tool-schema';

test('DOM browser input schema covers pointer, keyboard, and native select operations', () => {
  const interact = z.object(browserInteractToolShape);

  assert.equal(interact.parse({ action: 'drag', uid: '1', toUid: '2' }).action, 'drag');
  assert.equal(interact.parse({ action: 'shortcut', keys: ['Control', 'k'] }).action, 'shortcut');
  assert.equal(interact.parse({ action: 'selectOption', uid: '1', value: '15002' }).action, 'selectOption');
  assert.throws(() => interact.parse({ action: 'move', x_thousandth: 0, y_thousandth: 500 }));
  assert.throws(() => interact.parse({ action: 'shortcut', keys: Array(7).fill('x') }));
});
