export type BrowserPreviewImageFormat = 'jpeg' | 'png';

export function resolveBrowserOutputPixelRatio(value: unknown) {
  if (typeof value === 'string' && !value.trim()) return 1.5;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1.5;
  return Math.min(2, Math.max(1, numeric));
}

export function resolveBrowserPreviewImageFormat(value: unknown): BrowserPreviewImageFormat {
  return typeof value === 'string' && value.trim().toLowerCase() === 'png' ? 'png' : 'jpeg';
}
