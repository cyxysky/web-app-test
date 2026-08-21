import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBrowserChatSessionRequestSchema,
  sendBrowserChatMessageRequestSchema,
} from './browser-chat-request.schema';

test('browser chat requests reject caller-controlled identity fields', () => {
  assert.equal(createBrowserChatSessionRequestSchema.parse({ targetUrl: '' }).safetyMode, 'strict');
  assert.equal(sendBrowserChatMessageRequestSchema.parse({ content: '' }).safetyMode, 'strict');

  assert.throws(
    () => createBrowserChatSessionRequestSchema.parse({ targetUrl: '', userId: 'attacker' }),
    /Unrecognized key.*userId|unrecognized_keys/i,
  );
  assert.throws(
    () => sendBrowserChatMessageRequestSchema.parse({ content: '', qzUserId: 'attacker' }),
    /Unrecognized key.*qzUserId|unrecognized_keys/i,
  );
});
