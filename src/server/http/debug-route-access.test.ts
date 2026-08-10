import assert from 'node:assert/strict';
import test from 'node:test';
import { debugRoutesEnabled } from './debug-route-access';

test('debug routes default to disabled in production', () => {
  assert.equal(debugRoutesEnabled({ NODE_ENV: 'production' }), false);
});

test('debug routes remain available by default outside production', () => {
  assert.equal(debugRoutesEnabled({ NODE_ENV: 'development' }), true);
  assert.equal(debugRoutesEnabled({ NODE_ENV: 'test' }), true);
});

test('debug route configuration explicitly overrides the environment default', () => {
  assert.equal(debugRoutesEnabled({ NODE_ENV: 'production', WEBPILOT_DEBUG_ROUTES_ENABLED: 'true' }), true);
  assert.equal(debugRoutesEnabled({ NODE_ENV: 'development', WEBPILOT_DEBUG_ROUTES_ENABLED: 'false' }), false);
});
