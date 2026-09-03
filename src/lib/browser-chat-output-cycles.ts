import type {
  BrowserChatAiOutputCycle,
  BrowserChatAiOutputView,
} from '@/server/ai/schemas/runtime.schema';
import {
  formatToolPayload,
  parseJsonObjectText,
  stripAnsiControlCodes,
} from './browser-chat-format';
import { asRecord } from './unknown-value';

export function stringFromUnknown(value: unknown): string {
  if (typeof value === 'string') return stripAnsiControlCodes(value).trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(stringFromUnknown).filter(Boolean).join('\n').trim();
  const record = asRecord(value);
  return record ? stringFromUnknown(record.text ?? record.content ?? record.reasoning ?? record.value) : '';
}

function toolReasonFromInput(input: unknown) {
  const record = asRecord(input);
  return stringFromUnknown(record?.reason)
    || stringFromUnknown(record?.targetVisual)
    || stringFromUnknown(record?.url)
    || stringFromUnknown(record?.text)
    || stringFromUnknown(record?.action);
}

function toolErrorFromUnknown(value: unknown) {
  const details: string[] = [];
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth = 0) => {
    if (depth > 6 || current === null || current === undefined) return;
    if (typeof current === 'string') {
      const text = stripAnsiControlCodes(current).trim();
      if (text && !details.includes(text)) details.push(text);
      return;
    }
    const record = asRecord(current);
    if (!record || seen.has(record)) return;
    seen.add(record);
    visit(record.message, depth + 1);
    if (Array.isArray(record.issues)) {
      for (const issue of record.issues) {
        const item = asRecord(issue);
        const path = Array.isArray(item?.path) ? item.path.map(String).join('.') : '';
        const message = stringFromUnknown(item?.message);
        if (message) details.push(`${path ? `参数 ${path}: ` : ''}${message}`);
      }
    }
    visit(record.cause, depth + 1);
    visit(record.error, depth + 1);
  };
  visit(value);
  return [...new Set(details)].join('；') || '工具参数解析失败：运行时未返回可识别的错误详情';
}

function normalizeAiContentPart(part: unknown): BrowserChatAiOutputView {
  const record = asRecord(part);
  if (!record) return { parts: [], reasoning: [], texts: [], tools: [] };
  const type = String(record.type || '').toLowerCase();
  if (type === 'reasoning') {
    const text = stringFromUnknown(record.text ?? record.content ?? record.reasoning ?? record.value);
    return { parts: text ? [{ index: 0, kind: 'reasoning' }] : [], reasoning: text ? [text] : [], texts: [], tools: [] };
  }
  if (type === 'text') {
    const text = stringFromUnknown(record.text ?? record.content ?? record.reasoning ?? record.value);
    return { parts: text ? [{ index: 0, kind: 'text' }] : [], reasoning: [], texts: text ? [text] : [], tools: [] };
  }
  if (type === 'tool-call' || type === 'tool_call') {
    const name = stringFromUnknown(record.toolName) || stringFromUnknown(record.name) || stringFromUnknown(record.tool);
    if (!name) return { parts: [], reasoning: [], texts: [], tools: [] };
    const input = record.input ?? record.args ?? record.arguments;
    const invalid = record.invalid === true;
    return {
      parts: [{ index: 0, kind: 'tool' }],
      reasoning: [],
      texts: [],
      tools: [{
        id: stringFromUnknown(record.toolCallId) || stringFromUnknown(record.id) || name,
        input,
        name,
        reason: toolReasonFromInput(input),
        invalid,
        error: invalid ? toolErrorFromUnknown(record.error) : undefined,
      }],
    };
  }
  return { parts: [], reasoning: [], texts: [], tools: [] };
}

function applyToolResultToOutput(output: BrowserChatAiOutputView, part: unknown) {
  const record = asRecord(part);
  if (!record) return false;
  const type = String(record.type || '').toLowerCase();
  if (type !== 'tool-result' && type !== 'tool_result' && type !== 'tool-error' && type !== 'tool_error') return false;
  const id = stringFromUnknown(record.toolCallId) || stringFromUnknown(record.id);
  if (!id) return true;
  const transportSucceeded = type === 'tool-result' || type === 'tool_result';
  const rawResult = transportSucceeded
    ? (record.output ?? record.result)
    : (record.error ?? record.output ?? record.result);
  const businessResult = asRecord(rawResult);
  const succeeded = transportSucceeded && (typeof businessResult?.ok !== 'boolean' || businessResult.ok);
  const result = stringFromUnknown(businessResult?.actual)
    || stringFromUnknown(businessResult?.error)
    || stringFromUnknown(rawResult)
    || (succeeded ? 'Tool completed.' : toolErrorFromUnknown(rawResult));
  const tool = [...output.tools].reverse().find((item) => item.id === id);
  if (!tool) return true;
  tool.ok = succeeded;
  tool.result = result;
  tool.rawResult = rawResult;
  if (!succeeded) tool.error = result;
  return true;
}

function mergeAiOutputView(target: BrowserChatAiOutputView, source: BrowserChatAiOutputView) {
  const offsets = {
    reasoning: target.reasoning.length,
    text: target.texts.length,
    tool: target.tools.length,
  };
  target.parts.push(...source.parts.map((part) => ({
    ...part,
    index: part.index + offsets[part.kind],
  })));
  target.reasoning.push(...source.reasoning);
  target.texts.push(...source.texts);
  target.tools.push(...source.tools);
}

function aiOutputViewFromContentParts(parts: unknown[]) {
  const output: BrowserChatAiOutputView = { parts: [], reasoning: [], texts: [], tools: [] };
  for (const part of parts) {
    if (!applyToolResultToOutput(output, part)) mergeAiOutputView(output, normalizeAiContentPart(part));
  }
  return output;
}

export function browserChatAiOutputViewFromResponse(response: unknown): BrowserChatAiOutputView {
  const record = asRecord(response);
  if (!record) return { parts: [], reasoning: [], texts: [], tools: [] };
  const output: BrowserChatAiOutputView = { parts: [], reasoning: [], texts: [], tools: [] };
  mergeAiOutputView(output, aiOutputViewFromContentParts(Array.isArray(record.content) ? record.content : []));
  if (!output.reasoning.length && !output.texts.length) {
    const reasoningText = stringFromUnknown(record.reasoningText);
    if (reasoningText) mergeAiOutputView(output, normalizeAiContentPart({ type: 'reasoning', text: reasoningText }));
    const text = stringFromUnknown(record.text);
    if (text) mergeAiOutputView(output, normalizeAiContentPart({ type: 'text', text }));
  }
  // `content` is the canonical, ordered provider transcript. `toolCalls` is
  // an SDK convenience mirror; only use it when the provider omitted content.
  if (!output.tools.length) {
    for (const toolCall of Array.isArray(record.toolCalls) ? record.toolCalls : []) {
      mergeAiOutputView(output, normalizeAiContentPart({ ...asRecord(toolCall), type: 'tool-call' }));
    }
  }
  const steps = Array.isArray(record.steps) ? record.steps : [];
  if (steps.length && !output.reasoning.length && !output.tools.length) {
    mergeAiOutputView(output, browserChatAiOutputViewFromResponse(steps.at(-1)));
  }
  const result = asRecord(record.result);
  if (result && !output.reasoning.length && !output.tools.length && !output.texts.length) {
    mergeAiOutputView(output, browserChatAiOutputViewFromResponse(result));
  }
  return output;
}

export function compactBrowserChatAiOutputView(output: BrowserChatAiOutputView): BrowserChatAiOutputView {
  const compacted: BrowserChatAiOutputView = { parts: [], reasoning: [], texts: [], tools: [] };
  const seenReasoning = new Set<string>();
  const seenTexts = new Set<string>();
  const seenToolIds = new Set<string>();
  for (const part of output.parts) {
    if (part.kind === 'reasoning') {
      const value = output.reasoning[part.index];
      const key = value?.replace(/\s+/g, ' ').trim();
      if (!key || seenReasoning.has(key)) continue;
      seenReasoning.add(key);
      mergeAiOutputView(compacted, normalizeAiContentPart({ type: 'reasoning', text: value }));
      continue;
    }
    if (part.kind === 'text') {
      const value = output.texts[part.index];
      const key = value?.replace(/\s+/g, ' ').trim();
      if (!key || seenTexts.has(key)) continue;
      seenTexts.add(key);
      mergeAiOutputView(compacted, normalizeAiContentPart({ type: 'text', text: value }));
      continue;
    }
    const tool = output.tools[part.index];
    if (!tool) continue;
    // Retries may intentionally have the same name and arguments. Only remove
    // the SDK's duplicate representation of the exact same provider call.
    const key = tool.id || `${tool.name}:${formatToolPayload(tool.input)}`;
    if (seenToolIds.has(key)) continue;
    seenToolIds.add(key);
    compacted.parts.push({ index: compacted.tools.length, kind: 'tool' });
    compacted.tools.push(tool);
  }
  return compacted;
}

function isCodexRuntimeObjectEnvelope(value: string) {
  const parsed = parseJsonObjectText(value);
  if (!parsed || typeof parsed.type !== 'string' || !parsed.type.trim()) return false;
  const hasMessage = typeof parsed.message === 'string';
  const hasParams = parsed.params !== null && typeof parsed.params === 'object' && !Array.isArray(parsed.params);
  return hasMessage || hasParams;
}

export function hasAiOutputView(output: BrowserChatAiOutputView) {
  return Boolean(output.reasoning.length || output.texts.length || output.tools.length);
}

export function sortBrowserChatAiOutputCycles<TCycle extends BrowserChatAiOutputCycle>(cycles: TCycle[]) {
  return cycles
    .map((cycle, insertionIndex) => ({ cycle, insertionIndex }))
    .sort((left, right) => {
      const leftStep = Number.isFinite(left.cycle.stepIndex) ? Number(left.cycle.stepIndex) : undefined;
      const rightStep = Number.isFinite(right.cycle.stepIndex) ? Number(right.cycle.stepIndex) : undefined;
      if (leftStep !== undefined && rightStep !== undefined && leftStep !== rightStep) return leftStep - rightStep;
      const leftSequence = Number.isFinite(left.cycle.sequence) ? Number(left.cycle.sequence) : undefined;
      const rightSequence = Number.isFinite(right.cycle.sequence) ? Number(right.cycle.sequence) : undefined;
      if (leftSequence !== undefined && rightSequence !== undefined && leftSequence !== rightSequence) {
        return leftSequence - rightSequence;
      }
      const leftTime = Date.parse(left.cycle.createdAt || '');
      const rightTime = Date.parse(right.cycle.createdAt || '');
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
      return left.insertionIndex - right.insertionIndex;
    })
    .map(({ cycle }) => cycle);
}

export function browserChatAiOutputCycleFromDebugEvent(input: {
  details?: unknown;
  id: string;
  messageId?: string;
  phase: string;
  stepIndex?: number;
  sequence?: number;
  createdAt?: string;
  subagentId?: string;
  batchId?: string;
}): BrowserChatAiOutputCycle | undefined {
  const details = asRecord(input.details);
  const detailsValue = asRecord(details?.value) || details;
  const event = asRecord(detailsValue?.event) || detailsValue;
  if (input.phase === 'ai:context-compression:complete') {
    const execution = asRecord(event?.execution);
    const toolCallId = stringFromUnknown(event?.toolCallId) || stringFromUnknown(execution?.toolCallId) || input.id;
    const estimatedTokensBefore = Number(event?.estimatedTokensBefore);
    const estimatedTokensAfter = Number(event?.estimatedTokensAfter);
    const before = Number.isFinite(estimatedTokensBefore) ? Math.max(0, Math.round(estimatedTokensBefore)) : undefined;
    const after = Number.isFinite(estimatedTokensAfter) ? Math.max(0, Math.round(estimatedTokensAfter)) : undefined;
    return {
      id: input.id,
      messageId: input.messageId,
      output: {
        parts: [{ index: 0, kind: 'tool' }],
        reasoning: [],
        texts: [],
        tools: [{
          id: toolCallId,
          input: {
            estimatedTokensBefore: before,
            estimatedTokensAfter: after,
          },
          name: 'contextCompression',
          ok: true,
          result: before !== undefined && after !== undefined
            ? `Context compressed from ${before} to ${after} estimated tokens.`
            : 'Context compression completed.',
        }],
      },
      stepIndex: input.stepIndex,
      sequence: input.sequence,
      createdAt: input.createdAt,
      subagentId: input.subagentId,
      batchId: input.batchId,
    };
  }
  if (input.phase !== 'ai:runtime:response' && input.phase !== 'ai:runtime:object') return undefined;
  const aiOutput = asRecord(event?.aiOutput);
  if (!aiOutput) return undefined;
  const rawAgentStepIndex = Number(aiOutput.agentStepIndex);
  const output = browserChatAiOutputViewFromResponse(aiOutput.response);
  const fallbackText = stringFromUnknown(aiOutput.text);
  if (fallbackText) mergeAiOutputView(output, normalizeAiContentPart({ type: 'text', text: fallbackText }));
  if (input.phase === 'ai:runtime:object') {
    output.parts = output.parts.filter((part) => (
      part.kind !== 'text' || !isCodexRuntimeObjectEnvelope(output.texts[part.index] || '')
    ));
  }
  const compacted = compactBrowserChatAiOutputView(output);
  if (!hasAiOutputView(compacted)) return undefined;
  return {
    id: input.id,
    messageId: input.messageId,
    output: compacted,
    stepIndex: input.stepIndex,
    agentStepIndex: Number.isFinite(rawAgentStepIndex) ? rawAgentStepIndex : undefined,
    sequence: input.sequence,
    createdAt: input.createdAt,
    subagentId: input.subagentId,
    batchId: input.batchId,
  };
}
