import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type BrowserRuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export function browserRuntimeDataRoot(environment: BrowserRuntimeEnvironment = process.env) {
  return path.resolve(
    environment.CAPABILITY_BROWSER_DATA_DIR
      || environment.APP_DATA_DIR
      || path.join(process.cwd(), 'runtime'),
  );
}

export function positiveIntegerEnv(key: string, environment: BrowserRuntimeEnvironment = process.env) {
  const raw = environment[key]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

export function boundedPositiveIntegerEnv(key: string, fallback: number, min: number, max: number, environment: BrowserRuntimeEnvironment = process.env) {
  const value = positiveIntegerEnv(key, environment) ?? fallback;
  return Math.min(Math.max(value, min), max);
}

export function boundedNonNegativeIntegerEnv(key: string, fallback: number, max: number, environment: BrowserRuntimeEnvironment = process.env) {
  const raw = environment[key]?.trim();
  if (!raw) return Math.min(Math.max(Math.floor(fallback), 0), max);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return Math.min(Math.max(Math.floor(fallback), 0), max);
  return Math.min(Math.floor(value), max);
}

export function numericLimitFromEnv(name: string, fallback: number, environment: BrowserRuntimeEnvironment = process.env) {
  const raw = String(environment[name] || '').trim();
  if (/^(0|false|none|off|unlimited)$/i.test(raw)) return Number.MAX_SAFE_INTEGER;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function sharedBrowserTabsEnabled(environment: BrowserRuntimeEnvironment = process.env) {
  return environment.BROWSER_SHARED_TABS !== 'false';
}

export function browserHeadlessEnabled(
  options: { debugDevtools?: boolean; headless?: boolean } = {},
  runtime: { env?: BrowserRuntimeEnvironment; platform?: NodeJS.Platform } = {},
) {
  if (options.debugDevtools) return false;
  if (options.headless !== undefined) return options.headless;

  const env = runtime.env || process.env;
  const platform = runtime.platform || process.platform;
  const configuredHeadless = env.HEADLESS_BROWSER?.trim().toLowerCase() === 'true';
  const linuxWithoutDisplay = platform === 'linux'
    && !env.DISPLAY?.trim()
    && !env.WAYLAND_DISPLAY?.trim();
  return configuredHeadless || linuxWithoutDisplay;
}

export function nativeBrowserTabGroupsEnabled(headless: boolean, environment: BrowserRuntimeEnvironment = process.env) {
  return !headless && environment.BROWSER_NATIVE_TAB_GROUPS !== 'false';
}

export function browserTabTitlePrefixEnabled(environment: BrowserRuntimeEnvironment = process.env) {
  return environment.BROWSER_TAB_TITLE_PREFIX === 'true';
}

export function electronEmbeddedBrowserEnabled(environment: BrowserRuntimeEnvironment = process.env) {
  return environment.ELECTRON_EMBEDDED_BROWSER === 'true';
}

export function cdpEndpointForPort(port?: number) {
  return port ? `http://127.0.0.1:${port}` : '';
}

export function electronEmbeddedBrowserCdpEndpoint(environment: BrowserRuntimeEnvironment = process.env) {
  if (!electronEmbeddedBrowserEnabled(environment)) return '';
  const port = Number(environment.ELECTRON_EMBEDDED_BROWSER_CDP_PORT || environment.WEBPILOT_ELECTRON_CDP_PORT || 19333);
  return cdpEndpointForPort(Number.isInteger(port) && port > 0 ? port : 19333);
}

export function sessionTabGrouperExtensionPath(environment: BrowserRuntimeEnvironment = process.env) {
  const runtimeRoot = String(environment.CAPABILITY_BROWSER_RUNTIME_DIR || '').trim();
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    runtimeRoot ? path.join(runtimeRoot, 'session-tab-grouper-extension') : '',
    path.resolve(moduleDirectory, '..', '..', 'runtime', 'session-tab-grouper-extension'),
    path.join(process.cwd(), 'capability-runtime', 'browser', 'session-tab-grouper-extension'),
    path.join(process.cwd(), 'packages', 'capability-browser', 'runtime', 'session-tab-grouper-extension'),
    path.join(process.cwd(), 'node_modules', '@webpilot', 'capability-browser', 'runtime', 'session-tab-grouper-extension'),
  ];
  return candidates.find((candidate) => candidate && existsSync(path.join(candidate, 'manifest.json')))
    || candidates.find(Boolean)
    || '';
}

export function sessionTabGrouperEnabled(headless: boolean, environment: BrowserRuntimeEnvironment = process.env) {
  const extensionPath = sessionTabGrouperExtensionPath(environment);
  return nativeBrowserTabGroupsEnabled(headless, environment) && existsSync(path.join(extensionPath, 'manifest.json'));
}

export function withSessionTabGrouperArgs(args: string[], headless: boolean, options: { exclusive?: boolean; environment?: BrowserRuntimeEnvironment } = {}) {
  const environment = options.environment || process.env;
  if (!sessionTabGrouperEnabled(headless, environment)) return args;
  const extensionPath = sessionTabGrouperExtensionPath(environment);
  return [
    ...args,
    ...(options.exclusive ? [`--disable-extensions-except=${extensionPath}`] : []),
    `--load-extension=${extensionPath}`,
  ];
}

export function normalizePageGroupId(value?: string) {
  const normalized = (value || 'browser-session')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96);
  return normalized || 'browser-session';
}

export function sessionTabGrouperProfileDir(profileKey: string, environment: BrowserRuntimeEnvironment = process.env) {
  return path.join(browserRuntimeDataRoot(environment), '.data', 'browser-profiles', 'tab-groups', normalizePageGroupId(profileKey));
}

export function managedBrowserProfilesRoot(environment: BrowserRuntimeEnvironment = process.env) {
  return path.resolve(browserRuntimeDataRoot(environment), '.data', 'browser-profiles');
}

function isPathInside(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

export async function clearManagedBrowserProfileCaches(profileDir: string, environment: BrowserRuntimeEnvironment = process.env) {
  if (environment.BROWSER_PROFILE_CLEAR_CACHE_ON_CLOSE === 'false' || !profileDir) return 0;
  const root = managedBrowserProfilesRoot(environment);
  const resolvedProfileDir = path.resolve(profileDir);
  if (!isPathInside(root, resolvedProfileDir)) return 0;

  const cacheDirectoryNames = new Set([
    'Cache',
    'Code Cache',
    'GPUCache',
    'DawnGraphiteCache',
    'DawnWebGPUCache',
  ]);
  const targets: string[] = [];
  const rootEntries = await readdir(resolvedProfileDir, { withFileTypes: true }).catch(() => []);
  for (const entry of rootEntries) {
    if (!entry.isDirectory()) continue;
    const entryPath = path.join(resolvedProfileDir, entry.name);
    if (cacheDirectoryNames.has(entry.name) || /^Dawn.*Cache$/i.test(entry.name)) targets.push(entryPath);
    if (!/^(Default|Profile \d+|Guest Profile)$/i.test(entry.name)) continue;
    const profileEntries = await readdir(entryPath, { withFileTypes: true }).catch(() => []);
    for (const profileEntry of profileEntries) {
      if (!profileEntry.isDirectory()) continue;
      if (!cacheDirectoryNames.has(profileEntry.name) && !/^Dawn.*Cache$/i.test(profileEntry.name)) continue;
      targets.push(path.join(entryPath, profileEntry.name));
    }
  }
  const removed = await Promise.all(targets.map(async (target) => {
    try {
      await rm(target, { force: true, recursive: true, maxRetries: 2, retryDelay: 100 });
      return true;
    } catch {
      // A browser helper can keep a cache file locked briefly on Windows.
      // Cache cleanup is best-effort and must not turn session shutdown into
      // an error or touch persistent site data as a fallback.
      return false;
    }
  }));
  return removed.filter(Boolean).length;
}

export function sessionTabGrouperDebugPort(profileKey: string, environment: BrowserRuntimeEnvironment = process.env) {
  const configured = Number(environment.BROWSER_TAB_GROUP_CDP_PORT || '');
  if (Number.isInteger(configured) && configured > 0 && configured < 65536) return configured;
  const key = normalizePageGroupId(profileKey);
  let hash = 0;
  for (const char of key) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
  return 24000 + (hash % 10000);
}

export function cdpPortFromEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint);
    const port = Number(url.port);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
  } catch {
    return undefined;
  }
}
