import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeModelLogValue } from './browser-chat-executor.agent';

test('serializes a distinct Error cause once instead of labeling it circular', () => {
  const cause = new Error('query exceeds the configured limit');
  const error = new Error('invalid file tool input', { cause }) as Error & { toolName?: string };
  error.toolName = 'file';
  const sanitized = sanitizeModelLogValue(error, [], { imageIndex: 0 });
  assert.doesNotMatch(JSON.stringify(sanitized), /\[Circular\]/);
  assert.deepEqual(sanitized, {
    toolName: 'file',
    name: 'Error',
    message: 'invalid file tool input',
    stack: error.stack,
    cause: {
      name: 'Error',
      message: 'query exceeds the configured limit',
      stack: cause.stack,
    },
  });
});
