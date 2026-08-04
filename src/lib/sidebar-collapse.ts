export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'webpilotqa.sidebarCollapsed';
export const SIDEBAR_COLLAPSED_COOKIE_NAME = 'webpilotqa_sidebar_collapsed';

let cachedSidebarCollapsed: boolean | undefined;

export function sidebarCollapsedFromCookie(value: string | undefined) {
  return value === 'true';
}

export function readSidebarCollapsedPreference(fallback = false) {
  if (cachedSidebarCollapsed !== undefined) return cachedSidebarCollapsed;
  if (typeof window === 'undefined') return fallback;
  try {
    const stored = window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
    cachedSidebarCollapsed = stored === null ? fallback : stored === 'true';
  } catch {
    cachedSidebarCollapsed = fallback;
  }
  return cachedSidebarCollapsed;
}

export function writeSidebarCollapsedPreference(collapsed: boolean) {
  cachedSidebarCollapsed = collapsed;
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? 'true' : 'false');
  } catch {
    // The in-memory value and cookie still keep navigation stable.
  }
  document.cookie = `${SIDEBAR_COLLAPSED_COOKIE_NAME}=${collapsed ? 'true' : 'false'}; Path=/; Max-Age=31536000; SameSite=Lax`;
}
