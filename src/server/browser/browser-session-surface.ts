export type BrowserSessionSurface = 'external' | 'electron-embedded';

type BrowserSessionSurfaceOptions = {
  browserSurface?: BrowserSessionSurface;
  isolated?: boolean;
};

export function resolveBrowserSessionSurface(
  options: BrowserSessionSurfaceOptions,
  electronEmbeddedBrowserConfigured: boolean,
): BrowserSessionSurface {
  return !options.isolated
    && options.browserSurface === 'electron-embedded'
    && electronEmbeddedBrowserConfigured
    ? 'electron-embedded'
    : 'external';
}
