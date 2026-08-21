import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applicationUserRuntimeKey,
  defaultApplicationUserId,
  DEFAULT_APPLICATION_USER_ID,
  normalizeApplicationUserId,
  requestApplicationUserId,
  requestWorkspaceApplicationPrincipal,
} from './user-context';

test('missing application user ids normalize to user 1', () => {
  assert.equal(DEFAULT_APPLICATION_USER_ID, '1');
  assert.equal(normalizeApplicationUserId(undefined), '1');
  assert.equal(normalizeApplicationUserId(''), '1');
  assert.equal(normalizeApplicationUserId('   '), '1');
});

test('reads the default application user id from the environment', () => {
  assert.equal(defaultApplicationUserId({ WEBPILOT_DEFAULT_USER_ID: ' 42 ' }), '42');
  assert.equal(defaultApplicationUserId({ WEBPILOT_DEFAULT_USER_ID: '' }), '1');
});

test('application user ids are stable strings and runtime keys stay isolated', () => {
  assert.equal(normalizeApplicationUserId(0), '0');
  assert.equal(normalizeApplicationUserId(' 42 '), '42');
  assert.equal(applicationUserRuntimeKey(0), 'user:0');
  assert.equal(applicationUserRuntimeKey('42'), 'user:42');
  assert.notEqual(applicationUserRuntimeKey('42'), applicationUserRuntimeKey('43'));
});

test('request user ids only use the principal injected by the custom server', () => {
  const previousSecret = process.env.WEBPILOT_IDENTITY_HEADER_SECRET;
  process.env.WEBPILOT_IDENTITY_HEADER_SECRET = 'test-header-secret';
  const request = new Request('http://localhost/api/browser-chat?userId=7', {
    headers: {
      'x-webpilot-identity-proof': 'test-header-secret',
      'x-webpilot-identity-user-id': '42',
      'x-webpilot-identity-username': 'alice',
    },
  });
  try {
    assert.equal(requestApplicationUserId(request), '42');
  } finally {
    if (previousSecret === undefined) delete process.env.WEBPILOT_IDENTITY_HEADER_SECRET;
    else process.env.WEBPILOT_IDENTITY_HEADER_SECRET = previousSecret;
  }
});

test('requests without an injected principal are rejected', () => {
  const request = new Request('http://localhost/api/browser-chat');
  assert.throws(() => requestApplicationUserId(request), /Authentication required/);
});

test('spoofed identity headers without the custom-server proof are rejected', () => {
  const previousSecret = process.env.WEBPILOT_IDENTITY_HEADER_SECRET;
  process.env.WEBPILOT_IDENTITY_HEADER_SECRET = 'real-secret';
  try {
    const request = new Request('http://localhost/api/browser-chat', {
      headers: {
        'x-webpilot-identity-proof': 'forged-secret',
        'x-webpilot-identity-user-id': 'admin',
        'x-webpilot-identity-username': 'admin',
      },
    });
    assert.throws(() => requestApplicationUserId(request), /Authentication required/);
  } finally {
    if (previousSecret === undefined) delete process.env.WEBPILOT_IDENTITY_HEADER_SECRET;
    else process.env.WEBPILOT_IDENTITY_HEADER_SECRET = previousSecret;
  }
});

test('workspace rendering retains the UI-host identity when Next omits the private proof header', () => {
  const previousRole = process.env.WEBPILOT_SERVER_ROLE;
  const previousRequireMounted = process.env.WEBPILOT_REQUIRE_MOUNT_USER_ID;
  process.env.WEBPILOT_SERVER_ROLE = 'ui';
  delete process.env.WEBPILOT_REQUIRE_MOUNT_USER_ID;
  try {
    const principal = requestWorkspaceApplicationPrincipal(new Request('http://localhost/browser-chat', {
      headers: {
        'x-webpilot-identity-user-id': '1',
        'x-webpilot-identity-username': '1',
        'x-webpilot-identity-roles': 'user',
      },
    }));
    assert.equal(principal.userId, '1');
    assert.deepEqual(principal.roles, ['user']);
  } finally {
    if (previousRole === undefined) delete process.env.WEBPILOT_SERVER_ROLE;
    else process.env.WEBPILOT_SERVER_ROLE = previousRole;
    if (previousRequireMounted === undefined) delete process.env.WEBPILOT_REQUIRE_MOUNT_USER_ID;
    else process.env.WEBPILOT_REQUIRE_MOUNT_USER_ID = previousRequireMounted;
  }
});

test('workspace identity fallback stays unavailable outside the UI host', () => {
  const previousRole = process.env.WEBPILOT_SERVER_ROLE;
  process.env.WEBPILOT_SERVER_ROLE = 'runtime';
  try {
    assert.throws(
      () => requestWorkspaceApplicationPrincipal(new Request('http://localhost/browser-chat')),
      /Authentication required/,
    );
  } finally {
    if (previousRole === undefined) delete process.env.WEBPILOT_SERVER_ROLE;
    else process.env.WEBPILOT_SERVER_ROLE = previousRole;
  }
});

