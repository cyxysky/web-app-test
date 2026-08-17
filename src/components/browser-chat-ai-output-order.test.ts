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

test('does not assign ignored parallel tool calls to later executed traces', () => {
  const toolCycle = (id: string, sourceCycleId: string, fileName: string) => ({
    id,
    sourceCycleId,
    stepIndex: 17,
    output: aiOutputViewFromResponse({
      content: [{ type: 'tool-call', toolCallId: id, toolName: 'generateFile', input: { fileName } }],
    }),
  });
  const steps: StepExecutionResult[] = [{
    index: 17,
    action: 'generate files',
    actual: 'done',
    expected: 'files',
    status: 'passed',
    tools: [
      { id: 'legacy-trace-1', name: 'generateFile', input: { fileName: '张富贵.docx' }, ok: true },
      { id: 'legacy-trace-2', name: 'generateFile', input: { fileName: '周成峰.docx' }, ok: true },
      { id: 'legacy-trace-3', name: 'generateFile', input: { fileName: '陈劲帆.docx' }, ok: true },
    ],
  }];

  const details = buildAiCycleToolDetailMap([
    toolCycle('provider-call-1', 'provider-cycle-1', '张富贵.docx'),
    toolCycle('provider-call-ignored-2', 'provider-cycle-1', '周成峰.docx'),
    toolCycle('provider-call-ignored-3', 'provider-cycle-1', '陈劲帆.docx'),
    toolCycle('provider-call-4', 'provider-cycle-2', '周成峰.docx'),
    toolCycle('provider-call-5', 'provider-cycle-3', '陈劲帆.docx'),
  ], steps);

  assert.equal(details.get('provider-call-1:0')?.tool.id, 'legacy-trace-1');
  assert.equal(details.get('provider-call-ignored-2:0'), undefined);
  assert.equal(details.get('provider-call-ignored-3:0'), undefined);
  assert.equal(details.get('provider-call-4:0')?.tool.id, 'legacy-trace-2');
  assert.equal(details.get('provider-call-5:0')?.tool.id, 'legacy-trace-3');
});
