import assert from 'node:assert/strict';
import test from 'node:test';
import { POST } from './route';

test('internal shutdown endpoint rejects requests without the Electron token', async () => {
  const previousToken = process.env.WEBPILOT_INTERNAL_SHUTDOWN_TOKEN;
  try {
    process.env.WEBPILOT_INTERNAL_SHUTDOWN_TOKEN = 'shutdown-test-token';
    const response = await POST(new Request('http://127.0.0.1/api/system/shutdown', { method: 'POST' }));
    assert.equal(response.status, 404);
  } finally {
    if (previousToken === undefined) delete process.env.WEBPILOT_INTERNAL_SHUTDOWN_TOKEN;
    else process.env.WEBPILOT_INTERNAL_SHUTDOWN_TOKEN = previousToken;
  }
});

test('internal shutdown endpoint accepts the private Electron token', async () => {
  const previousToken = process.env.WEBPILOT_INTERNAL_SHUTDOWN_TOKEN;
  try {
    process.env.WEBPILOT_INTERNAL_SHUTDOWN_TOKEN = 'shutdown-test-token';
    const response = await POST(new Request('http://127.0.0.1/api/system/shutdown', {
      method: 'POST',
      headers: { 'x-webpilot-shutdown-token': 'shutdown-test-token' },
    }));
    assert.equal(response.status, 200);
  } finally {
    if (previousToken === undefined) delete process.env.WEBPILOT_INTERNAL_SHUTDOWN_TOKEN;
    else process.env.WEBPILOT_INTERNAL_SHUTDOWN_TOKEN = previousToken;
  }
});
