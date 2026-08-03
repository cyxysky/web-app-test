import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adminSettingsPasswordConfigured,
  adminSettingsPasswordEnabled,
  createAdminSettingsAccessToken,
  requestHasAdminSettingsAccess,
  verifyAdminSettingsAccessToken,
  verifyAdminSettingsPassword,
} from './admin-settings-access';

const enabledEnv = {
  WEBPILOT_ADMIN_SETTINGS_PASSWORD_ENABLED: 'true',
  WEBPILOT_ADMIN_SETTINGS_PASSWORD: 'correct horse battery staple',
};

test('administrator settings password protection is opt-in', () => {
  assert.equal(adminSettingsPasswordEnabled({}), false);
  assert.equal(adminSettingsPasswordEnabled(enabledEnv), true);
  assert.equal(adminSettingsPasswordConfigured(enabledEnv), true);
  assert.equal(verifyAdminSettingsPassword('anything', {}), true);
});

test('administrator settings password is checked without exposing it', () => {
  assert.equal(verifyAdminSettingsPassword('wrong', enabledEnv), false);
  assert.equal(verifyAdminSettingsPassword('correct horse battery staple', enabledEnv), true);
});

test('administrator settings access tokens are signed and expire', () => {
  const issuedAt = 1_800_000_000_000;
  const token = createAdminSettingsAccessToken(enabledEnv, issuedAt);
  assert.equal(verifyAdminSettingsAccessToken(token, enabledEnv, issuedAt + 1), true);
  assert.equal(verifyAdminSettingsAccessToken(`${token}x`, enabledEnv, issuedAt + 1), false);
  assert.equal(verifyAdminSettingsAccessToken(token, enabledEnv, issuedAt + 4 * 60 * 60 * 1000), false);

  const request = new Request('http://localhost/api/settings/env', {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(requestHasAdminSettingsAccess(request, enabledEnv), true);
  assert.equal(requestHasAdminSettingsAccess(new Request(request.url), enabledEnv), false);
});
