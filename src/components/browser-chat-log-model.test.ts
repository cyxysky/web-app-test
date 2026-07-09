import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeBrowserChatLogs, visibleBrowserChatExecutionLogs } from './browser-chat-log-model';

test('visibleBrowserChatExecutionLogs keeps ai, context, and screenshot logs', () => {
  const logs = [
    { phase: 'ai:runtime:request' },
    { phase: 'ai:runtime:recoverable-error' },
    { phase: 'chat:runtime:request-aborted' },
    { phase: 'conversation:context:response' },
    { phase: 'browser:screenshot:capture' },
    { phase: 'chat:message' },
  ];

  assert.deepEqual(visibleBrowserChatExecutionLogs(logs).map((log) => log.phase), [
    'ai:runtime:request',
    'ai:runtime:recoverable-error',
    'chat:runtime:request-aborted',
    'conversation:context:response',
    'browser:screenshot:capture',
  ]);
});

test('summarizeBrowserChatLogs counts visible log categories', () => {
  const summary = summarizeBrowserChatLogs([
    { phase: 'ai:runtime:response' },
    { phase: 'ai:runtime:retry' },
    { phase: 'conversation:context:error' },
    { phase: 'perf:screenshot:compress' },
  ]);

  assert.deepEqual(summary, {
    ai: 2,
    context: 1,
    screenshot: 1,
    total: 4,
  });
});
