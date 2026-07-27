import assert from 'node:assert/strict';
import test from 'node:test';
import {
  joinWebPilotUrl,
  normalizeWebPilotBasePath,
  withWebPilotBasePath,
  withoutWebPilotBasePath,
} from './webpilot-base-path';

test('normalizes a configured deployment prefix', () => {
  assert.equal(normalizeWebPilotBasePath(' /webpilot/ '), '/webpilot');
  assert.equal(normalizeWebPilotBasePath('/'), '');
});

test('adds the deployment prefix exactly once', () => {
  assert.equal(withWebPilotBasePath('/api/browser-chat', '/webpilot'), '/webpilot/api/browser-chat');
  assert.equal(withWebPilotBasePath('/webpilot/api/browser-chat', '/webpilot'), '/webpilot/api/browser-chat');
  assert.equal(withWebPilotBasePath('/webpilot?embedded=1', '/webpilot'), '/webpilot?embedded=1');
  assert.equal(withWebPilotBasePath('https://example.com/api', '/webpilot'), 'https://example.com/api');
});

test('removes the deployment prefix for route comparisons', () => {
  assert.equal(withoutWebPilotBasePath('/webpilot/browser-chat', '/webpilot'), '/browser-chat');
  assert.equal(withoutWebPilotBasePath('/browser-chat', '/webpilot'), '/browser-chat');
});

test('joins public URLs without resetting their pathname', () => {
  assert.equal(joinWebPilotUrl('https://example.com/webpilot/', '/browser-chat'), 'https://example.com/webpilot/browser-chat');
});
