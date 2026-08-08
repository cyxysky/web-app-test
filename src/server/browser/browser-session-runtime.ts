import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { appDataRoot } from '@/server/storage/paths';

export function positiveIntegerEnv(key: string) {
  const raw = process.env[key]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

export function boundedPositiveIntegerEnv(key: string, fallback: number, min: number, max: number) {
  const value = positiveIntegerEnv(key) ?? fallback;
  return Math.min(Math.max(value, min), max);
}

export function boundedNonNegativeIntegerEnv(key: string, fallback: number, max: number) {
  const raw = process.env[key]?.trim();
  if (!raw) return Math.min(Math.max(Math.floor(fallback), 0), max);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return Math.min(Math.max(Math.floor(fallback), 0), max);
  return Math.min(Math.floor(value), max);
}

export function numericLimitFromEnv(name: string, fallback: number) {
  const raw = String(process.env[name] || '').trim();
  if (/^(0|false|none|off|unlimited)$/i.test(raw)) return Number.MAX_SAFE_INTEGER;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function sharedBrowserTabsEnabled() {
  return process.env.BROWSER_SHARED_TABS !== 'false';
}

type BrowserHeadlessEnvironment = Partial<Record<
  'DISPLAY' | 'HEADLESS_BROWSER' | 'WAYLAND_DISPLAY',
  string
>>;

export function browserHeadlessEnabled(
  options: { debugDevtools?: boolean; headless?: boolean } = {},
  runtime: { env?: BrowserHeadlessEnvironment; platform?: NodeJS.Platform } = {},
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

export function nativeBrowserTabGroupsEnabled(headless: boolean) {
  return !headless && process.env.BROWSER_NATIVE_TAB_GROUPS !== 'false';
}

export function browserTabTitlePrefixEnabled() {
  return process.env.BROWSER_TAB_TITLE_PREFIX === 'true';
}

export function electronEmbeddedBrowserEnabled() {
  return process.env.ELECTRON_EMBEDDED_BROWSER === 'true';
}

export function cdpEndpointForPort(port?: number) {
  return port ? `http://127.0.0.1:${port}` : '';
}

export function electronEmbeddedBrowserCdpEndpoint() {
  if (!electronEmbeddedBrowserEnabled()) return '';
  const port = Number(process.env.ELECTRON_EMBEDDED_BROWSER_CDP_PORT || process.env.WEBPILOT_ELECTRON_CDP_PORT || 19333);
  return cdpEndpointForPort(Number.isInteger(port) && port > 0 ? port : 19333);
}

export function sessionTabGrouperExtensionPath() {
  return path.join(process.cwd(), 'src', 'server', 'browser', 'session-tab-grouper-extension');
}

export function sessionTabGrouperEnabled(headless: boolean) {
  const extensionPath = sessionTabGrouperExtensionPath();
  return nativeBrowserTabGroupsEnabled(headless) && existsSync(path.join(extensionPath, 'manifest.json'));
}

export function withSessionTabGrouperArgs(args: string[], headless: boolean, options: { exclusive?: boolean } = {}) {
  if (!sessionTabGrouperEnabled(headless)) return args;
  const extensionPath = sessionTabGrouperExtensionPath();
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

export function sessionTabGrouperProfileDir(profileKey: string) {
  return path.join(appDataRoot(), '.data', 'browser-profiles', 'tab-groups', normalizePageGroupId(profileKey));
}

export function managedBrowserProfilesRoot() {
  return path.resolve(appDataRoot(), '.data', 'browser-profiles');
}

function isPathInside(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

export async function clearManagedBrowserProfileCaches(profileDir: string) {
  if (process.env.BROWSER_PROFILE_CLEAR_CACHE_ON_CLOSE === 'false' || !profileDir) return 0;
  const root = managedBrowserProfilesRoot();
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

export function sessionTabGrouperDebugPort(profileKey: string) {
  const configured = Number(process.env.BROWSER_TAB_GROUP_CDP_PORT || '');
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
