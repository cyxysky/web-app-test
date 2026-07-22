import assert from 'node:assert/strict';
import test from 'node:test';
import type { StepExecutionResult } from '@/server/ai/schemas/test-case.schema';
import {
  alignBrowserChatMessageStepIndexes,
  attachBrowserChatStepOwners,
} from './browser-chat-step-ownership';

test('keeps child subagent step indexes out of top-level message ownership', () => {
  const initialSteps: StepExecutionResult[] = [
    { index: 1, action: 'first turn', expected: '', actual: '', status: 'passed' as const },
    { index: 6, action: 'current turn', expected: '', actual: '', status: 'running' as const },
  ];
  const steps = attachBrowserChatStepOwners(initialSteps, [
    { messageId: 'first-assistant', phase: 'ai:runtime:response', stepIndex: 1 },
    { messageId: 'current-assistant', phase: 'ai:runtime:response', stepIndex: 6 },
    { messageId: 'current-assistant', phase: 'subagent:child:ai:runtime:response', stepIndex: 1 },
  ]);

  assert.deepEqual(steps.map((step) => [step.index, step.messageId]), [
    [1, 'first-assistant'],
    [6, 'current-assistant'],
  ]);

  const messages = alignBrowserChatMessageStepIndexes([
    { id: 'first-assistant', role: 'assistant' as const, stepIndexes: [] },
    { id: 'current-assistant', role: 'assistant' as const, stepIndexes: [1, 6] },
  ], steps);

  assert.deepEqual(messages[0].stepIndexes, [1]);
  assert.deepEqual(messages[1].stepIndexes, [6]);
});
