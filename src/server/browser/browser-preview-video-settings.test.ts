import assert from 'node:assert/strict';
import test from 'node:test';
import { browserPreviewVideoDimensions } from './browser-preview-video-settings';

function withVideoDimensions(width: string, height: string, action: () => void) {
  const previousWidth = process.env.BROWSER_PREVIEW_VIDEO_MAX_WIDTH;
  const previousHeight = process.env.BROWSER_PREVIEW_VIDEO_MAX_HEIGHT;
  try {
    process.env.BROWSER_PREVIEW_VIDEO_MAX_WIDTH = width;
    process.env.BROWSER_PREVIEW_VIDEO_MAX_HEIGHT = height;
    action();
  } finally {
    if (previousWidth === undefined) delete process.env.BROWSER_PREVIEW_VIDEO_MAX_WIDTH;
    else process.env.BROWSER_PREVIEW_VIDEO_MAX_WIDTH = previousWidth;
    if (previousHeight === undefined) delete process.env.BROWSER_PREVIEW_VIDEO_MAX_HEIGHT;
    else process.env.BROWSER_PREVIEW_VIDEO_MAX_HEIGHT = previousHeight;
  }
}

test('video dimensions do not upscale the browser capture surface', () => {
  withVideoDimensions('2560', '1440', () => {
    assert.deepEqual(browserPreviewVideoDimensions({ width: 1920, height: 1080 }), {
      width: 1920,
      height: 1080,
    });
  });
});

test('video output preserves aspect ratio and never exceeds the configured 4K box', () => {
  withVideoDimensions('3840', '2160', () => {
    assert.deepEqual(browserPreviewVideoDimensions({ width: 5120, height: 2880 }), {
      width: 3840,
      height: 2160,
    });
  });
});
