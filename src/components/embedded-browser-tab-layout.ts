export type EmbeddedBrowserTabDensity = 'compact' | 'full' | 'icon-only';

const EMBEDDED_BROWSER_TAB_MAX_WIDTH = 210;
const EMBEDDED_BROWSER_TAB_MIN_WIDTH = 40;
const EMBEDDED_BROWSER_TAB_FULL_MIN_WIDTH = 136;
const EMBEDDED_BROWSER_TAB_COMPACT_MIN_WIDTH = 80;

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
