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

test('matches persisted tool traces only by exact call ID', () => {
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
      { id: 'read-1', input: { attachmentId: 'file.pdf', limit: 20_000 }, name: 'readFile', ok: false, reason: 'first read', result: 'failed' },
      { id: 'read-2', input: { attachmentId: 'file.pdf', limit: 20_000 }, name: 'readFile', ok: false, reason: 'second read', result: 'failed' },
    ],
  }];

  const details = buildAiCycleToolDetailMap([
    { id: 'cycle-1', output: firstOutput, stepIndex: 1 },
    { id: 'cycle-2', output: secondOutput, stepIndex: 1 },
  ], steps);

  assert.equal(details.get('cycle-1:0')?.tool.id, 'read-1');
  assert.equal(details.get('cycle-2:0')?.tool.id, 'read-2');
});

test('does not synthesize matches for traces without the provider call ID', () => {
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

  assert.equal(details.get('provider-call-1:0'), undefined);
  assert.equal(details.get('provider-call-ignored-2:0'), undefined);
  assert.equal(details.get('provider-call-ignored-3:0'), undefined);
  assert.equal(details.get('provider-call-4:0'), undefined);
  assert.equal(details.get('provider-call-5:0'), undefined);
});

test('keeps unmatched requests hidden while matching later exact tool IDs', () => {
  const steps: StepExecutionResult[] = [{
    index: 2,
    action: 'read attendance',
    actual: 'done',
    expected: 'attendance data',
    status: 'passed',
    tools: [
      { id: 'executed-hover', input: { code: 'hover()' }, name: 'browserCode', ok: true, reason: 'hover menu' },
      { id: 'executed-read', input: { code: 'read()' }, name: 'browserCode', ok: true, reason: 'read attendance' },
    ],
  }];
  const details = buildAiCycleToolDetailMap([
    {
      id: 'phantom-cycle',
      output: aiOutputViewFromResponse({
        content: [{
          type: 'tool-call',
          toolCallId: 'unexecuted-call',
          toolName: 'browserCode',
          input: { cell: 'navigate()', reason: 'unexecuted request' },
        }],
      }),
      stepIndex: 2,
    },
    {
      id: 'hover-cycle',
      output: aiOutputViewFromResponse({
        content: [{
          type: 'tool-call',
          toolCallId: 'executed-hover',
          toolName: 'browserCode',
          input: { code: 'hover()', reason: 'hover menu' },
        }],
      }),
      stepIndex: 2,
    },
    {
      id: 'read-cycle',
      output: aiOutputViewFromResponse({
        content: [{
          type: 'tool-call',
          toolCallId: 'executed-read',
          toolName: 'browserCode',
          input: { code: 'read()', reason: 'read attendance' },
        }],
      }),
      stepIndex: 2,
    },
  ], steps);

  assert.equal(details.get('phantom-cycle:0'), undefined);
  assert.equal(details.get('hover-cycle:0')?.tool.id, 'executed-hover');
  assert.equal(details.get('read-cycle:0')?.tool.id, 'executed-read');
});
