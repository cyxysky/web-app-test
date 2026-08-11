import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveEmbeddedBrowserTabLayout,
  resolveEmbeddedBrowserWheelScrollLeft,
} from './embedded-browser-tab-layout';

test('embedded browser tabs progressively collapse like Chrome tabs', () => {
  assert.deepEqual(resolveEmbeddedBrowserTabLayout(210), { density: 'full', width: 210 });
  assert.deepEqual(resolveEmbeddedBrowserTabLayout(135), { density: 'compact', width: 135 });
  assert.deepEqual(resolveEmbeddedBrowserTabLayout(80), { density: 'compact', width: 80 });
  assert.deepEqual(resolveEmbeddedBrowserTabLayout(79), { density: 'icon-only', width: 79 });
});

test('embedded browser tabs reach icon-only minimum width before scrolling', () => {
  assert.deepEqual(resolveEmbeddedBrowserTabLayout(24), { density: 'icon-only', width: 64 });
  assert.deepEqual(resolveEmbeddedBrowserTabLayout(Number.NaN), { density: 'full', width: 210 });
});

test('embedded browser tab wheel input scrolls horizontally and respects its bounds', () => {
  const base = { clientWidth: 400, deltaMode: 0, scrollLeft: 120, scrollWidth: 700 };
  assert.equal(resolveEmbeddedBrowserWheelScrollLeft({ ...base, deltaX: 0, deltaY: 80 }), 200);
  assert.equal(resolveEmbeddedBrowserWheelScrollLeft({ ...base, deltaX: -40, deltaY: 10 }), 80);
  assert.equal(resolveEmbeddedBrowserWheelScrollLeft({ ...base, deltaMode: 1, deltaX: 0, deltaY: 3 }), 168);
  assert.equal(resolveEmbeddedBrowserWheelScrollLeft({ ...base, deltaX: 0, deltaY: 999 }), 300);
  assert.equal(resolveEmbeddedBrowserWheelScrollLeft({ ...base, deltaX: 0, deltaY: -999 }), 0);
  assert.equal(resolveEmbeddedBrowserWheelScrollLeft({ ...base, deltaX: 0, deltaY: 0, scrollWidth: 400 }), 120);
});
