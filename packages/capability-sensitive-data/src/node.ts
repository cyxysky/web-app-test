import { createAiSdkSensitiveDataFilter } from './ai-sdk.js';
import { createSensitiveDataRedactor } from './client.js';
import { prepareGlinerService } from './local-runtime.js';

export * from './client.js';
export * from './config.js';
export * from './local-runtime.js';

let lastFailOpenWarningAt = 0;

function warnFailOpen(error: unknown) {
  const now = Date.now();
  if (now - lastFailOpenWarningAt < 30_000) return;
  lastFailOpenWarningAt = now;
  const detail = error instanceof Error ? error.name : 'Unknown filtering error';
  console.warn(`[sensitive-data-filter] Filtering failed; fail-open is enabled. ${detail}`);
}

export function createNodeSensitiveDataFilter(options: {
  getConfig: () => import('./config.js').SensitiveDataFilterConfig;
  onFailOpen?: (error: unknown) => void;
}) {
  const redact = createSensitiveDataRedactor({
    getConfig: options.getConfig,
    prepareEndpoint: prepareGlinerService,
  });
  return {
    redactSensitiveTexts: redact,
    filterSensitiveData: createAiSdkSensitiveDataFilter({
      getConfig: options.getConfig,
      redact,
      onFailOpen: options.onFailOpen || warnFailOpen,
    }),
  };
}
