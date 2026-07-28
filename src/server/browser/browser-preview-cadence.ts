export const MIN_BROWSER_PREVIEW_FPS = 12;
export const MAX_BROWSER_PREVIEW_FPS = 30;

export function browserPreviewFramesPerSecond(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return MIN_BROWSER_PREVIEW_FPS;
  return Math.min(MAX_BROWSER_PREVIEW_FPS, Math.max(MIN_BROWSER_PREVIEW_FPS, Math.floor(numeric)));
}

export function browserPreviewFrameIntervalMs(value: unknown) {
  return Math.floor(1000 / browserPreviewFramesPerSecond(value));
}
