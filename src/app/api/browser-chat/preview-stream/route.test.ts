import assert from 'node:assert/strict';
import test from 'node:test';
import { browserReachableUrl } from '@/server/realtime/browser-preview-url';

test('uses the mounted base path and public origin for browser preview WebSocket', () => {
  const request = new Request('http://10.14.1.175:3000/webpilot/api/browser-chat/preview-stream', {
    headers: {
      'x-forwarded-host': '10.10.0.90',
      'x-forwarded-proto': 'https',
    },
  });
  assert.equal(
    browserReachableUrl(request, 18021, '/webpilot'),
    'wss://10.10.0.90/webpilot/browser-preview',
  );
});

test('uses the application port when the application has no base path', () => {
  const request = new Request('http://localhost:3000/api/browser-chat/preview-stream');
  assert.equal(
    browserReachableUrl(request, 18021, ''),
    'ws://localhost:3000/browser-preview',
  );
});

test('uses the browser HTTPS origin when proxy headers are unavailable', () => {
  const request = new Request('http://10.10.0.90/webpilot/api/browser-chat/preview-stream', {
    method: 'POST',
    headers: {
      origin: 'https://10.10.0.90',
    },
  });
  assert.equal(
    browserReachableUrl(request, 18021, '/webpilot'),
    'wss://10.10.0.90/webpilot/browser-preview',
  );
});

test('uses the application port for a local base-path build', () => {
  const request = new Request('http://localhost:3000/webpilot/api/browser-chat/preview-stream');
  assert.equal(
    browserReachableUrl(request, 18021, '/webpilot'),
    'ws://localhost:3000/webpilot/browser-preview',
  );
});

test('ignores framework-generated forwarded headers for a local base-path request', () => {
  const request = new Request('http://localhost:3000/webpilot/api/browser-chat/preview-stream', {
    headers: {
      'x-forwarded-host': 'localhost:3000',
      'x-forwarded-proto': 'http',
    },
  });
  assert.equal(
    browserReachableUrl(request, 18021, '/webpilot'),
    'ws://localhost:3000/webpilot/browser-preview',
  );
});
