import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveEmbeddedBrowserTabLayout } from './embedded-browser-tab-layout';

test('embedded browser tabs progressively collapse like Chrome tabs', () => {
  assert.deepEqual(resolveEmbeddedBrowserTabLayout(210), { density: 'full', width: 210 });
  assert.deepEqual(resolveEmbeddedBrowserTabLayout(135), { density: 'compact', width: 135 });
  assert.deepEqual(resolveEmbeddedBrowserTabLayout(80), { density: 'compact', width: 80 });
  assert.deepEqual(resolveEmbeddedBrowserTabLayout(79), { density: 'icon-only', width: 79 });
});

test('embedded browser tabs reach icon-only minimum width before scrolling', () => {
  assert.deepEqual(resolveEmbeddedBrowserTabLayout(24), { density: 'icon-only', width: 40 });
  assert.deepEqual(resolveEmbeddedBrowserTabLayout(Number.NaN), { density: 'full', width: 210 });
});
