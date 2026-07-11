import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import {
  browserKeyboardToolShape,
  browserMouseToolShape,
} from './browser-input-tool-schema';

test('shared browser input schemas expose the complete mouse and keyboard contracts', () => {
  const mouse = z.object(browserMouseToolShape);
  const keyboard = z.object(browserKeyboardToolShape);

  assert.equal(mouse.parse({ action: 'drag', uid: '1', toUid: '2' }).action, 'drag');
  assert.equal(keyboard.parse({ action: 'shortcut', keys: ['Control', 'k'] }).action, 'shortcut');
  assert.throws(() => mouse.parse({ action: 'move', x_thousandth: 0, y_thousandth: 500 }));
  assert.throws(() => keyboard.parse({ action: 'shortcut', keys: Array(7).fill('x') }));
});
