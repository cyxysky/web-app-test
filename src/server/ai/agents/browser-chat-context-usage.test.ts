import assert from 'node:assert/strict';
import test from 'node:test';
import { browserChatContextUsageFromDebugRecord } from './browser-chat-context-usage';

test('reads context usage from a prepared AI request', () => {
  assert.deepEqual(browserChatContextUsageFromDebugRecord({
    aiInputTokens: {
      estimatedImageTokens: 1200,
      estimatedTextTokens: 99000,
      estimatedToolSchemaTokens: 5200,
      estimatedTotalTokens: 105400,
      windowTokens: 256000,
    },
  }, 32000), {
    currentTokens: 105400,
    imageTokens: 1200,
    maxTokens: 256000,
    textTokens: 99000,
    toolTokens: 5200,
  });
});

test('reads live context usage from a compression event', () => {
  assert.deepEqual(browserChatContextUsageFromDebugRecord({
    modelContextStats: {
      estimatedImageTokens: 0,
      estimatedTextTokens: 220000,
      estimatedToolSchemaTokens: 5200,
      estimatedTotalTokens: 225200,
      windowTokens: 256000,
    },
  }, 32000), {
    currentTokens: 225200,
    imageTokens: 0,
    maxTokens: 256000,
    textTokens: 220000,
    toolTokens: 5200,
  });
});
