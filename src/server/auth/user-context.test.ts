import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applicationUserRuntimeKey,
  defaultApplicationUserId,
  DEFAULT_APPLICATION_USER_ID,
  normalizeApplicationUserId,
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

