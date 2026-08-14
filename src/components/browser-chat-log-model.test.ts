import assert from 'node:assert/strict';
import test from 'node:test';
import {
  summarizeBrowserChatExecutionTotals,
  summarizeBrowserChatLogs,
  visibleBrowserChatExecutionLogs,
} from './browser-chat-log-model';

test('visibleBrowserChatExecutionLogs keeps ai, tool, context, and screenshot logs', () => {
  const logs = [
    { phase: 'ai:runtime:attempt' },
    { phase: 'ai:runtime:request' },
    { phase: 'subagent:child-1:ai:runtime:response' },
    { phase: 'subagent:child-1:ai:runtime:attempt-succeeded' },
    { phase: 'ai:runtime:attempt-failed' },
    { phase: 'ai:runtime:retry-exhausted' },
    { phase: 'ai:runtime:attempt-succeeded' },
    { phase: 'ai:runtime:recoverable-error' },
    { phase: 'chat:runtime:request-aborted' },
    { phase: 'ai:tool' },
    { phase: 'subagent:child-1:ai:tool' },
    { phase: 'conversation:context:response' },
    { phase: 'browser:screenshot:capture' },
    { phase: 'chat:message' },
  ];

  assert.deepEqual(visibleBrowserChatExecutionLogs(logs).map((log) => log.phase), [
    'ai:runtime:attempt',
    'ai:runtime:request',
    'subagent:child-1:ai:runtime:response',
    'subagent:child-1:ai:runtime:attempt-succeeded',
    'ai:runtime:attempt-failed',
    'ai:runtime:retry-exhausted',
    'ai:runtime:attempt-succeeded',
    'ai:runtime:recoverable-error',
    'chat:runtime:request-aborted',
    'ai:tool',
    'subagent:child-1:ai:tool',
    'conversation:context:response',
    'browser:screenshot:capture',
  ]);
});

test('summarizeBrowserChatLogs counts visible log categories', () => {
  const summary = summarizeBrowserChatLogs([
    { phase: 'ai:runtime:response' },
    { phase: 'ai:runtime:retry' },
    { phase: 'ai:tool' },
    { phase: 'conversation:context:error' },
    { phase: 'perf:screenshot:compress' },
  ]);

  assert.deepEqual(summary, {
    ai: 2,
    context: 1,
    screenshot: 1,
    tool: 1,
    total: 5,
  });
});

test('visibleBrowserChatExecutionLogs exposes the complete request attempt lifecycle', () => {
  const phases = [
    'ai:runtime:attempt',
    'ai:runtime:attempt-failed',
    'ai:runtime:retry',
    'ai:runtime:attempt-succeeded',
    'ai:runtime:retry-exhausted',
    'ai:runtime:retry-skipped',
  ];
  assert.deepEqual(
    visibleBrowserChatExecutionLogs(phases.map((phase) => ({ phase }))).map((log) => log.phase),
    phases,
  );
});

test('summarizeBrowserChatExecutionTotals sums top-level and subagent runtime timings', () => {
  const totals = summarizeBrowserChatExecutionTotals([
    {
      phase: 'ai:runtime:response',
      details: JSON.stringify({
        aiOutput: {
          timings: {
            aiRequestElapsedMs: 1200,
            toolCount: 2,
            toolElapsedMs: 800,
            toolOverheadElapsedMs: 150,
          },
        },
      }),
    },
    {
      phase: 'subagent:research:ai:runtime:object',
      details: JSON.stringify({
        event: {
          aiOutput: {
            timings: {
              aiRequestElapsedMs: 450,
              toolCount: 1,
              toolElapsedMs: 300,
              toolOverheadElapsedMs: 25,
            },
          },
        },
      }),
    },
    { phase: 'ai:runtime:request', details: '{"aiInput":{}}' },
  ]);

  assert.deepEqual(totals, {
    aiRequestElapsedMs: 1650,
    toolCallCount: 3,
    toolElapsedMs: 1275,
  });
});

test('summarizeBrowserChatExecutionTotals falls back to tool detail durations', () => {
  const totals = summarizeBrowserChatExecutionTotals([{
    phase: 'ai:runtime:response',
    details: {
      aiOutput: {
        timings: {
          aiRequestElapsedMs: 90,
          tools: [{ elapsedMs: 40 }, { elapsedMs: 60 }],
        },
      },
    },
  }]);

  assert.deepEqual(totals, {
    aiRequestElapsedMs: 90,
    toolCallCount: 2,
    toolElapsedMs: 100,
  });
});
