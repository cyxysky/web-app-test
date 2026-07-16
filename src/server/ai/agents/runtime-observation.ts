import type { ModelMessage } from 'ai';
import type { BrowserActionResult, BrowserSnapshotView, BrowserSnapshotViews } from '@/server/browser/browser-session';

export const runtimeObservationToolNames = new Set(['takeSnapshot', 'searchSnapshot']);
export const staleSnapshotText = 'Stale: this old semantic DOM snapshot was replaced or invalidated by a browser action. Call takeSnapshot({mode:"actionable"}) for fresh UIDs.';
export const runtimeObservationInvalidatingToolNames = new Set([
  'openPage',
  'mouse',
  'keyboard',
  'selectOption',
  'waitForPage',
  'waitForHumanVerification',
  'switchTab',
]);

export type RuntimeObservationRecord = {
  runId: string;
  toolName: string;
  createdAt: string;
  generation: number;
  defaultType: BrowserSnapshotView;
  views: Partial<Record<BrowserSnapshotView, string>>;
  totalChars: number;
  viewCharLengths: Partial<Record<BrowserSnapshotView, number>>;
  stale?: boolean;
  staleReason?: string;
  invalidatedAt?: string;
};

export type RuntimeObservationStore = Map<string, RuntimeObservationRecord>;

export type RuntimeObservationReadOptions = {
  cursor?: string;
  mode?: 'actionable' | 'full' | 'text' | 'changes';
};

export type RuntimeObservationCursorPayload = {
  generation: number;
  index: number;
  view: BrowserSnapshotView;
};

const runtimeObservationTypes: BrowserSnapshotView[] = ['actionable', 'full', 'text', 'changes'];
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
      && runtimeObservationTypes.includes(parsed.view as BrowserSnapshotView)
      && parsed.view !== 'changes'
    ) {
      return {
        generation: Math.max(0, Math.floor(parsed.generation)),
        index: Math.max(0, Math.floor(parsed.index)),
        view: parsed.view as BrowserSnapshotView,
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
  views?: BrowserSnapshotViews,
) {
  const normalized: Partial<Record<BrowserSnapshotView, string>> = {};
  for (const type of runtimeObservationTypes) {
    const value = views?.[type];
    if (typeof value === 'string') normalized[type] = value;
  }
  // A caller that explicitly supplies one view (for example mode="text")
  // must not be silently relabelled as an actionable snapshot. The fallback is
  // only for older callers that supplied no typed view at all.
  if (!Object.keys(normalized).length) normalized.actionable = text;
  const requestedDefault = views?.defaultType;
  const defaultType: BrowserSnapshotView = requestedDefault && normalized[requestedDefault] !== undefined
    ? requestedDefault
    : normalized.actionable !== undefined
      ? 'actionable'
      : normalized.full !== undefined
        ? 'full'
        : normalized.text !== undefined
          ? 'text'
          : 'actionable';
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
  const match = line.match(/\buid=(?:"([^"]+)"|([^\s>]+))/);
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
  current: Partial<Record<BrowserSnapshotView, string>>,
  nextGeneration: number,
) {
  const currentActions = parseObservationActions(current.actionable);
  const currentTextLines = observationTextLines(current.text);
  if (!previous) {
    return [
      'Changes since previous refreshed observation:',
      'No previous refreshed observation exists for this run yet; this is the baseline snapshot.',
      `Current generation: ${nextGeneration}.`,
      `Current interactive elements: ${currentActions.length}. Current visible text lines: ${currentTextLines.length}.`,
      'Current actionable UID entries are in the actionable snapshot view.',
    ].join('\n');
  }

  const previousActions = parseObservationActions(previous.views.actionable);
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
      changedActions.push(`uid=${entry.nodeId} before: ${oldEntry.display} | now: ${entry.display}`);
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
    'Current UIDs in added/changed interactive entries are actionable only if they still appear in the latest snapshot. Removed entries are historical evidence only.',
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
  views?: BrowserSnapshotViews,
  options: { includeChanges?: boolean } = {},
) {
  const key = observationStoreKey(runId);
  const previous = store.get(key);
  const normalized = normalizeObservationViews(text, views);
  if (options.includeChanges !== false) {
    normalized.views.changes = buildObservationChanges(previous, normalized.views, (previous?.generation || 0) + 1);
  }
  const viewCharLengths = Object.fromEntries(
    runtimeObservationTypes
      .filter((type) => normalized.views[type] !== undefined)
      .map((type) => [type, normalized.views[type]?.length || 0]),
  ) as Partial<Record<BrowserSnapshotView, number>>;
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
  view: BrowserSnapshotView,
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

export function readStoredSnapshot(
  store: RuntimeObservationStore | undefined,
  runId: string | undefined,
  offset?: number,
  maxChars?: number,
  view?: BrowserSnapshotView,
): BrowserActionResult {
  const record = store?.get(observationStoreKey(runId));
  if (!record) {
    return { ok: false, actual: 'No current semantic DOM snapshot is available for this run. Call takeSnapshot({mode:"actionable"}) first.' };
  }
  if (record.stale) {
    return {
      ok: false,
      actual: `Current snapshot generation ${record.generation} is stale${record.staleReason ? ` after ${record.staleReason}` : ''}${record.invalidatedAt ? ` at ${record.invalidatedAt}` : ''}. Call takeSnapshot({mode:"actionable"}) before using UIDs.`,
    };
  }
  const selectedType = view || record.defaultType || 'actionable';
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
      end < text.length ? 'More stored snapshot text exists; continue with the nextCursor returned by takeSnapshot.' : 'End of stored snapshot text.',
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
  if (name === 'searchSnapshot') return true;
  if (name !== 'takeSnapshot') return false;
  const input = modelToolPartInput(part);
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return typeof (input as Record<string, unknown>).cursor !== 'string' && (input as Record<string, unknown>).mode !== 'changes';
  }
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input) as Record<string, unknown>;
      return typeof parsed.cursor !== 'string';
    } catch {
      return !input.includes('"cursor"');
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

function compactStaleSnapshotOutput(output: unknown): unknown {
  if (typeof output === 'string') return staleSnapshotText;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output;
  const record = output as Record<string, unknown>;
  const next: Record<string, unknown> = { ...record };
  let changed = false;
  if ('value' in record) {
    next.value = compactStaleSnapshotOutput(record.value);
    changed = true;
  }
  if (typeof record.actual === 'string') {
    next.actual = staleSnapshotText;
    changed = true;
  }
  if (typeof record.text === 'string') {
    next.text = staleSnapshotText;
    changed = true;
  }
  if (typeof record.content === 'string') {
    next.content = staleSnapshotText;
    changed = true;
  }
  if (changed) return next;
  return { ...record, actual: staleSnapshotText };
}

function compactStaleSnapshotPart(part: unknown): unknown {
  if (!part || typeof part !== 'object' || Array.isArray(part)) return part;
  const record = part as Record<string, unknown>;
  const next: Record<string, unknown> = { ...record };
  let changed = false;
  if ('output' in record) {
    next.output = compactStaleSnapshotOutput(record.output);
    changed = true;
  }
  if ('value' in record) {
    next.value = compactStaleSnapshotOutput(record.value);
    changed = true;
  }
  if ('result' in record) {
    next.result = compactStaleSnapshotOutput(record.result);
    changed = true;
  }
  if (changed) return next;
  return { ...record, output: { type: 'json', value: { ok: true, actual: staleSnapshotText } } };
}

export function compactStaleSnapshotMessages<T extends ModelMessage>(messages: T[]) {
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
        && runtimeObservationToolNames.has(modelToolPartName(part) || '')
      ) {
        messageChanged = true;
        changed = true;
        return compactStaleSnapshotPart(part);
      }
      return part;
    });
    return messageChanged ? { ...(message as Record<string, unknown>), content: nextParts } as T : message;
  });
  return changed ? nextMessages : messages;
}
