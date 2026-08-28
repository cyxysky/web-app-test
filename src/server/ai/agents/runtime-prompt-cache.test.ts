import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelMessage } from 'ai';
import {
  appendRuntimePromptCacheMetadata,
  runtimeCurrentTimeMarker,
  runtimeOperationalContextMarker,
  withoutRuntimePromptCacheMetadata,
} from './runtime-prompt-cache';

const baseMessages: ModelMessage[] = [
  { role: 'user', content: 'Test the CRM workflow' },
  { role: 'assistant', content: 'I am checking the page.' },
];

test('appends dynamic runtime metadata after the stable conversation prefix', () => {
  const result = appendRuntimePromptCacheMetadata({
    messages: baseMessages,
    operationalContext: 'Available skill: browser',
    currentTimeLine: 'Current time: 2026-08-28 10:00',
  });

  assert.deepEqual(result.messages.slice(0, baseMessages.length), baseMessages);
  assert.ok(String(result.messages[2]?.content).startsWith(runtimeOperationalContextMarker));
  assert.ok(String(result.messages[3]?.content).startsWith(runtimeCurrentTimeMarker));
  assert.deepEqual(result.metadataMessages, result.messages.slice(baseMessages.length));
});

test('does not duplicate unchanged runtime metadata during one tool loop', () => {
  const first = appendRuntimePromptCacheMetadata({
    messages: baseMessages,
    operationalContext: 'Available skill: browser',
    currentTimeLine: 'Current time: 2026-08-28 10:00',
  });
  const second = appendRuntimePromptCacheMetadata({
    messages: first.messages,
    operationalContext: 'Available skill: browser',
    currentTimeLine: 'Current time: 2026-08-28 10:00',
  });

  assert.equal(second.messages.length, first.messages.length);
});

test('appends a changed operational snapshot without rewriting the cached prefix', () => {
  const first = appendRuntimePromptCacheMetadata({
    messages: baseMessages,
    operationalContext: 'Files: none',
    currentTimeLine: 'Current time: 2026-08-28 10:00',
  });
  const second = appendRuntimePromptCacheMetadata({
    messages: [...first.messages, { role: 'assistant', content: 'The file is ready.' }],
    operationalContext: 'Files: report.docx',
    currentTimeLine: 'Current time: 2026-08-28 10:00',
  });

  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
  assert.match(String(second.messages.at(-1)?.content), /Files: report\.docx/);
});

test('appends a clearing snapshot when operational context becomes empty', () => {
  const first = appendRuntimePromptCacheMetadata({
    messages: baseMessages,
    operationalContext: 'Files: report.docx',
    currentTimeLine: 'Current time: 2026-08-28 10:00',
  });
  const second = appendRuntimePromptCacheMetadata({
    messages: first.messages,
    operationalContext: '',
    currentTimeLine: 'Current time: 2026-08-28 10:00',
  });

  assert.equal(second.messages.length, first.messages.length + 1);
  assert.match(String(second.messages.at(-1)?.content), /No runtime operational context is currently active\./);
  assert.match(String(second.metadataMessages[0]?.content), /No runtime operational context is currently active\./);
});

test('removes runtime metadata before continuation summarization', () => {
  const withMetadata = appendRuntimePromptCacheMetadata({
    messages: baseMessages,
    operationalContext: 'Sensitive runtime capability references',
    currentTimeLine: 'Current time: 2026-08-28 10:00',
  }).messages;

  assert.deepEqual(withoutRuntimePromptCacheMetadata(withMetadata), baseMessages);
});
