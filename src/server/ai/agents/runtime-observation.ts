import type { ModelMessage } from 'ai';
import type { BrowserActionResult, BrowserObservationType } from '@/server/browser/browser-session';

export const runtimeObservationToolNames = new Set(['readObservation']);
export const staleReadObservationText = '已失效：这是一条旧 readObservation 结果，已被后续 getPageState 刷新的当前 observation 取代。需要当前内容时，请调用 readObservation(type, offset, maxChars)。';

export type RuntimeObservationRecord = {
  runId: string;
  toolName: string;
  createdAt: string;
  generation: number;
  defaultType: BrowserObservationType;
  views: Partial<Record<BrowserObservationType, string>>;
  totalChars: number;
  viewCharLengths: Partial<Record<BrowserObservationType, number>>;
};

export type RuntimeObservationStore = Map<string, RuntimeObservationRecord>;

const runtimeObservationTypes: BrowserObservationType[] = ['text', 'interactive'];
const fallbackObservationRunId = '__current__';

function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  const numberValue = typeof value === 'number' ? value : Number(value);
  const normalized = Number.isFinite(numberValue) ? Math.floor(numberValue) : fallback;
  return Math.min(Math.max(normalized, min), max);
}

function lowerBoundedInteger(value: unknown, fallback: number, min: number) {
  const numberValue = typeof value === 'number' ? value : Number(value);
  const normalized = Number.isFinite(numberValue) ? Math.floor(numberValue) : fallback;
  return Math.max(normalized, min);
}

export function observationStoreKey(runId?: string) {
  return runId || fallbackObservationRunId;
}

export function cloneRuntimeObservationStore(store?: RuntimeObservationStore): RuntimeObservationStore | undefined {
  if (!store?.size) return undefined;
  const cloned: RuntimeObservationStore = new Map();
  for (const [key, record] of store) {
    cloned.set(key, {
      ...record,
      views: { ...record.views },
      viewCharLengths: { ...record.viewCharLengths },
    });
  }
  return cloned;
}

export function restoreRuntimeObservationStore(target: RuntimeObservationStore, source?: RuntimeObservationStore) {
  target.clear();
  const cloned = cloneRuntimeObservationStore(source);
  if (!cloned) return;
  for (const [key, record] of cloned) target.set(key, record);
}

function normalizeObservationViews(
  text: string,
  views?: BrowserActionResult['observationViews'],
) {
  const normalized: Partial<Record<BrowserObservationType, string>> = {};
  for (const type of runtimeObservationTypes) {
    const value = views?.[type];
    if (typeof value === 'string') normalized[type] = value;
  }
  if (!normalized.text) normalized.text = text;
  const defaultType = views?.defaultType && normalized[views.defaultType] !== undefined ? views.defaultType : 'text';
  return { defaultType, views: normalized };
}

export function storeRuntimeObservation(
  store: RuntimeObservationStore,
  runId: string | undefined,
  toolName: string,
  text: string,
  views?: BrowserActionResult['observationViews'],
) {
  const key = observationStoreKey(runId);
  const previous = store.get(key);
  const normalized = normalizeObservationViews(text, views);
  const viewCharLengths = Object.fromEntries(
    runtimeObservationTypes
      .filter((type) => normalized.views[type] !== undefined)
      .map((type) => [type, normalized.views[type]?.length || 0]),
  ) as Partial<Record<BrowserObservationType, number>>;
  const record: RuntimeObservationRecord = {
    runId: key,
    toolName,
    createdAt: new Date().toISOString(),
    generation: (previous?.generation || 0) + 1,
    defaultType: normalized.defaultType,
    views: normalized.views,
    totalChars: normalized.views[normalized.defaultType]?.length || 0,
    viewCharLengths,
  };
  store.set(key, record);
  return record;
}

export function runtimeObservationCount(store: RuntimeObservationStore | undefined, runId?: string) {
  return store?.has(observationStoreKey(runId)) ? 1 : 0;
}

export function runtimeObservationAvailableTypes(record: RuntimeObservationRecord) {
  return runtimeObservationTypes
    .filter((item) => record.views[item] !== undefined)
    .map((item) => `${item}(${record.viewCharLengths[item] || 0})`)
    .join(', ');
}

export function observationPreviewLimit(name: string) {
  const raw = Number(process.env.AI_TOOL_RESULT_PREVIEW_MAX_CHARS || (name === 'getPageState' ? 10000 : 2400));
  const value = Math.floor(Number.isFinite(raw) ? raw : 10000);
  return Math.min(Math.max(value, 10000), 60000);
}

export function readRuntimeObservation(
  store: RuntimeObservationStore | undefined,
  runId: string | undefined,
  type?: BrowserObservationType,
  offset?: number,
  maxChars?: number,
): BrowserActionResult {
  const record = store?.get(observationStoreKey(runId));
  if (!record) {
    return { ok: false, actual: 'No current DOM observation is available for this run. Call getPageState first, then call readObservation(type, offset, maxChars).' };
  }
  const selectedType = type || record.defaultType;
  const text = record.views[selectedType];
  const availableTypes = runtimeObservationAvailableTypes(record);
  if (text === undefined) {
    return { ok: false, actual: `Current observation from ${record.toolName} has no "${selectedType}" content. Available types: ${availableTypes || '[none]'}.` };
  }
  const start = boundedInteger(offset, 0, 0, text.length);
  const length = lowerBoundedInteger(maxChars, 10000, 10000);
  const end = Math.min(text.length, start + length);
  return {
    ok: true,
    actual: [
      `Current observation from ${record.toolName} generation ${record.generation} at ${record.createdAt}. Type ${selectedType}. Range ${start}-${end}/${text.length}. Available types: ${availableTypes || selectedType}.`,
      text.slice(start, end),
      end < text.length ? `More available: call readObservation(type="${selectedType}", offset=${end}, maxChars=10000).` : 'End of observation.',
    ].join('\n'),
  };
}

function modelMessageContentParts(message: ModelMessage) {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? content : undefined;
}

function modelToolPartName(part: unknown) {
  if (!part || typeof part !== 'object' || Array.isArray(part)) return undefined;
  const record = part as Record<string, unknown>;
  if (
    (record.type === 'tool-call' || record.type === 'tool-result' || record.type === 'tool-error')
    && typeof record.toolName === 'string'
  ) return record.toolName;
  const toolCall = record.toolCall;
  if (toolCall && typeof toolCall === 'object' && !Array.isArray(toolCall)) {
    const toolName = (toolCall as Record<string, unknown>).toolName;
    if (typeof toolName === 'string') return toolName;
  }
  return undefined;
}

function modelToolPartType(part: unknown) {
  if (!part || typeof part !== 'object' || Array.isArray(part)) return undefined;
  const type = (part as Record<string, unknown>).type;
  return typeof type === 'string' ? type : undefined;
}

function compactStaleReadObservationOutput(output: unknown): unknown {
  if (typeof output === 'string') return staleReadObservationText;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output;
  const record = output as Record<string, unknown>;
  const next: Record<string, unknown> = { ...record };
  let changed = false;
  if ('value' in record) {
    next.value = compactStaleReadObservationOutput(record.value);
    changed = true;
  }
  if (typeof record.actual === 'string') {
    next.actual = staleReadObservationText;
    changed = true;
  }
  if (typeof record.text === 'string') {
    next.text = staleReadObservationText;
    changed = true;
  }
  if (typeof record.content === 'string') {
    next.content = staleReadObservationText;
    changed = true;
  }
  if (changed) return next;
  return { ...record, actual: staleReadObservationText };
}

function compactStaleReadObservationPart(part: unknown): unknown {
  if (!part || typeof part !== 'object' || Array.isArray(part)) return part;
  const record = part as Record<string, unknown>;
  const next: Record<string, unknown> = { ...record };
  let changed = false;
  if ('output' in record) {
    next.output = compactStaleReadObservationOutput(record.output);
    changed = true;
  }
  if ('value' in record) {
    next.value = compactStaleReadObservationOutput(record.value);
    changed = true;
  }
  if ('result' in record) {
    next.result = compactStaleReadObservationOutput(record.result);
    changed = true;
  }
  if (changed) return next;
  return { ...record, output: { type: 'json', value: { ok: true, actual: staleReadObservationText } } };
}

export function compactStaleReadObservationMessages<T extends ModelMessage>(messages: T[]) {
  let position = 0;
  let lastGetPageStatePosition = -1;
  for (const message of messages) {
    const parts = modelMessageContentParts(message);
    if (!parts) {
      position += 1;
      continue;
    }
    for (const part of parts) {
      if (modelToolPartName(part) === 'getPageState') lastGetPageStatePosition = position;
      position += 1;
    }
  }
  if (lastGetPageStatePosition < 0) return messages;

  position = 0;
  let changed = false;
  const nextMessages = messages.map((message) => {
    const parts = modelMessageContentParts(message);
    if (!parts) {
      position += 1;
      return message;
    }
    let messageChanged = false;
    const nextParts = parts.map((part) => {
      const currentPosition = position;
      position += 1;
      if (
        currentPosition < lastGetPageStatePosition
        && modelToolPartType(part) === 'tool-result'
        && modelToolPartName(part) === 'readObservation'
      ) {
        messageChanged = true;
        changed = true;
        return compactStaleReadObservationPart(part);
      }
      return part;
    });
    return messageChanged ? { ...(message as Record<string, unknown>), content: nextParts } as T : message;
  });
  return changed ? nextMessages : messages;
}
