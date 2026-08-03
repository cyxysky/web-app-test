import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applicationUserRuntimeKey,
  defaultApplicationUserId,
  DEFAULT_APPLICATION_USER_ID,
  normalizeApplicationUserId,
  requestApplicationUserId,
} from './user-context';

test('missing application user ids normalize to user 0', () => {
  assert.equal(DEFAULT_APPLICATION_USER_ID, '0');
  assert.equal(normalizeApplicationUserId(undefined), '0');
  assert.equal(normalizeApplicationUserId(''), '0');
  assert.equal(normalizeApplicationUserId('   '), '0');
});

test('reads the default application user id from the environment', () => {
  assert.equal(defaultApplicationUserId({ WEBPILOT_DEFAULT_USER_ID: ' 42 ' }), '42');
  assert.equal(defaultApplicationUserId({ WEBPILOT_DEFAULT_USER_ID: '' }), '0');
});

test('application user ids are stable strings and runtime keys stay isolated', () => {
  assert.equal(normalizeApplicationUserId(0), '0');
  assert.equal(normalizeApplicationUserId(' 42 '), '42');
  assert.equal(applicationUserRuntimeKey(0), 'user:0');
  assert.equal(applicationUserRuntimeKey('42'), 'user:42');
  assert.notEqual(applicationUserRuntimeKey('42'), applicationUserRuntimeKey('43'));
});

test('request user ids prefer body values and fall back to query values', () => {
  const request = new Request('http://localhost/api/browser-chat?userId=7');
  assert.equal(requestApplicationUserId(request), '7');
  assert.equal(requestApplicationUserId(request, { userId: '9' }), '9');
  assert.equal(requestApplicationUserId(request, { qzUserId: '11' }), '11');
});

test('missing request user ids fall back to the default user', () => {
  const request = new Request('http://localhost/api/browser-chat');
  assert.equal(requestApplicationUserId(request), DEFAULT_APPLICATION_USER_ID);
});

