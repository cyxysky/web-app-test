import assert from 'node:assert/strict';
import test from 'node:test';
import type { StepExecutionResult } from '@/server/ai/schemas/runtime.schema';
import { sortBrowserChatAiOutputCycles } from '@/lib/browser-chat-output-cycles';
import { aiOutputViewFromResponse, buildAiCycleToolDetailMap } from './BrowserChatWorkspace';

test('orders late-arriving child Agent cycles by their original execution step', () => {
  const cycles = sortBrowserChatAiOutputCycles([
    { id: 'read-4', output: { parts: [], reasoning: [], texts: [], tools: [] }, sequence: 5, stepIndex: 5 },
    { id: 'read-5', output: { parts: [], reasoning: [], texts: [], tools: [] }, sequence: 6, stepIndex: 6 },
    { id: 'spawn', output: { parts: [], reasoning: [], texts: [], tools: [] }, sequence: 1, stepIndex: 1 },
    { id: 'spawn-fallback', output: { parts: [], reasoning: [], texts: [], tools: [] }, stepIndex: 1 },
  ]);

  assert.deepEqual(cycles.map((cycle) => cycle.id), ['spawn', 'spawn-fallback', 'read-4', 'read-5']);
});

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

test('does not attach persisted traces to provider calls with different IDs', () => {
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

test('uses the provider tool-result directly and keeps identical retries distinct', () => {
  const output = aiOutputViewFromResponse({
    content: [
      { type: 'text', text: 'Downloading the first image.' },
      { type: 'tool-call', toolCallId: 'download-1', toolName: 'file', input: { action: 'download', url: 'https://example.test/image.jpg' } },
      { type: 'tool-result', toolCallId: 'download-1', toolName: 'file', output: { type: 'text', value: 'saved first image' } },
      { type: 'text', text: 'Retrying the same image.' },
      { type: 'tool-call', toolCallId: 'download-2', toolName: 'file', input: { action: 'download', url: 'https://example.test/image.jpg' } },
      { type: 'tool-result', toolCallId: 'download-2', toolName: 'file', output: { type: 'text', value: 'saved retry' } },
    ],
  });

  assert.deepEqual(output.parts.map((part) => part.kind), ['text', 'tool', 'text', 'tool']);
  assert.deepEqual(output.tools.map((tool) => [tool.id, tool.ok, tool.result]), [
    ['download-1', true, 'saved first image'],
    ['download-2', true, 'saved retry'],
  ]);
  const details = buildAiCycleToolDetailMap([{ id: 'cycle', output, stepIndex: 1 }], []);
  assert.equal(details.get('cycle:0')?.tool.result, 'saved first image');
  assert.equal(details.get('cycle:1')?.tool.result, 'saved retry');
});

test('provider results retain their exact persisted indexes without creating bottom fallback duplicates', () => {
  const output = aiOutputViewFromResponse({
    content: [
      { type: 'text', text: 'Open the source.' },
      { type: 'tool-call', toolCallId: 'browse-1', toolName: 'browserCode', input: { code: 'open()' } },
      { type: 'tool-result', toolCallId: 'browse-1', toolName: 'browserCode', output: { type: 'text', value: 'opened' } },
      { type: 'text', text: 'Extract the summary.' },
      { type: 'tool-call', toolCallId: 'browse-2', toolName: 'browserCode', input: { code: 'extractSummary()' } },
      { type: 'tool-result', toolCallId: 'browse-2', toolName: 'browserCode', output: { type: 'text', value: 'summary' } },
      { type: 'text', text: 'Extract the details.' },
      { type: 'tool-call', toolCallId: 'browse-3', toolName: 'browserCode', input: { code: 'extractDetails()' } },
      { type: 'tool-result', toolCallId: 'browse-3', toolName: 'browserCode', output: { type: 'text', value: 'details' } },
    ],
  });
  const steps: StepExecutionResult[] = [{
    index: 1,
    action: 'browse source',
    actual: 'done',
    expected: 'source content',
    status: 'passed',
    tools: [
      { id: 'browse-1', name: 'browserCode', input: { code: 'open()' }, ok: true, result: 'opened' },
      { id: 'browse-2', name: 'browserCode', input: { code: 'extractSummary()' }, ok: true, result: 'summary' },
      { id: 'browse-3', name: 'browserCode', input: { code: 'extractDetails()' }, ok: true, result: 'details' },
    ],
  }];

  const details = buildAiCycleToolDetailMap([{ id: 'cycle', output, stepIndex: 1 }], steps);

  assert.deepEqual(
    [0, 1, 2].map((index) => details.get(`cycle:${index}`)?.toolIndex),
    [0, 1, 2],
  );
  assert.equal(new Set([...details.values()].map((detail) => `${detail.stepIndex}:${detail.toolIndex}`)).size, 3);
});

test('keeps a retried identical tool on the later model cycle that executed it', () => {
  const input = { action: 'download', url: 'https://example.test/image.jpg' };
  const firstCycle = aiOutputViewFromResponse({
    content: [
      { type: 'tool-call', toolCallId: 'executed-first', toolName: 'file', input: { action: 'download', url: 'https://example.test/first.jpg' } },
      { type: 'tool-call', toolCallId: 'proposed-but-not-run', toolName: 'file', input },
    ],
  });
  const retryCycle = aiOutputViewFromResponse({
    content: [{ type: 'tool-call', toolCallId: 'executed-retry', toolName: 'file', input }],
  });
  const steps: StepExecutionResult[] = [{
    index: 1,
    action: 'download images',
    actual: 'done',
    expected: 'images',
    status: 'passed',
    tools: [
      { id: 'executed-first', name: 'file', input: { action: 'download', url: 'https://example.test/first.jpg' }, ok: true },
      { id: 'executed-retry', name: 'file', input, ok: true },
    ],
  }];

  const details = buildAiCycleToolDetailMap([
    { id: 'first-cycle', output: firstCycle, stepIndex: 1 },
    { id: 'retry-cycle', output: retryCycle, stepIndex: 1 },
  ], steps);

  assert.equal(details.get('first-cycle:0')?.tool.id, 'executed-first');
  assert.equal(details.get('first-cycle:1'), undefined);
  assert.equal(details.get('retry-cycle:0')?.tool.id, 'executed-retry');
});

test('hides unmatched provider proposals while still matching later exact tool IDs', () => {
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

test('does not render extra calls from a provider response after one call has a real trace', () => {
  const output = aiOutputViewFromResponse({
    content: [
      { type: 'tool-call', toolCallId: 'spawn-1', toolName: 'subagent', input: { action: 'spawn' } },
      { type: 'tool-call', toolCallId: 'state-never-ran', toolName: 'readBrowserState', input: {} },
    ],
  });
  const details = buildAiCycleToolDetailMap([{
    id: 'multi-call-cycle',
    output,
    stepIndex: 1,
  }], [{
    index: 1,
    action: 'spawn',
    actual: 'blocked by prerequisite',
    expected: '',
    status: 'failed',
    tools: [{ id: 'spawn-1', name: 'subagent', input: { action: 'spawn' }, ok: false }],
  }], true);

  assert.equal(details.get('multi-call-cycle:0')?.tool.id, 'spawn-1');
  assert.equal(details.get('multi-call-cycle:1'), undefined);
});

test('shows at most one optimistic tool before its trace arrives', () => {
  const output = aiOutputViewFromResponse({
    content: [
      { type: 'tool-call', toolCallId: 'first', toolName: 'readBrowserState', input: {} },
      { type: 'tool-call', toolCallId: 'second', toolName: 'subagent', input: { action: 'spawn' } },
    ],
  });
  const details = buildAiCycleToolDetailMap([{
    id: 'pending-cycle',
    output,
    stepIndex: 2,
  }], [], true);

  assert.equal(details.get('pending-cycle:0')?.tool.id, 'first');
  assert.equal(details.get('pending-cycle:1'), undefined);
});

test('does not consume one persisted tool trace in duplicate provider cycles', () => {
  const output = aiOutputViewFromResponse({
    content: [{ type: 'tool-call', toolCallId: 'same-call', toolName: 'readBrowserState', input: {} }],
  });
  const details = buildAiCycleToolDetailMap([
    { id: 'first-cycle', output, stepIndex: 1 },
    { id: 'duplicate-cycle', output, stepIndex: 1 },
  ], [{
    index: 1,
    action: 'read state',
    actual: 'done',
    expected: '',
    status: 'passed',
    tools: [{ id: 'same-call', name: 'readBrowserState', input: {}, ok: true }],
  }], true);

  assert.equal(details.get('first-cycle:0')?.tool.id, 'same-call');
  assert.equal(details.get('duplicate-cycle:0'), undefined);
});

test('keeps repeated tool-call IDs and retry results on their own execution steps', () => {
  const output = (id: string) => aiOutputViewFromResponse({
    content: [{ type: 'tool-call', toolCallId: id, toolName: 'file', input: { action: 'download', url: 'https://example.test/image.jpg' } }],
  });
  const steps: StepExecutionResult[] = [
    {
      index: 6,
      action: 'download image',
      actual: 'network failure',
      expected: 'image',
      status: 'failed',
      tools: [{ id: 'provider-reused-id', name: 'file', input: { action: 'download', url: 'https://example.test/image.jpg' }, ok: false }],
    },
    {
      index: 7,
      action: 'retry download image',
      actual: 'done',
      expected: 'image',
      status: 'passed',
      tools: [{ id: 'provider-reused-id', name: 'file', input: { action: 'download', url: 'https://example.test/image.jpg' }, ok: true }],
    },
  ];
  const details = buildAiCycleToolDetailMap([
    { id: 'failed-cycle', output: output('provider-reused-id'), stepIndex: 6 },
    { id: 'retry-cycle', output: output('provider-reused-id'), stepIndex: 7 },
  ], steps);

  assert.equal(details.get('failed-cycle:0')?.tool.ok, false);
  assert.equal(details.get('retry-cycle:0')?.tool.ok, true);
});

test('does not guess a retry association when legacy provider data has no step identity', () => {
  const output = aiOutputViewFromResponse({
    content: [{ type: 'tool-call', toolName: 'file', input: { action: 'download', url: 'https://example.test/image.jpg' } }],
  });
  const details = buildAiCycleToolDetailMap([{
    id: 'legacy-cycle',
    output,
  }], [{
    index: 3,
    action: 'download image',
    actual: 'failed',
    expected: 'image',
    status: 'failed',
    tools: [{ name: 'file', input: { action: 'download', url: 'https://example.test/image.jpg' }, ok: false }],
  }]);

  assert.equal(details.get('legacy-cycle:0'), undefined);
});

test('renders invalid tool calls even when argument parsing prevented execution', () => {
  const output = aiOutputViewFromResponse({
    content: [{
      type: 'tool-call',
      toolCallId: 'invalid-browser-code',
      toolName: 'browserCode',
      input: '{"code":',
      dynamic: true,
      invalid: true,
      error: {
        message: 'Invalid input for tool browserCode',
        cause: {
          message: 'Schema validation failed',
          cause: {
            issues: [{ path: ['code'], message: 'expected string, received undefined' }],
          },
        },
      },
    }],
  });

  assert.equal(output.tools[0]?.invalid, true);
  assert.equal(
    output.tools[0]?.error,
    'Invalid input for tool browserCode；Schema validation failed；参数 code: expected string, received undefined',
  );

  const details = buildAiCycleToolDetailMap([{
    id: 'invalid-cycle',
    messageId: 'assistant-1',
    output,
    stepIndex: 3,
  }], []);
  const detail = details.get('invalid-cycle:0');

  assert.equal(detail?.step.status, 'failed');
  assert.equal(detail?.tool.ok, false);
  assert.equal(detail?.tool.invalid, true);
  assert.equal(detail?.tool.result, 'Invalid input for tool browserCode；Schema validation failed；参数 code: expected string, received undefined');
});
