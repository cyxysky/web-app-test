import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { normalizeBrowserChatModelContext } from './browser-chat-model-context';
import {
  mergeRuntimeModelMessageChain,
  runtimeContinuationSummaryMarker,
} from './runtime-context-compression';

describe('runtime tool transcript integrity', () => {
  it('uses the retained atomic block to repair a stale explicit response boundary', () => {
    const summary: ModelMessage = {
      role: 'user',
      content: `${runtimeContinuationSummaryMarker}\n{"remaining":["finish review"]}`,
    };
    const oldCall: ModelMessage = {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'old', toolName: 'file', input: {} }],
    };
    const oldResult: ModelMessage = {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'old', toolName: 'file', output: { type: 'text', value: 'old' } }],
    };
    const latestCall: ModelMessage = {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'latest', toolName: 'fileVisual', input: {} }],
    };
    const latestResult: ModelMessage = {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'latest', toolName: 'fileVisual', output: { type: 'text', value: 'reviewed' } }],
    };
    const finalAnswer: ModelMessage = { role: 'assistant', content: 'done' };

    expect(mergeRuntimeModelMessageChain(
      [summary, latestCall, latestResult],
      [oldCall, oldResult, latestCall, latestResult, finalAnswer],
      1,
    )).toEqual([summary, latestCall, latestResult, finalAnswer]);
  });

  it('removes an orphan tool result from a persisted active context', () => {
    const context = normalizeBrowserChatModelContext({
      version: 1,
      transcript: [],
      activeMessages: [
        { role: 'user', content: 'continue' },
        {
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: 'missing', toolName: 'file', output: { type: 'text', value: 'orphan' } }],
        },
        { role: 'assistant', content: 'ready' },
      ],
    });

    expect(context.activeMessages).toEqual([
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'ready' },
    ]);
  });
});
