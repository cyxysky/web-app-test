import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserPreviewFrameIntervalMs,
  browserPreviewFramesPerSecond,
} from './browser-preview-cadence';

test('browser preview defaults to twenty frames per second and allows low rates', () => {
  assert.equal(browserPreviewFramesPerSecond(undefined), 20);
  assert.equal(browserPreviewFramesPerSecond(1), 1);
  assert.equal(browserPreviewFramesPerSecond(0), 1);
  assert.equal(browserPreviewFrameIntervalMs(20), 50);
});

test('browser preview accepts faster rates up to sixty frames per second', () => {
  assert.equal(browserPreviewFramesPerSecond(24), 24);
  assert.equal(browserPreviewFramesPerSecond(30), 30);
  assert.equal(browserPreviewFramesPerSecond(60), 60);
  assert.equal(browserPreviewFramesPerSecond(120), 60);
  assert.equal(browserPreviewFrameIntervalMs(30), 34);
  assert.equal(browserPreviewFrameIntervalMs(60), 17);
});
