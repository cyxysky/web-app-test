/* eslint-disable @typescript-eslint/no-require-imports */
const { createHmac, timingSafeEqual } = require('node:crypto');

const IDENTITY_COOKIE_NAME = 'webpilot_identity';

function normalizeUserId(value) {
  const normalized = String(value || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(normalized)) return '';
  return normalized;
}

function defaultUserId() {
  return normalizeUserId(process.env.WEBPILOT_DEFAULT_USER_ID) || '1';
}

function identitySecret() {
  return String(process.env.WEBPILOT_IDENTITY_SECRET || '');
}

function signature(payload) {
  return createHmac('sha256', identitySecret()).update(payload, 'utf8').digest('base64url');
}

function signedValue(claims) {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${payload}.${signature(payload)}`;
}

function verifiedClaims(value, kind) {
  const [payload, suppliedSignature, extra] = String(value || '').split('.');
  if (!identitySecret() || !payload || !suppliedSignature || extra !== undefined) return undefined;
  const expectedSignature = signature(payload);
  const expected = Buffer.from(expectedSignature, 'utf8');
  const supplied = Buffer.from(suppliedSignature, 'utf8');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (claims.version !== 1 || claims.kind !== kind || !normalizeUserId(claims.userId)) return undefined;
    if (typeof claims.expiresAt === 'number' && claims.expiresAt <= Date.now()) return undefined;
    return { ...claims, userId: normalizeUserId(claims.userId) };
  } catch {
    return undefined;
  }
}

function parseCookies(header) {
  const cookies = new Map();
  for (const segment of String(header || '').split(';')) {
    const index = segment.indexOf('=');
    if (index <= 0) continue;
    const key = segment.slice(0, index).trim();
    const raw = segment.slice(index + 1).trim();
    try {
      cookies.set(key, decodeURIComponent(raw));
    } catch {
      cookies.set(key, raw);
    }
  }
  return cookies;
}

function requestIsSecure(request) {
  if (String(process.env.WEBPILOT_COOKIE_SECURE || '').trim().toLowerCase() === 'true') return true;
  if (request.socket && request.socket.encrypted) return true;
  return String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}

function cookiePath() {
  const configured = String(process.env.WEBPILOT_BASE_PATH || '').trim().replace(/^\/+|\/+$/g, '');
  return configured ? `/${configured}` : '/';
}

function identityCookie(userId, request) {
  const token = signedValue({ kind: 'identity-session', userId, version: 1 });
  const crossSite = String(process.env.WEBPILOT_CROSS_SITE_MOUNT || '').trim().toLowerCase() === 'true';
  const attributes = [
    `${IDENTITY_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    `SameSite=${crossSite ? 'None' : 'Lax'}`,
    `Path=${cookiePath()}`,
  ];
  if (crossSite || requestIsSecure(request)) attributes.push('Secure');
  return attributes.join('; ');
}

function mountTicketClaims(ticket) {
  return verifiedClaims(ticket, 'mount-ticket');
}

function requestIdentity(request) {
  const cookie = parseCookies(request.headers.cookie).get(IDENTITY_COOKIE_NAME);
  const mounted = cookie ? verifiedClaims(cookie, 'identity-session') : undefined;
  if (mounted) return { userId: mounted.userId, username: mounted.userId, roles: ['user'] };
  if (String(process.env.WEBPILOT_REQUIRE_MOUNT_USER_ID || '').trim().toLowerCase() === 'true') return undefined;
  const userId = defaultUserId();
  return { userId, username: userId, roles: ['user'] };
}

module.exports = {
  IDENTITY_COOKIE_NAME,
  defaultUserId,
  identityCookie,
  mountTicketClaims,
  normalizeUserId,
  requestIdentity,
  signedValue,
};
