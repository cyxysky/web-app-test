const FALLBACK_APPLICATION_USER_ID = '0';

export function defaultApplicationUserId(env: NodeJS.ProcessEnv | { WEBPILOT_DEFAULT_USER_ID?: string } = process.env) {
  return String(env.WEBPILOT_DEFAULT_USER_ID || '').trim() || FALLBACK_APPLICATION_USER_ID;
}

export const DEFAULT_APPLICATION_USER_ID = defaultApplicationUserId();

export function normalizeApplicationUserId(value: unknown) {
  const normalized = typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';
  return normalized || DEFAULT_APPLICATION_USER_ID;
}

export function applicationUserRuntimeKey(value: unknown) {
  return `user:${normalizeApplicationUserId(value)}`;
}

export function requestApplicationUserId(request: Pick<Request, 'url'>, claimedIdentity?: unknown) {
  const claimed = claimedIdentity && typeof claimedIdentity === 'object'
    ? claimedIdentity as { qzUserId?: unknown; userId?: unknown }
    : undefined;
  const url = new URL(request.url);
  return normalizeApplicationUserId(
    claimed?.userId
    ?? claimed?.qzUserId
    ?? url.searchParams.get('userId')
    ?? url.searchParams.get('qzUserId'),
  );
}

