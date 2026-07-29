import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBrowserViewportSize } from './browser-viewport-resolution';

test('browser viewport resolution presets map to their real render sizes', () => {
  assert.equal(resolveBrowserViewportSize('auto'), undefined);
  assert.deepEqual(resolveBrowserViewportSize('1080p'), { width: 1920, height: 1080 });
  assert.deepEqual(resolveBrowserViewportSize('2k'), { width: 2560, height: 1440 });
  assert.deepEqual(resolveBrowserViewportSize('4k'), { width: 3840, height: 2160 });
  assert.deepEqual(resolveBrowserViewportSize('8k'), { width: 7680, height: 4320 });
});

test('custom browser viewport resolution requires two positive integers', () => {
  assert.deepEqual(resolveBrowserViewportSize('custom', '1600', '900'), { width: 1600, height: 900 });
  assert.deepEqual(resolveBrowserViewportSize('custom', '1600.9', '900.8'), { width: 1600, height: 900 });
  assert.equal(resolveBrowserViewportSize('custom', '', '900'), undefined);
  assert.equal(resolveBrowserViewportSize('custom', '1600', '0'), undefined);
});
