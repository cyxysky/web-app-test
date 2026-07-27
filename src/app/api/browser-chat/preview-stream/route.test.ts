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

test('uses the direct preview port when the application has no base path', () => {
  const request = new Request('http://localhost:3000/api/browser-chat/preview-stream');
  assert.equal(
    browserReachableUrl(request, 18021, ''),
    'ws://127.0.0.1:18021/browser-preview',
  );
});
