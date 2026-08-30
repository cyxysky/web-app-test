import { expect, test } from 'vitest';
import { browserChatAiOutputCycleFromDebugEvent } from '../lib/browser-chat-output-cycles';
import { browserChatCurrentTurnAssistantMessageId } from './browser-chat-output-files-state';
import {
  browserChatToolContextTokenMetrics,
  browserChatToolTimingMetrics,
} from './browser-chat-tool-context';

test('computes complete tool context token deltas including decreases', () => {
  expect(browserChatToolContextTokenMetrics({
    contextBefore: { estimatedTotalTokens: 12_400 },
    contextAfter: { estimatedTotalTokens: 13_025 },
  })).toEqual({ before: 12_400, after: 13_025, delta: 625 });
  expect(browserChatToolContextTokenMetrics({
    contextBefore: { estimatedTotalTokens: 80_000 },
    contextAfter: { estimatedTotalTokens: 31_000 },
  })).toEqual({ before: 80_000, after: 31_000, delta: -49_000 });
});

test('normalizes tool and provider API elapsed times', () => {
  expect(browserChatToolTimingMetrics({
    elapsedMs: 12_345.4,
    aiRequestElapsedMs: 2_345.6,
  })).toEqual({
    toolElapsedMs: 12_345,
    aiRequestElapsedMs: 2_346,
  });
  expect(browserChatToolTimingMetrics({
    elapsedMs: -1,
    aiRequestElapsedMs: Number.NaN,
  })).toEqual({
    toolElapsedMs: undefined,
    aiRequestElapsedMs: undefined,
  });
});

test('keeps the previous output list collapsed as soon as a new user turn starts', () => {
  const firstTurn = [
    { id: 'user-1', role: 'user' as const },
    { id: 'assistant-1', role: 'assistant' as const },
  ];
  expect(browserChatCurrentTurnAssistantMessageId(firstTurn)).toBe('assistant-1');
  expect(browserChatCurrentTurnAssistantMessageId([
    ...firstTurn,
    { id: 'user-2', role: 'user' as const },
  ])).toBeUndefined();
  expect(browserChatCurrentTurnAssistantMessageId([
    ...firstTurn,
    { id: 'user-2', role: 'user' as const },
    { id: 'assistant-2', role: 'assistant' as const },
  ])).toBe('assistant-2');
});

test('turns context compression completion into an ordered tool output cycle', () => {
  const cycle = browserChatAiOutputCycleFromDebugEvent({
    details: {
      estimatedTokensBefore: 92_000,
      estimatedTokensAfter: 34_000,
      toolCallId: 'context-compression:run:1:1',
    },
    id: 'cycle-1',
    messageId: 'assistant-1',
    phase: 'ai:context-compression:complete',
    stepIndex: 1,
  });

  expect(cycle?.output.tools[0]?.id).toBe('context-compression:run:1:1');
  expect(cycle?.output.tools[0]?.name).toBe('contextCompression');
  expect(cycle?.output.tools[0]?.input).toEqual({
    estimatedTokensBefore: 92_000,
    estimatedTokensAfter: 34_000,
  });
  expect(cycle?.output.tools[0]?.ok).toBe(true);
});
