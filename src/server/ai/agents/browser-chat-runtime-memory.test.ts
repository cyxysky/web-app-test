import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compactBrowserChatLogDetails,
  trimBrowserChatRuntimeItems,
  trimBrowserChatRuntimeLogs,
} from './browser-chat-runtime-memory';

test('compacts oversized log details into bounded valid JSON', () => {
  const compacted = compactBrowserChatLogDetails(JSON.stringify({ prompt: 'x'.repeat(20_000) }), 1_000);
  assert.ok(compacted);
  assert.ok(compacted.length <= 1_000);
  const parsed = JSON.parse(compacted);
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.originalCharacters > 20_000);
});

test('oversized input logs retain an inspectable request and durable context manifest id', () => {
  const compacted = compactBrowserChatLogDetails(JSON.stringify({
    aiInput: { provider: 'minimax', model: 'MiniMax-M3', system: 'rules'.repeat(10000), messages: [{ role: 'tool', content: 'evidence'.repeat(20000) }],
      options: { contextManifest: { id: 'ctxreq-test', entries: Array.from({ length: 300 }, (_, index) => ({ ref: `ctx-${index}`, reason: 'archived' })),
        knowledge: Array.from({ length: 300 }, (_, index) => ({ id: `skill-${index}`, reason: 'selected complete operating rules', selected: true })) } } },
    aiInputTokens: { estimatedTotalTokens: 120000 },
  }), 2000);
  const parsed = JSON.parse(compacted!);
  assert.ok(compacted!.length <= 2000);
  assert.equal(parsed.aiInput.options.contextManifest.id, 'ctxreq-test');
  assert.equal(parsed.aiInput.options.contextManifest.entriesArchived, true);
  assert.equal(parsed.aiInput.options.contextManifest.knowledgeCount, 300);
  assert.deepEqual(parsed.aiInput.options.contextManifest.knowledge, []);
  assert.equal(parsed.aiInputTokens.estimatedTotalTokens, 120000);
});

test('retains newest logs within both count and character budgets', () => {
  const logs = Array.from({ length: 10 }, (_, index) => ({
    id: String(index),
    phase: 'ai:runtime:request',
    message: `request ${index}`,
    details: 'x'.repeat(400),
  }));
  const retained = trimBrowserChatRuntimeLogs(logs, {
    maxCharacters: 1_200,
    maxCount: 8,
    maxDetailCharacters: 300,
  });
  assert.ok(retained.length > 0);
  assert.ok(retained.length < 8);
  assert.equal(retained.at(-1)?.id, '9');
  assert.ok(retained.every((log) => (log.details?.length || 0) <= 300));
});

test('trims runtime item lists from the oldest edge', () => {
  assert.deepEqual(trimBrowserChatRuntimeItems([1, 2, 3, 4], 2), [3, 4]);
});
