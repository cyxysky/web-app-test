import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveBrowserOutputPixelRatio,
  resolveBrowserPreviewImageFormat,
} from './browser-output-settings';

test('browser output pixel ratio is bounded without changing viewport dimensions', () => {
  assert.equal(resolveBrowserOutputPixelRatio(undefined), 1.5);
  assert.equal(resolveBrowserOutputPixelRatio(''), 1.5);
  assert.equal(resolveBrowserOutputPixelRatio('1'), 1);
  assert.equal(resolveBrowserOutputPixelRatio('1.75'), 1.75);
  assert.equal(resolveBrowserOutputPixelRatio('2'), 2);
  assert.equal(resolveBrowserOutputPixelRatio('0.5'), 1);
  assert.equal(resolveBrowserOutputPixelRatio('4'), 2);
});

test('browser preview image format accepts lossless PNG and defaults to JPEG', () => {
  assert.equal(resolveBrowserPreviewImageFormat('png'), 'png');
  assert.equal(resolveBrowserPreviewImageFormat('PNG'), 'png');
  assert.equal(resolveBrowserPreviewImageFormat('jpeg'), 'jpeg');
  assert.equal(resolveBrowserPreviewImageFormat(undefined), 'jpeg');
});
