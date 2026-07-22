import assert from 'node:assert/strict';
import test from 'node:test';
import { formatToolPayload } from './browser-chat-format';

test('renders control characters in tool payload strings as whitespace', () => {
  const formatted = formatToolPayload({ code: '\nconst value = 1;\n\treturn value;' });

  assert.match(formatted, /"code": "\nconst value = 1;\n\treturn value;"/);
  assert.doesNotMatch(formatted, /\\nconst value/);
  assert.doesNotMatch(formatted, /\\treturn value/);
});

test('expands JSON strings in tool results before rendering', () => {
  const formatted = formatToolPayload({
    actual: JSON.stringify({ ok: false, error: 'first line\nsecond line' }, null, 2),
  });

  assert.match(formatted, /"actual": \{/);
  assert.match(formatted, /"error": "first line\nsecond line"/);
  assert.doesNotMatch(formatted, /\\"ok\\"/);
});
