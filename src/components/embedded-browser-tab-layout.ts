export type EmbeddedBrowserTabDensity = 'compact' | 'full' | 'icon-only';

const EMBEDDED_BROWSER_TAB_MAX_WIDTH = 210;
const EMBEDDED_BROWSER_TAB_MIN_WIDTH = 64;
const EMBEDDED_BROWSER_TAB_FULL_MIN_WIDTH = 136;
const EMBEDDED_BROWSER_TAB_COMPACT_MIN_WIDTH = 80;

type EmbeddedBrowserWheelScrollInput = {
  clientWidth: number;
  deltaMode: number;
  deltaX: number;
  deltaY: number;
  scrollLeft: number;
  scrollWidth: number;
};

export function resolveEmbeddedBrowserTabLayout(requestedWidth: number) {
  const finiteWidth = Number.isFinite(requestedWidth)
    ? Math.floor(requestedWidth)
    : EMBEDDED_BROWSER_TAB_MAX_WIDTH;
  const width = Math.min(
    EMBEDDED_BROWSER_TAB_MAX_WIDTH,
    Math.max(EMBEDDED_BROWSER_TAB_MIN_WIDTH, finiteWidth),
  );
  const density: EmbeddedBrowserTabDensity = width >= EMBEDDED_BROWSER_TAB_FULL_MIN_WIDTH
    ? 'full'
    : width >= EMBEDDED_BROWSER_TAB_COMPACT_MIN_WIDTH
      ? 'compact'
      : 'icon-only';

  return { density, width };
}

export function resolveEmbeddedBrowserWheelScrollLeft({
  clientWidth,
  deltaMode,
  deltaX,
  deltaY,
  scrollLeft,
  scrollWidth,
}: EmbeddedBrowserWheelScrollInput) {
  if (scrollWidth <= clientWidth + 1) return scrollLeft;
  const rawDelta = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
  if (!rawDelta) return scrollLeft;
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? clientWidth : 1;
  const maxScrollLeft = Math.max(0, scrollWidth - clientWidth);
  return Math.min(maxScrollLeft, Math.max(0, scrollLeft + rawDelta * unit));
}
