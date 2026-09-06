import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelMessage } from 'ai';
import {
  attachRuntimeFailureRecovery,
  runtimeFailureRecoveryFromError,
} from './runtime-retry-state';

test('request retry exhaustion carries the exact failed turn working set forward', () => {
  const history: ModelMessage[] = [
    { role: 'user', content: '填写酒店表单' },
    { role: 'assistant', content: '酒店表单已填写' },
  ];
  const currentTurn: ModelMessage[] = [
    { role: 'user', content: '现在预订机场接送' },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'browserCode', input: { code: 'choose return date' } }],
    },
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'browserCode', output: { type: 'text', value: 'date picker opened' } }],
    },
  ];
  const error = new Error('upstream disconnected');
  attachRuntimeFailureRecovery(error, {
    agentStepOffset: 23,
    imagePaths: [],
    messages: [...history, ...currentTurn],
  }, history.length);

  const recovery = runtimeFailureRecoveryFromError(error);
  assert.deepEqual(recovery?.messages, [...history, ...currentTurn]);
  assert.deepEqual(recovery?.turnMessages, currentTurn);
  assert.equal(recovery?.agentStepOffset, 23);
});

test('uses explicit turn messages when context segmentation removed the original prefix', () => {
  const compacted: ModelMessage[] = [{ role: 'user', content: '[WebPilot continuation summary]\n机场接送日期已打开' }];
  const fallback: ModelMessage[] = [{ role: 'user', content: '现在预订机场接送' }];
  const error = new Error('upstream disconnected');
  attachRuntimeFailureRecovery(error, {
    agentStepOffset: 8,
    imagePaths: [],
    messages: compacted,
  }, 20, fallback);

  assert.deepEqual(runtimeFailureRecoveryFromError(error)?.turnMessages, fallback);
});

test('an explicit SDK transcript overrides a shortened retry working set', () => {
  const original: ModelMessage[] = [{ role: 'user', content: 'Keep documentId=report-1.' }, { role: 'assistant', content: 'original response' }];
  const projected: ModelMessage[] = [{ role: 'user', content: 'derived state' }];
  const error = new Error('retry exhausted');
  attachRuntimeFailureRecovery(error, { agentStepOffset: 2, imagePaths: [], messages: projected }, 0, [], original);
  assert.deepEqual(runtimeFailureRecoveryFromError(error)?.messages, projected);
  assert.deepEqual(runtimeFailureRecoveryFromError(error)?.turnMessages, original);
});
