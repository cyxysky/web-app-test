export const browserCodeRuntimeModes = ['free', 'restricted'] as const;

export type BrowserCodeRuntimeMode = (typeof browserCodeRuntimeModes)[number];

export function resolveBrowserCodeRuntimeMode(
  value: unknown = process.env.BROWSER_CODE_RUNTIME_MODE,
): BrowserCodeRuntimeMode {
  return String(value || '').trim().toLowerCase() === 'restricted' ? 'restricted' : 'free';
}

