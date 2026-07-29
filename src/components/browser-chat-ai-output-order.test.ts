import assert from 'node:assert/strict';
import test from 'node:test';
import type { StepExecutionResult } from '@/server/ai/schemas/runtime.schema';
import { aiOutputViewFromResponse, buildAiCycleToolDetailMap } from './BrowserChatWorkspace';

test('keeps text and tool calls in the provider content order', () => {
  const output = aiOutputViewFromResponse({
    content: [
      { type: 'tool-call', toolCallId: 'read-1', toolName: 'readFile', input: { attachmentId: 'file.pdf' } },
      { type: 'text', text: 'try again' },
      { type: 'tool-call', toolCallId: 'read-2', toolName: 'readFile', input: { attachmentId: 'file.pdf', offset: 20_000 } },
    ],
  });

  assert.deepEqual(output.parts.map((part) => (
    part.kind === 'text' ? `text:${output.texts[part.index]}` : `${part.kind}:${part.index}`
  )), ['tool:0', 'text:try again', 'tool:1']);
});

test('matches normalized same-name tool traces by AI call order', () => {
  const firstOutput = aiOutputViewFromResponse({
    content: [{
      type: 'tool-call',
      toolCallId: 'read-1',
      toolName: 'readFile',
      input: { attachmentId: 'file.pdf', reason: 'first read' },
    }],
  });
  const secondOutput = aiOutputViewFromResponse({
    content: [{
      type: 'tool-call',
      toolCallId: 'read-2',
      toolName: 'readFile',
      input: { attachmentId: 'file.pdf', reason: 'second read' },
    }],
  });
  const steps: StepExecutionResult[] = [{
    index: 1,
    action: 'read file',
    actual: 'failed',
    expected: 'file content',
    status: 'failed',
    tools: [
      { id: 'trace-1', input: { attachmentId: 'file.pdf', limit: 20_000 }, name: 'readFile', ok: false, reason: 'first read', result: 'failed' },
      { id: 'trace-2', input: { attachmentId: 'file.pdf', limit: 20_000 }, name: 'readFile', ok: false, reason: 'second read', result: 'failed' },
    ],
  }];

  const details = buildAiCycleToolDetailMap([
    { id: 'cycle-1', output: firstOutput, stepIndex: 1 },
    { id: 'cycle-2', output: secondOutput, stepIndex: 1 },
  ], steps);

  assert.equal(details.get('cycle-1:0')?.tool.id, 'trace-1');
  assert.equal(details.get('cycle-2:0')?.tool.id, 'trace-2');
});
