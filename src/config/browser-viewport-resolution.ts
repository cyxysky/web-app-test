export const browserViewportResolutionPresets = [
  { label: '自动跟随浏览器窗口', value: 'auto' },
  { label: '1080p（1920 × 1080）', value: '1080p', width: 1920, height: 1080 },
  { label: '2K / QHD（2560 × 1440）', value: '2k', width: 2560, height: 1440 },
  { label: '4K / UHD（3840 × 2160）', value: '4k', width: 3840, height: 2160 },
  { label: '8K / UHD（7680 × 4320）', value: '8k', width: 7680, height: 4320 },
  { label: '自定义宽高', value: 'custom' },
] as const;

export type BrowserViewportResolution = typeof browserViewportResolutionPresets[number]['value'];
export type BrowserViewportSize = { width: number; height: number };

function positiveInteger(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : undefined;
}

export function resolveBrowserViewportSize(
  resolution: unknown,
  customWidth?: unknown,
  customHeight?: unknown,
): BrowserViewportSize | undefined {
  const normalized = typeof resolution === 'string' ? resolution.trim().toLowerCase() : 'auto';
  const preset = browserViewportResolutionPresets.find((item) => item.value === normalized);
  if (preset && 'width' in preset && 'height' in preset) {
    return { width: preset.width, height: preset.height };
  }
  if (normalized !== 'custom') return undefined;
  const width = positiveInteger(customWidth);
  const height = positiveInteger(customHeight);
  return width && height ? { width, height } : undefined;
}
