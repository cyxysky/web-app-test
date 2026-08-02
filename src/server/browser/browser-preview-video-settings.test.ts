import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserPreviewVideoCaptureGeometry,
  browserPreviewVideoDimensions,
} from './browser-preview-video-settings';

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

test('video capture produces true 2K pixels without changing the CSS viewport', () => {
  withVideoDimensions('2560', '1440', () => {
    assert.deepEqual(browserPreviewVideoCaptureGeometry({ width: 1920, height: 1080 }), {
      width: 2560,
      height: 1440,
      scale: 4 / 3,
    });
    assert.deepEqual(browserPreviewVideoDimensions({ width: 2560, height: 1440 }), {
      width: 2560,
      height: 1440,
    });
  });
});

test('video capture preserves aspect ratio and never exceeds the configured 4K box', () => {
  withVideoDimensions('3840', '2160', () => {
    assert.deepEqual(browserPreviewVideoCaptureGeometry({ width: 1280, height: 800 }), {
      width: 3456,
      height: 2160,
      scale: 2.7,
    });
    assert.deepEqual(browserPreviewVideoDimensions({ width: 5120, height: 2880 }), {
      width: 3840,
      height: 2160,
    });
  });
});
