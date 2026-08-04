import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createMountIdentityTicket } from './mount-identity';

const require = createRequire(import.meta.url);
const identityRuntime = require('../../../server/webpilot-identity.js') as {
  mountTicketClaims(ticket: string): { userId: string } | undefined;
};

test('creates a signed short-lived ticket for the mounted user id', () => {
  const previous = process.env.WEBPILOT_IDENTITY_SECRET;
  process.env.WEBPILOT_IDENTITY_SECRET = 'test-identity-secret';
  try {
    const result = createMountIdentityTicket({ origin: 'https://host.test', userId: ' mounted-2 ' });
    assert.equal(result.userId, 'mounted-2');
    assert.match(result.ticket, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const claims = JSON.parse(Buffer.from(result.ticket.split('.')[0], 'base64url').toString('utf8'));
    assert.equal(claims.userId, 'mounted-2');
    assert.equal(claims.kind, 'mount-ticket');
    assert.ok(claims.expiresAt > Date.now());
    assert.ok(claims.expiresAt <= Date.now() + 60_000);
    assert.equal(identityRuntime.mountTicketClaims(result.ticket)?.userId, 'mounted-2');
  } finally {
    if (previous === undefined) delete process.env.WEBPILOT_IDENTITY_SECRET;
    else process.env.WEBPILOT_IDENTITY_SECRET = previous;
  }
});

test('rejects a missing or invalid mounted user id', () => {
  const previous = process.env.WEBPILOT_IDENTITY_SECRET;
  process.env.WEBPILOT_IDENTITY_SECRET = 'test-identity-secret';
  try {
    assert.throws(() => createMountIdentityTicket({ userId: '' }), /mounted user ID/);
    assert.throws(() => createMountIdentityTicket({ userId: '../escape' }), /mounted user ID/);
  } finally {
    if (previous === undefined) delete process.env.WEBPILOT_IDENTITY_SECRET;
    else process.env.WEBPILOT_IDENTITY_SECRET = previous;
  }
});
