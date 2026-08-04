/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  defaultUserId,
  identityCookie,
  mountTicketClaims,
  requestIdentity,
  signedValue,
} = require('./webpilot-identity');

function request(cookie = '') {
  return {
    headers: cookie ? { cookie } : {},
    socket: { remoteAddress: '127.0.0.1' },
  };
}

test('local identity defaults to user 1 and supports an environment override', () => {
  const previous = process.env.WEBPILOT_DEFAULT_USER_ID;
  try {
    delete process.env.WEBPILOT_DEFAULT_USER_ID;
    assert.equal(defaultUserId(), '1');
    process.env.WEBPILOT_DEFAULT_USER_ID = 'developer-2';
    assert.equal(requestIdentity(request()).userId, 'developer-2');
  } finally {
    if (previous === undefined) delete process.env.WEBPILOT_DEFAULT_USER_ID;
    else process.env.WEBPILOT_DEFAULT_USER_ID = previous;
  }
});

test('a signed mount ticket initializes an HttpOnly identity session cookie', () => {
  const previousSecret = process.env.WEBPILOT_IDENTITY_SECRET;
  process.env.WEBPILOT_IDENTITY_SECRET = 'test-identity-secret';
  try {
    const ticket = signedValue({
      expiresAt: Date.now() + 60_000,
      kind: 'mount-ticket',
      origin: 'https://host.test',
      userId: 'mounted-7',
      version: 1,
    });
    assert.equal(mountTicketClaims(ticket).userId, 'mounted-7');
    const setCookie = identityCookie('mounted-7', request());
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    const cookie = setCookie.split(';', 1)[0];
    assert.equal(requestIdentity(request(cookie)).userId, 'mounted-7');
  } finally {
    if (previousSecret === undefined) delete process.env.WEBPILOT_IDENTITY_SECRET;
    else process.env.WEBPILOT_IDENTITY_SECRET = previousSecret;
  }
});

test('mount-only mode rejects requests before a mounted identity is initialized', () => {
  const previous = process.env.WEBPILOT_REQUIRE_MOUNT_USER_ID;
  process.env.WEBPILOT_REQUIRE_MOUNT_USER_ID = 'true';
  try {
    assert.equal(requestIdentity(request()), undefined);
  } finally {
    if (previous === undefined) delete process.env.WEBPILOT_REQUIRE_MOUNT_USER_ID;
    else process.env.WEBPILOT_REQUIRE_MOUNT_USER_ID = previous;
  }
});
