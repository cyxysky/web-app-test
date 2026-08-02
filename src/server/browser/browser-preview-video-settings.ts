function evenDimension(value: number, fallback: number) {
  const normalized = Number.isFinite(value) ? Math.max(2, Math.floor(value)) : fallback;
  return normalized % 2 === 0 ? normalized : normalized - 1;
}

function boundedIntegerEnv(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback;
}

export function browserPreviewVideoMaximumDimensions() {
  return {
    height: boundedIntegerEnv('BROWSER_PREVIEW_VIDEO_MAX_HEIGHT', 1080, 240, 2160),
    width: boundedIntegerEnv('BROWSER_PREVIEW_VIDEO_MAX_WIDTH', 1920, 320, 4096),
  };
}

export function browserPreviewVideoDimensions(viewport: { height: number; width: number }) {
  const maximum = browserPreviewVideoMaximumDimensions();
  const sourceWidth = evenDimension(viewport.width, 1280);
  const sourceHeight = evenDimension(viewport.height, 720);
  const scale = Math.min(1, maximum.width / sourceWidth, maximum.height / sourceHeight);
  return {
    height: evenDimension(sourceHeight * scale, 720),
    width: evenDimension(sourceWidth * scale, 1280),
  };
}

export function browserPreviewVideoCaptureGeometry(viewport: { height: number; width: number }) {
  const maximum = browserPreviewVideoMaximumDimensions();
  const sourceWidth = Math.max(1, Math.floor(viewport.width));
  const sourceHeight = Math.max(1, Math.floor(viewport.height));
  const scale = Math.min(4, Math.max(0.1, Math.min(
    maximum.width / sourceWidth,
    maximum.height / sourceHeight,
  )));
  return {
    height: evenDimension(sourceHeight * scale, sourceHeight),
    scale,
    width: evenDimension(sourceWidth * scale, sourceWidth),
  };
}
