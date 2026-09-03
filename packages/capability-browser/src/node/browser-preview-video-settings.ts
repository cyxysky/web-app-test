import { normalizeBoundedInteger } from '@webpilot/capability-sdk';
import type { BrowserRuntimeEnvironment } from './browser-session-runtime.js';

function evenDimension(value: number, fallback: number) {
  const normalized = Number.isFinite(value) ? Math.max(2, Math.floor(value)) : fallback;
  return normalized % 2 === 0 ? normalized : normalized - 1;
}

function boundedIntegerEnv(name: string, fallback: number, minimum: number, maximum: number, environment: BrowserRuntimeEnvironment) {
  return normalizeBoundedInteger(environment[name], fallback, minimum, maximum);
}

export function browserPreviewVideoMaximumDimensions(environment: BrowserRuntimeEnvironment = process.env) {
  return {
    height: boundedIntegerEnv('BROWSER_PREVIEW_VIDEO_MAX_HEIGHT', 1080, 240, 2160, environment),
    width: boundedIntegerEnv('BROWSER_PREVIEW_VIDEO_MAX_WIDTH', 1920, 320, 4096, environment),
  };
}

export function browserPreviewVideoDimensions(
  viewport: { height: number; width: number },
  environment: BrowserRuntimeEnvironment = process.env,
) {
  const maximum = browserPreviewVideoMaximumDimensions(environment);
  const sourceWidth = evenDimension(viewport.width, 1280);
  const sourceHeight = evenDimension(viewport.height, 720);
  const scale = Math.min(1, maximum.width / sourceWidth, maximum.height / sourceHeight);
  return {
    height: evenDimension(sourceHeight * scale, 720),
    width: evenDimension(sourceWidth * scale, 1280),
  };
}
