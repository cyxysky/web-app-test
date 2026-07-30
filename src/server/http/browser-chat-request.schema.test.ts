import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBrowserChatSessionRequestSchema,
  sendBrowserChatMessageRequestSchema,
} from './browser-chat-request.schema';

test('browser chat requests cannot override the application-wide browser mode', () => {
  assert.equal(createBrowserChatSessionRequestSchema.parse({ targetUrl: '' }).safetyMode, 'strict');
  assert.equal(sendBrowserChatMessageRequestSchema.parse({ content: '' }).safetyMode, 'strict');

  assert.throws(
    () => createBrowserChatSessionRequestSchema.parse({ targetUrl: '', mode: 'dom' }),
    /Unrecognized key.*mode|unrecognized_keys/i,
  );
  assert.throws(
    () => sendBrowserChatMessageRequestSchema.parse({ content: '', mode: 'code' }),
    /Unrecognized key.*mode|unrecognized_keys/i,
  );
});
