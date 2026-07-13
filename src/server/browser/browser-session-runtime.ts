import { existsSync } from 'node:fs';
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
