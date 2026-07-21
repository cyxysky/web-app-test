export const DEFAULT_APPLICATION_USER_ID = '0';

export function normalizeApplicationUserId(value: unknown) {
  const normalized = typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';
  return normalized || DEFAULT_APPLICATION_USER_ID;
}

export function applicationUserRuntimeKey(value: unknown) {
  return `user:${normalizeApplicationUserId(value)}`;
}

