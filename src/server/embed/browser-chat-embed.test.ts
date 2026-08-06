import assert from 'node:assert/strict';
import test from 'node:test';
import { joinWebPilotUrl, WEBPILOT_BASE_PATH } from '@/lib/webpilot-base-path';
import { publicBaseUrl } from './browser-chat-embed';

test('publicBaseUrl uses the same-origin browser URL behind a TLS terminating proxy', () => {
  const request = new Request('http://127.0.0.1:3000/api/embed/browser-chat/init', {
    method: 'POST',
    headers: {
      host: '10.10.0.90',
      origin: 'https://10.10.0.90',
    },
  });
  assert.equal(
    publicBaseUrl(request),
    joinWebPilotUrl('https://10.10.0.90', WEBPILOT_BASE_PATH).replace(/\/+$/g, ''),
  );
});

test('publicBaseUrl uses the current browser domain instead of a manually configured host', () => {
  const request = new Request('http://127.0.0.1:3000/api/embed/browser-chat/init', {
    method: 'POST',
    headers: {
      host: '127.0.0.1:3000',
      origin: 'https://10.10.0.90',
      'x-forwarded-host': 'stale.example',
      'x-forwarded-proto': 'https',
    },
  });
  assert.equal(
    publicBaseUrl(request),
    joinWebPilotUrl('https://10.10.0.90', WEBPILOT_BASE_PATH).replace(/\/+$/g, ''),
  );
});

test('publicBaseUrl falls back to the reverse proxy address without a browser origin', () => {
  const request = new Request('http://127.0.0.1:3000/api/embed/browser-chat/init', {
    method: 'POST',
    headers: {
      host: '127.0.0.1:3000',
      'x-forwarded-host': '10.10.0.90',
      'x-forwarded-proto': 'https',
    },
  });
  assert.equal(
    publicBaseUrl(request),
    joinWebPilotUrl('https://10.10.0.90', WEBPILOT_BASE_PATH).replace(/\/+$/g, ''),
  );
});
