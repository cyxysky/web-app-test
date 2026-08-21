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

export function requestWorkspaceApplicationPrincipal(request: Pick<Request, 'headers'>): ApplicationPrincipal {
  try {
    return requestApplicationPrincipal(request);
  } catch (error) {
    // Workspace pages only execute in the UI host, after webpilot-server has
    // authenticated the incoming request. Next development rendering can
    // reconstruct the request without the private proof header, so retain the
    // already-normalized identity fields in this UI-only boundary. API routes
    // continue to require the cryptographic proof above.
    if (process.env.WEBPILOT_SERVER_ROLE !== 'ui') throw error;
    const userId = String(request.headers.get('x-webpilot-identity-user-id') || '').trim();
    const username = String(request.headers.get('x-webpilot-identity-username') || '').trim();
    if (/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(userId) && username) {
      return {
        userId: normalizeApplicationUserId(userId),
        username,
        roles: String(request.headers.get('x-webpilot-identity-roles') || '')
          .split(',')
          .map((role) => role.trim())
          .filter(Boolean),
      };
    }
    if (String(process.env.WEBPILOT_REQUIRE_MOUNT_USER_ID || '').trim().toLowerCase() === 'true') throw error;
    const fallbackUserId = defaultApplicationUserId();
    return { userId: fallbackUserId, username: fallbackUserId, roles: ['user'] };
  }
}

export function requestApplicationUserId(request: Pick<Request, 'headers'>) {
  return requestApplicationPrincipal(request).userId;
}

