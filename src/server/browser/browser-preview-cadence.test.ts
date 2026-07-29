import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserPreviewFrameIntervalMs,
  browserPreviewFramesPerSecond,
} from './browser-preview-cadence';

test('browser preview never runs below twenty frames per second', () => {
  assert.equal(browserPreviewFramesPerSecond(undefined), 20);
  assert.equal(browserPreviewFramesPerSecond(1), 20);
  assert.equal(browserPreviewFrameIntervalMs(20), 50);
});

test('browser preview accepts faster rates without unbounded capture load', () => {
  assert.equal(browserPreviewFramesPerSecond(24), 24);
  assert.equal(browserPreviewFramesPerSecond(120), 30);
});
