import type { ModelMessage } from 'ai';
import type { BrowserActionResult, BrowserObservationType } from '@/server/browser/browser-session';

export const runtimeObservationToolNames = new Set(['readObservation']);
export const staleReadObservationText = 'Stale: this old readObservation result was replaced by a later refreshed observation or invalidated by a browser action. Use readObservation({refresh:true,view:"actions",maxChars:10000}) for fresh actionable nodes, or continue the current observation with its nextCursor only when no browser action happened after it.';
export const runtimeObservationInvalidatingToolNames = new Set([
  'openPage',
  'scrollArea',
  'typeText',
  'pressKey',
  'waitForPage',
  'waitForHumanVerification',
  'switchTab',
  'clickDomNode',
  'fillDomNodes',
  'hoverDomNode',
  'doubleClickDomNode',
  'dragDomNode',
]);

export type RuntimeObservationRecord = {
  runId: string;
  toolName: string;
  createdAt: string;
  generation: number;
  defaultType: BrowserObservationType;
  views: Partial<Record<BrowserObservationType, string>>;
  totalChars: number;
  viewCharLengths: Partial<Record<BrowserObservationType, number>>;
  stale?: boolean;
  staleReason?: string;
  invalidatedAt?: string;
};

export type RuntimeObservationStore = Map<string, RuntimeObservationRecord>;

export type RuntimeObservationReadOptions = {
  cursor?: string;
  refresh?: boolean;
  view?: BrowserObservationType;
  offset?: number;
  maxChars?: number;
};

export type RuntimeObservationCursorPayload = {
  generation: number;
  index: number;
  view: BrowserObservationType;
};

const runtimeObservationTypes: BrowserObservationType[] = ['actions', 'tree', 'text', 'changes', 'elements'];
const fallbackObservationRunId = '__current__';
const maxObservationChangeItems = 80;

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

export function encodeRuntimeObservationCursor(payload: RuntimeObservationCursorPayload) {
  return Buffer.from(JSON.stringify({ generation: payload.generation, index: payload.index, view: payload.view }), 'utf8').toString('base64url');
}

export function decodeRuntimeObservationCursor(cursor?: string): RuntimeObservationCursorPayload | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<RuntimeObservationCursorPayload>;
    if (
      typeof parsed.generation === 'number'
      && Number.isFinite(parsed.generation)
      && typeof parsed.index === 'number'
      && Number.isFinite(parsed.index)
      && runtimeObservationTypes.includes(parsed.view as BrowserObservationType)
      && parsed.view !== 'changes'
    ) {
      return {
        generation: Math.max(0, Math.floor(parsed.generation)),
        index: Math.max(0, Math.floor(parsed.index)),
        view: parsed.view as BrowserObservationType,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
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

export function invalidateRuntimeObservation(store: RuntimeObservationStore | undefined, runId: string | undefined, reason: string) {
  const record = store?.get(observationStoreKey(runId));
  if (!record) return;
  record.stale = true;
  record.staleReason = reason;
  record.invalidatedAt = new Date().toISOString();
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
  if (!normalized.actions) normalized.actions = text;
  if (!normalized.tree && normalized.elements) normalized.tree = normalized.elements;
  if (!normalized.elements && normalized.tree) normalized.elements = normalized.tree;
  if (!normalized.text && normalized.tree) normalized.text = normalized.tree;
  const requestedDefault = views?.defaultType;
  const defaultType: BrowserObservationType = requestedDefault && normalized[requestedDefault] !== undefined
    ? requestedDefault
    : normalized.actions !== undefined
      ? 'actions'
      : normalized.tree !== undefined
        ? 'tree'
        : normalized.text !== undefined
          ? 'text'
          : 'elements';
  return { defaultType, views: normalized };
}

function compactObservationLine(value: string, maxLength = 260) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function observationTextLines(value?: string) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => compactObservationLine(line, 320))
    .filter((line) => line && !/^\[[^\]]+\]$/.test(line));
}

type ObservationActionEntry = {
  nodeId: string;
  line: string;
  display: string;
};

function extractActionNodeId(line: string) {
  const match = line.match(/\bnode_id=(?:"([^"]+)"|([^\s>]+))/);
  return match?.[1] || match?.[2] || '';
}

function parseObservationActions(value?: string) {
  const entries: ObservationActionEntry[] = [];
  const seen = new Set<string>();
  for (const rawLine of String(value || '').split(/\r?\n/)) {
    const line = compactObservationLine(rawLine, 500);
    if (!line || line.startsWith('<!--') || /^\[[^\]]+\]$/.test(line)) continue;
    const nodeId = extractActionNodeId(line);
    if (!nodeId || seen.has(nodeId)) continue;
    seen.add(nodeId);
    entries.push({
      nodeId,
      line,
      display: compactObservationLine(line),
    });
  }
  return entries;
}

function pushLimitedSection(lines: string[], title: string, items: string[], emptyText: string) {
  lines.push('', `${title}:`);
  if (!items.length) {
    lines.push(`- ${emptyText}`);
    return;
  }
  const visibleItems = items.slice(0, maxObservationChangeItems);
  for (const item of visibleItems) lines.push(`- ${item}`);
  const omitted = items.length - visibleItems.length;
  if (omitted > 0) lines.push(`- ... ${omitted} more omitted`);
}

function buildObservationChanges(
  previous: RuntimeObservationRecord | undefined,
  current: Partial<Record<BrowserObservationType, string>>,
  nextGeneration: number,
) {
  const currentActions = parseObservationActions(current.actions);
  const currentTextLines = observationTextLines(current.text);
  if (!previous) {
    return [
      'Changes since previous refreshed observation:',
      'No previous refreshed observation exists for this run yet; this is the baseline snapshot.',
      `Current generation: ${nextGeneration}.`,
      `Current interactive elements: ${currentActions.length}. Current visible text lines: ${currentTextLines.length}.`,
      'Current actionable node_id entries are in the actions view; use readObservation(view="actions") only if they were not already returned inline.',
    ].join('\n');
  }

  const previousActions = parseObservationActions(previous.views.actions);
  const previousActionById = new Map(previousActions.map((entry) => [entry.nodeId, entry]));
  const currentActionById = new Map(currentActions.map((entry) => [entry.nodeId, entry]));
  const addedActions: string[] = [];
  const removedActions: string[] = [];
  const changedActions: string[] = [];
  for (const entry of currentActions) {
    const oldEntry = previousActionById.get(entry.nodeId);
    if (!oldEntry) {
      addedActions.push(entry.display);
    } else if (oldEntry.line !== entry.line) {
      changedActions.push(`node_id=${entry.nodeId} before: ${oldEntry.display} | now: ${entry.display}`);
    }
  }
  for (const entry of previousActions) {
    if (!currentActionById.has(entry.nodeId)) {
      removedActions.push(`previous ${entry.display}`);
    }
  }

  const previousText = new Set(observationTextLines(previous.views.text));
  const currentText = new Set(currentTextLines);
  const addedText = [...currentText].filter((line) => !previousText.has(line));
  const removedText = [...previousText].filter((line) => !currentText.has(line));
  const totalChanges = addedActions.length + removedActions.length + changedActions.length + addedText.length + removedText.length;
  const lines = [
    'Changes since previous refreshed observation:',
    `Previous generation: ${previous.generation}. Current generation: ${nextGeneration}.`,
    'Current node_id values in added/changed interactive entries are actionable only if they still appear in readObservation(view="actions"). Removed entries are historical evidence only.',
  ];
  if (totalChanges === 0) {
    lines.push('No actionable or visible text changes detected since the previous observation.');
    return lines.join('\n');
  }
  pushLimitedSection(lines, 'Added interactive elements', addedActions, 'none');
  pushLimitedSection(lines, 'Changed interactive elements', changedActions, 'none');
  pushLimitedSection(lines, 'Removed interactive elements', removedActions, 'none');
  pushLimitedSection(lines, 'Added visible text', addedText.map((line) => `"${compactObservationLine(line)}"`), 'none');
  pushLimitedSection(lines, 'Removed visible text', removedText.map((line) => `"${compactObservationLine(line)}"`), 'none');
  return lines.join('\n');
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
  normalized.views.changes = buildObservationChanges(previous, normalized.views, (previous?.generation || 0) + 1);
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

export function appendRuntimeObservationView(
  store: RuntimeObservationStore,
  runId: string | undefined,
  view: BrowserObservationType,
  content: string,
) {
  const record = store.get(observationStoreKey(runId));
  if (!record) return undefined;
  const previous = record.views[view];
  const nextValue = previous && previous !== content
    ? `${previous}\n${content}`
    : previous || content;
  record.views[view] = nextValue;
  record.viewCharLengths[view] = nextValue.length;
  record.totalChars = record.views[record.defaultType]?.length || nextValue.length;
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
  void name;
  const raw = Number(process.env.AI_TOOL_RESULT_PREVIEW_MAX_CHARS || 2400);
  const value = Math.floor(Number.isFinite(raw) ? raw : 10000);
  return Math.min(Math.max(value, 10000), 60000);
}

export function readRuntimeObservation(
  store: RuntimeObservationStore | undefined,
  runId: string | undefined,
  offset?: number,
  maxChars?: number,
  view?: BrowserObservationType,
): BrowserActionResult {
  const record = store?.get(observationStoreKey(runId));
  if (!record) {
    return { ok: false, actual: 'No current DOM observation is available for this run. Call readObservation({refresh:true,view:"actions",maxChars:10000}) first.' };
  }
  if (record.stale) {
    return {
      ok: false,
      actual: `Current DOM observation generation ${record.generation} is stale${record.staleReason ? ` after ${record.staleReason}` : ''}${record.invalidatedAt ? ` at ${record.invalidatedAt}` : ''}. Refresh with readObservation({refresh:true,view:"actions",maxChars:10000}) before using actionable node_id values.`,
    };
  }
  const selectedType = view || record.defaultType || 'actions';
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
      end < text.length ? `More stored text available: call readObservation(view="${selectedType}", offset=${end}, maxChars=10000), or use nextCursor from a lazy read result to parse a fresh DOM slice.` : 'End of stored observation text.',
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

function modelToolPartInput(part: unknown): unknown {
  if (!part || typeof part !== 'object' || Array.isArray(part)) return undefined;
  const record = part as Record<string, unknown>;
  for (const key of ['input', 'args', 'arguments']) {
    if (record[key] !== undefined) return record[key];
  }
  const toolCall = record.toolCall;
  if (toolCall && typeof toolCall === 'object' && !Array.isArray(toolCall)) {
    const callRecord = toolCall as Record<string, unknown>;
    for (const key of ['input', 'args', 'arguments']) {
      if (callRecord[key] !== undefined) return callRecord[key];
    }
  }
  return undefined;
}

function modelToolPartRefreshesObservation(part: unknown) {
  const name = modelToolPartName(part);
  if (name !== 'readObservation') return false;
  const input = modelToolPartInput(part);
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return (input as Record<string, unknown>).refresh === true;
  }
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input) as Record<string, unknown>;
      return parsed.refresh === true;
    } catch {
      return input.includes('"refresh":true') || input.includes('"refresh": true');
    }
  }
  return false;
}

function modelToolPartInvalidatesObservation(part: unknown) {
  const name = modelToolPartName(part);
  return Boolean(name && runtimeObservationInvalidatingToolNames.has(name));
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
  let staleBoundaryPosition = -1;
  for (const message of messages) {
    const parts = modelMessageContentParts(message);
    if (!parts) {
      position += 1;
      continue;
    }
    for (const part of parts) {
      if (modelToolPartRefreshesObservation(part) || modelToolPartInvalidatesObservation(part)) {
        staleBoundaryPosition = position;
      }
      position += 1;
    }
  }
  if (staleBoundaryPosition < 0) return messages;

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
        currentPosition < staleBoundaryPosition
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
