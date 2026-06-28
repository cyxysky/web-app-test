import assert from 'node:assert/strict';
import test from 'node:test';
import { apiErrorMessage, readApiJson } from './api-client';

test('apiErrorMessage prefers API error and falls back safely', () => {
  assert.equal(apiErrorMessage({ error: 'bad request' }, 'fallback'), 'bad request');
  assert.equal(apiErrorMessage({ message: 'failed' }, 'fallback'), 'failed');
  assert.equal(apiErrorMessage({}, 'fallback'), 'fallback');
});

test('readApiJson throws normalized API errors', async () => {
  const response = new Response(JSON.stringify({ error: 'not allowed' }), { status: 403 });

  await assert.rejects(() => readApiJson(response, 'fallback'), /not allowed/);
});
