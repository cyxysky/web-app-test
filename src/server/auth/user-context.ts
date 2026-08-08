import { timingSafeEqual } from 'node:crypto';

const FALLBACK_APPLICATION_USER_ID = '1';

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

export type ApplicationPrincipal = {
  roles: string[];
  userId: string;
  username: string;
};

function trustedAuthenticationHeaders(request: Pick<Request, 'headers'>) {
  const expected = String(process.env.WEBPILOT_IDENTITY_HEADER_SECRET || '');
  const supplied = String(request.headers.get('x-webpilot-identity-proof') || '');
  if (!expected || !supplied) return false;
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const suppliedBuffer = Buffer.from(supplied, 'utf8');
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

export function requestApplicationPrincipal(request: Pick<Request, 'headers'>): ApplicationPrincipal {
  if (!trustedAuthenticationHeaders(request)) throw new Error('Authentication required');
  const userId = String(request.headers.get('x-webpilot-identity-user-id') || '').trim();
  const username = String(request.headers.get('x-webpilot-identity-username') || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(userId) || !username) throw new Error('Authentication required');
  return {
    userId: normalizeApplicationUserId(userId),
    username,
    roles: String(request.headers.get('x-webpilot-identity-roles') || '')
      .split(',')
      .map((role) => role.trim())
      .filter(Boolean),
  };
}

export function requestApplicationUserId(request: Pick<Request, 'headers'>) {
  return requestApplicationPrincipal(request).userId;
}

