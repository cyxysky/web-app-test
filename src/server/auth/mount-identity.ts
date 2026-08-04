import { createHmac } from 'node:crypto';

function identitySecret() {
  const secret = String(process.env.WEBPILOT_IDENTITY_SECRET || '');
  if (!secret) throw new Error('WebPilot identity runtime is unavailable');
  return secret;
}

function normalizeMountedUserId(value: unknown) {
  const userId = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(userId)) {
    throw new Error('A valid mounted user ID is required');
  }
  return userId;
}

export function createMountIdentityTicket(input: { origin?: string; userId: unknown }) {
  const claims = {
    expiresAt: Date.now() + 60_000,
    kind: 'mount-ticket',
    origin: input.origin || undefined,
    userId: normalizeMountedUserId(input.userId),
    version: 1,
  };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = createHmac('sha256', identitySecret()).update(payload, 'utf8').digest('base64url');
  return { ticket: `${payload}.${signature}`, userId: claims.userId };
}
