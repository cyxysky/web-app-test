import type {
  BrowserChatAiOutputCycle,
  BrowserChatAiOutputView,
} from '@/server/ai/schemas/runtime.schema';
import { asRecord } from '@/lib/unknown-value';

function stripAnsiControlCodes(value: string) {
  return value.replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function stringFromUnknown(value: unknown): string {
  if (typeof value === 'string') return stripAnsiControlCodes(value).trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(stringFromUnknown).filter(Boolean).join('\n').trim();
  const record = asRecord(value);
  return record ? stringFromUnknown(record.text ?? record.content ?? record.reasoning) : '';
}

function parseJsonObjectText(value?: string) {
  const text = (value || '').trim();
  if (!text || !text.startsWith('{') || !text.endsWith('}')) return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
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
  const record = asRecord(value);
  return stringFromUnknown(record?.message)
    || stringFromUnknown(record?.cause)
    || stringFromUnknown(record?.error)
    || stringFromUnknown(value);
}

function normalizeAiContentPart(part: unknown): BrowserChatAiOutputView {
  const record = asRecord(part);
  if (!record) return { parts: [], reasoning: [], texts: [], tools: [] };
  const type = String(record.type || '').toLowerCase();
  if (type === 'reasoning') {
    const text = stringFromUnknown(record.text ?? record.content ?? record.reasoning);
    return { parts: text ? [{ index: 0, kind: 'reasoning' }] : [], reasoning: text ? [text] : [], texts: [], tools: [] };
  }
  if (type === 'text') {
    const text = stringFromUnknown(record.text ?? record.content ?? record.reasoning);
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
  for (const part of parts) mergeAiOutputView(output, normalizeAiContentPart(part));
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
  for (const toolCall of Array.isArray(record.toolCalls) ? record.toolCalls : []) {
    mergeAiOutputView(output, normalizeAiContentPart({ ...asRecord(toolCall), type: 'tool-call' }));
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

function formatToolPayload(value: unknown) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string') return stripAnsiControlCodes(value);
  try {
    return stripAnsiControlCodes(JSON.stringify(value, null, 2));
  } catch {
    return stripAnsiControlCodes(String(value));
  }
}

export function compactBrowserChatAiOutputView(output: BrowserChatAiOutputView): BrowserChatAiOutputView {
  const compacted: BrowserChatAiOutputView = { parts: [], reasoning: [], texts: [], tools: [] };
  const seenReasoning = new Set<string>();
  const seenTexts = new Set<string>();
  const seenTools = new Set<string>();
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
    const key = `${tool.name}:${formatToolPayload(tool.input)}`;
    if (seenTools.has(key)) continue;
    seenTools.add(key);
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

function hasBrowserChatAiOutputView(output: BrowserChatAiOutputView) {
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
  if (input.phase !== 'ai:runtime:response' && input.phase !== 'ai:runtime:object') return undefined;
  const details = asRecord(input.details);
  const detailsValue = asRecord(details?.value) || details;
  const event = asRecord(detailsValue?.event) || detailsValue;
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
  if (!hasBrowserChatAiOutputView(compacted)) return undefined;
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
