import assert from 'node:assert/strict';
import test from 'node:test';
import { joinWebPilotUrl, WEBPILOT_BASE_PATH } from '@/lib/webpilot-base-path';
import { publicBaseUrl } from './browser-chat-embed';

test('publicBaseUrl uses the same-origin browser URL behind a TLS terminating proxy', () => {
  const previous = process.env.WEBPILOT_PUBLIC_BASE_URL;
  delete process.env.WEBPILOT_PUBLIC_BASE_URL;
  try {
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
  } finally {
    if (previous === undefined) delete process.env.WEBPILOT_PUBLIC_BASE_URL;
    else process.env.WEBPILOT_PUBLIC_BASE_URL = previous;
  }
});

test('publicBaseUrl does not mistake a cross-origin caller for the WebPilot host', () => {
  const previous = process.env.WEBPILOT_PUBLIC_BASE_URL;
  delete process.env.WEBPILOT_PUBLIC_BASE_URL;
  try {
    const request = new Request('http://127.0.0.1:3000/api/embed/browser-chat/init', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:3000',
        origin: 'https://parent.example',
        'x-forwarded-host': 'webpilot.example',
        'x-forwarded-proto': 'https',
      },
    });
    assert.equal(
      publicBaseUrl(request),
      joinWebPilotUrl('https://webpilot.example', WEBPILOT_BASE_PATH).replace(/\/+$/g, ''),
    );
  } finally {
    if (previous === undefined) delete process.env.WEBPILOT_PUBLIC_BASE_URL;
    else process.env.WEBPILOT_PUBLIC_BASE_URL = previous;
  }
});
