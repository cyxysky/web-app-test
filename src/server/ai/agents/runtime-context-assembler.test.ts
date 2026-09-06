import assert from 'node:assert/strict';
import test from 'node:test';
import { streamText, stepCountIs, tool, type ModelMessage } from 'ai';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { z } from 'zod';
import { normalizeBrowserChatModelContext, browserChatActiveMessages, browserChatTranscript } from './browser-chat-model-context';
import { assembleRuntimeContext, deriveRuntimeTaskState, readRuntimeContextMaterial, runtimeContextMessageRef } from './runtime-context-assembler';
import { completeRuntimeModelToolChain } from './runtime-context-compression';
import { runtimeContextProfile } from './runtime-context-budget';
import { splitBrowserChatContextSnapshot } from '@/server/storage/browser-chat-context-store';

function exchange(id: string, value: unknown, toolName = 'file'): ModelMessage[] {
  return [
    { role: 'assistant', content: [{ type: 'reasoning', text: 'protocol reasoning', providerOptions: { test: { signature: `signature-${id}` } } }, { type: 'tool-call', toolCallId: id, toolName, input: { action: 'read' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName, output: { type: 'json', value: value as never } }] },
  ];
}
function assemble(messages: ModelMessage[], budget = 10000) {
  const context = normalizeBrowserChatModelContext({ transcript: messages, activeMessages: messages });
  return { context, result: assembleRuntimeContext({ messages, records: context.records, inputBudgetTokens: budget, baseTokens: 1000 }) };
}

test('large latest material becomes a retrievable preview without breaking its signed tool exchange', () => {
  const content = 'complete evidence\n'.repeat(10000);
  const messages: ModelMessage[] = [{ role: 'user', content: 'Read every required section before concluding.' }, ...exchange('large', { ok: true, actual: { content } })];
  const { context, result } = assemble(messages);
  assert.match(JSON.stringify(result.messages), /"complete":false/);
  assert.deepEqual(completeRuntimeModelToolChain(result.messages), result.messages);
  assert.match(JSON.stringify(result.messages), /signature-large/);
  const ref = runtimeContextMessageRef(messages[2]);
  let restored = ''; let offset = 0;
  for (;;) {
    const page = readRuntimeContextMaterial(context.records, { ref, pointer: '/actual/content', offset, limit: 16000 });
    assert.ok('content' in page);
    restored += page.content;
    if (page.nextOffset === null) break;
    offset = page.nextOffset!;
  }
  assert.equal(restored, content);
  assert.deepEqual(browserChatTranscript(context), messages);
});

test('semantic compaction keeps later constraints and locators while removing exact source from the request', () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'Make report.docx.' },
    ...Array.from({ length: 20 }, (_, index) => exchange(`old-${index}`, { ok: true, actual: { text: 'fact '.repeat(350) } })).flat(),
    { role: 'user', content: 'Correction: keep documentId=report-1; repair the existing draft, never rebuild it.' },
    ...exchange('source', { ok: true, actual: { documentId: 'report-1', readKind: 'source', sourceDigest: 'v2', program: 'exact\n  whitespace\\and"quotes' } }),
    ...exchange('diagnostic', { ok: false, actual: { error: 'Cell D8 formula is incorrect.' } }),
  ];
  const context = normalizeBrowserChatModelContext({ transcript: messages });
  const options = { messages, records: context.records, inputBudgetTokens: 7000, baseTokens: 1000 };
  const planned = assembleRuntimeContext({ ...options, planning: true });
  const instructions = messages.filter((message) => message.role === 'user');
  const continuationSummary = JSON.stringify({ version: 2, goal: 'Repair report-1', currentState: 'Needs formula repair',
    constraints: instructions.map((message) => ({ text: message.content, sourceRefs: [runtimeContextMessageRef(message)] })), completed: [], decisions: [], keyFacts: [], failedAttempts: [], openItems: [],
    nextActions: [{ text: 'Read source and repair D8', sourceRefs: [] }], instructionCoverage: instructions.map((message) => ({ ref: runtimeContextMessageRef(message), status: 'active', reason: 'Retained' })) });
  const result = assembleRuntimeContext({ ...options, continuationSummary, forceCompaction: true,
    previousState: { ...deriveRuntimeTaskState(messages), summarizedRefs: planned.summaryMessages.map(runtimeContextMessageRef) } });
  assert.ok(result.archived.length > 0);
  assert.match(JSON.stringify(result.messages), /never rebuild/);
  assert.doesNotMatch(JSON.stringify(result.messages), /whitespace/);
  assert.match(JSON.stringify(result.messages), /file.readSource/);
  assert.match(JSON.stringify(result.messages), /Cell D8/);
  assert.deepEqual(completeRuntimeModelToolChain(result.messages), result.messages);
  assert.ok(result.manifest.estimatedTokensAfter <= 7000);
});

test('deduplication references the correct field in a multi-result UNO message', () => {
  const schema = { values: 'unique schema '.repeat(100) };
  const first = { ok: true, kind: 'uno-api', valueSchemas: schema, capabilities: ['read'] };
  const second = { ...first, capabilities: ['write'] };
  const calls = [exchange('one', { ok: true, actual: JSON.stringify({ ...first, summary: JSON.stringify(first) }) }), exchange('two', { ok: true, actual: JSON.stringify(second) })];
  const messages: ModelMessage[] = [
    { role: 'user', content: 'Use both modules.' },
    { role: 'assistant', content: calls.flatMap((pair) => (pair[0] as Extract<ModelMessage, { role: 'assistant' }>).content as never) },
    { role: 'tool', content: calls.flatMap((pair) => (pair[1] as Extract<ModelMessage, { role: 'tool' }>).content) },
  ];
  const { context, result } = assemble(messages, 16000);
  const projected = result.messages.find((message) => message.role === 'tool')!;
  const value = JSON.parse(JSON.stringify(projected.content[1])).output.value.actual.valueSchemas as { identicalTo: string; pointer: string };
  const read = readRuntimeContextMaterial(context.records, { ref: value.identicalTo, pointer: value.pointer });
  assert.ok('content' in read);
  assert.deepEqual(JSON.parse(read.content!), schema);
  assert.doesNotMatch(JSON.stringify(projected), /"summary"/);
  assert.match(JSON.stringify(projected), /write/);
});

test('v1 migration keeps pending protocol evidence and repeated user events while v2 headers contain only references', () => {
  const repeated: ModelMessage = { role: 'user', content: 'Continue.' };
  const pending = exchange('pending', {})[0];
  const context = normalizeBrowserChatModelContext({ version: 1, transcript: [repeated, repeated, pending], activeMessages: [repeated, pending] });
  const split = splitBrowserChatContextSnapshot('session-test', { modelContext: context });
  const header = JSON.parse(JSON.stringify(split.snapshot)).modelContext;
  assert.equal(header.records, undefined);
  assert.equal(header.activeMessages, undefined);
  assert.equal(context.history.length, 3);
  assert.equal(Object.keys(context.records).length, 2);
  assert.deepEqual(deriveRuntimeTaskState(browserChatTranscript(context)).pendingToolCallIds, ['pending']);
  assert.doesNotMatch(JSON.stringify(browserChatActiveMessages(context)), /tool-call/);
});

test('oversized source is archived intact and does not prevent a small working context', () => {
  const messages: ModelMessage[] = [{ role: 'user', content: 'Patch exact source only.' }, ...exchange('source', { ok: true, actual: { readKind: 'source', program: 'a'.repeat(100000) } })];
  const { context, result } = assemble(messages, 6000);
  assert.ok(result.manifest.estimatedTokensAfter < 6000);
  assert.doesNotMatch(JSON.stringify(result.messages), /a{100}/);
  const source = result.taskState.materials!.find((entry) => entry.kind === 'source')!;
  assert.equal(readRuntimeContextMaterial(context.records, { ref: source.ref, pointer: '/actual/program', limit: 100 }).content, 'a'.repeat(100));
});

test('a per-model profile reserves explicit provider output without writing request settings', () => {
  const profileBefore = process.env.AI_CONTEXT_MODEL_PROFILES;
  const extraBefore = process.env.OPENAI_COMPATIBLE_2_EXTRA_REQUEST_PARAMETERS;
  try {
    process.env.AI_CONTEXT_MODEL_PROFILES = JSON.stringify({ 'openai-compatible-2/minimax-m3': { windowTokens: 1000000, outputReserveTokens: 100 } });
    process.env.OPENAI_COMPATIBLE_2_EXTRA_REQUEST_PARAMETERS = '{"max_completion_tokens":524288}';
    const profile = runtimeContextProfile({ provider: 'openai-compatible-2', model: 'MiniMax-M3' });
    assert.equal(profile.outputReserveTokens, 524288);
    assert.equal(profile.inputBudgetTokens, 425712);
    assert.equal(process.env.OPENAI_COMPATIBLE_2_EXTRA_REQUEST_PARAMETERS, '{"max_completion_tokens":524288}');
  } finally {
    if (profileBefore === undefined) delete process.env.AI_CONTEXT_MODEL_PROFILES; else process.env.AI_CONTEXT_MODEL_PROFILES = profileBefore;
    if (extraBefore === undefined) delete process.env.OPENAI_COMPATIBLE_2_EXTRA_REQUEST_PARAMETERS; else process.env.OPENAI_COMPATIBLE_2_EXTRA_REQUEST_PARAMETERS = extraBefore;
  }
});

test('real SDK prepareStep boundaries keep raw history independent of projected requests across three calls', async () => {
  let modelCalls = 0;
  let toolExecutions = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      modelCalls += 1;
      return { stream: convertArrayToReadableStream([
        { type: 'stream-start' as const, warnings: [] },
        ...(modelCalls < 3 ? [{ type: 'tool-call' as const, toolCallId: `sdk-${modelCalls}`, toolName: 'file', input: '{}' }]
          : [{ type: 'text-start' as const, id: 'answer' }, { type: 'text-delta' as const, id: 'answer', delta: 'done' }, { type: 'text-end' as const, id: 'answer' }]),
        { type: 'finish' as const, finishReason: { unified: modelCalls < 3 ? 'tool-calls' as const : 'stop' as const, raw: undefined },
          usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 10, text: 10, reasoning: undefined } } },
      ]) };
    },
  });
  const initial: ModelMessage[] = [{ role: 'user', content: 'Read the evidence and then answer.' }];
  const rawStepMessages: ModelMessage[] = [];
  let prepared: ModelMessage[] = [];
  let boundary = 0;
  const result = streamText({
    model, messages: initial, stopWhen: stepCountIs(3),
    tools: { file: tool({ inputSchema: z.object({}), execute: async () => {
      toolExecutions += 1;
      return { ok: true, actual: { content: 'raw evidence '.repeat(12000) } };
    } }) },
    prepareStep: async ({ responseMessages }) => {
      boundary = responseMessages.length;
      assert.deepEqual(responseMessages, rawStepMessages);
      const context = normalizeBrowserChatModelContext({ transcript: [...initial, ...responseMessages] });
      prepared = assembleRuntimeContext({ messages: [...initial, ...responseMessages], records: context.records, inputBudgetTokens: 10000, baseTokens: 1000 }).messages;
      assert.deepEqual(completeRuntimeModelToolChain(prepared), prepared);
      return { messages: prepared };
    },
    onStepEnd: async ({ response }) => { rawStepMessages.push(...response.messages); },
  });
  assert.equal(await result.text, 'done');
  assert.equal(toolExecutions, 2);
  const responses = await result.responseMessages;
  assert.deepEqual(responses, rawStepMessages);
  const terminal = [...prepared, ...responses.slice(boundary)];
  assert.equal(terminal.at(-1)?.role, 'assistant');
  assert.ok(JSON.stringify(responses).length > JSON.stringify(terminal).length * 10);
  assert.deepEqual(completeRuntimeModelToolChain(terminal), terminal);
});
