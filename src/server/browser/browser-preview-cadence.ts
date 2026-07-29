export const DEFAULT_BROWSER_PREVIEW_FPS = 20;
export const MIN_BROWSER_PREVIEW_FPS = 1;
export const MAX_BROWSER_PREVIEW_FPS = 60;

export function browserPreviewFramesPerSecond(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_BROWSER_PREVIEW_FPS;
  return Math.min(MAX_BROWSER_PREVIEW_FPS, Math.max(MIN_BROWSER_PREVIEW_FPS, Math.floor(numeric)));
}

export function browserPreviewFrameIntervalMs(value: unknown) {
  return Math.ceil(1000 / browserPreviewFramesPerSecond(value));
}
