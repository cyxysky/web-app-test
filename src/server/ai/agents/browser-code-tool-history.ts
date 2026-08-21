import type { ModelMessage } from 'ai';

type JsonRecord = Record<string, unknown>;
type EvidenceKind = 'ax' | 'domChanges';
type EvidencePath = Array<number | string>;

const REMOVED_EVIDENCE = Symbol('removed-browser-evidence');

function recordFromUnknown(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function boundedValue(value: unknown, maxChars = 2_400) {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= maxChars) return value;
    return {
      truncated: true,
      originalChars: serialized.length,
      preview: serialized.slice(0, maxChars),
    };
  } catch {
    return String(value).slice(0, maxChars);
  }
}

function isAxTreeString(value: unknown) {
  return typeof value === 'string' && /^\s*\[ax-tree\](?:\r?\n|$)/.test(value);
}

function evidencePathKey(path: EvidencePath) {
  return JSON.stringify(path);
}

function collectEvidencePaths(
  value: unknown,
  kind: EvidenceKind,
  path: EvidencePath = [],
  paths: EvidencePath[] = [],
) {
  if (kind === 'ax' && isAxTreeString(value)) {
    paths.push(path);
    return paths;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectEvidencePaths(item, kind, [...path, index], paths));
    return paths;
  }
  const record = recordFromUnknown(value);
  if (!record) return paths;
  for (const [key, child] of Object.entries(record)) {
    const childPath = [...path, key];
    if (
      kind === 'ax'
        ? key === 'axTree' || key === 'domSnapshot' || isAxTreeString(child)
        : key === 'domChanges'
    ) {
      paths.push(childPath);
      continue;
    }
    collectEvidencePaths(child, kind, childPath, paths);
  }
  return paths;
}

function preferredEvidencePath(paths: EvidencePath[], kind: EvidenceKind) {
  const preferredTopLevelKey = kind === 'ax' ? 'axTree' : 'domChanges';
  return paths.find((path) => path.length === 1 && path[0] === preferredTopLevelKey)
    || paths.at(-1);
}

function removeEvidencePaths(
  value: unknown,
  pathsToRemove: Set<string>,
  path: EvidencePath = [],
): unknown | typeof REMOVED_EVIDENCE {
  if (pathsToRemove.has(evidencePathKey(path))) return REMOVED_EVIDENCE;
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      const next = removeEvidencePaths(item, pathsToRemove, [...path, index]);
      return next === REMOVED_EVIDENCE ? [] : [next];
    });
  }
  const record = recordFromUnknown(value);
  if (!record) return value;
  const next: JsonRecord = {};
  for (const [key, child] of Object.entries(record)) {
    const sanitized = removeEvidencePaths(child, pathsToRemove, [...path, key]);
    if (sanitized !== REMOVED_EVIDENCE) next[key] = sanitized;
  }
  return next;
}

function sanitizeEvidence(
  value: unknown,
  options: { keepAx: boolean; keepDomChanges: boolean },
) {
  let sanitized = value;
  for (const [kind, keep] of [
    ['ax', options.keepAx],
    ['domChanges', options.keepDomChanges],
  ] as const) {
    const paths = collectEvidencePaths(sanitized, kind);
    const keepPath = keep ? preferredEvidencePath(paths, kind) : undefined;
    const keepKey = keepPath ? evidencePathKey(keepPath) : undefined;
    const remove = new Set(paths
      .map(evidencePathKey)
      .filter((pathKey) => pathKey !== keepKey));
    if (!remove.size) continue;
    const next = removeEvidencePaths(sanitized, remove);
    sanitized = next === REMOVED_EVIDENCE ? undefined : next;
  }
  return sanitized;
}

function parseActual(actual: string) {
  try {
    return recordFromUnknown(JSON.parse(actual));
  } catch {
    return undefined;
  }
}

function actualEvidence(actual: string) {
  const parsed = parseActual(actual);
  return {
    ax: parsed ? collectEvidencePaths(parsed, 'ax').length > 0 : isAxTreeString(actual),
    domChanges: parsed ? collectEvidencePaths(parsed, 'domChanges').length > 0 : false,
  };
}

function serializeActual(parsed: JsonRecord, original: string) {
  return JSON.stringify(parsed, null, original.includes('\n') ? 2 : undefined);
}

function sanitizeBrowserCodeActual(
  actual: string,
  options: { compact: boolean; keepAx: boolean; keepDomChanges: boolean },
) {
  const parsed = parseActual(actual);
  if (!parsed) {
    if (isAxTreeString(actual) && !options.keepAx) {
      return options.compact
        ? JSON.stringify({ historicalToolResult: true, note: 'Historical AX evidence removed.' })
        : '';
    }
    if (!options.compact) return actual;
    return actual.length <= 4_000
      ? actual
      : `${actual.slice(0, 4_000)}\n[older browserCode result truncated]`;
  }

  const sanitized = sanitizeEvidence(parsed, options) as JsonRecord;
  if (!options.compact) {
    const serialized = serializeActual(sanitized, actual);
    return serialized === serializeActual(parsed, actual) ? actual : serialized;
  }

  const resultContainsAx = collectEvidencePaths(sanitized.result, 'ax').length > 0;
  const compact = {
    historicalToolResult: true,
    ok: sanitized.ok,
    result: resultContainsAx ? sanitized.result : boundedValue(sanitized.result),
    error: boundedValue(sanitized.error, 1_200),
    aborted: sanitized.aborted,
    elapsedMs: sanitized.elapsedMs,
    finalPage: boundedValue(sanitized.finalPage, 800),
    ...(options.keepDomChanges && sanitized.domChanges !== undefined
      ? { domChanges: sanitized.domChanges }
      : {}),
    ...(options.keepAx && sanitized.axTree !== undefined
      ? { axTree: sanitized.axTree }
      : {}),
    images: boundedValue(sanitized.images, 600),
    note: 'This is an older browserCode result. Durable outcome facts remain; historical AX and DOM-change evidence was removed.',
  };
  return JSON.stringify(compact);
}

function actualStringFromToolValue(value: unknown) {
  const record = recordFromUnknown(value);
  if (typeof record?.actual === 'string') return record.actual;
  return typeof value === 'string' ? value : undefined;
}

function rewriteBrowserCodeToolValue(
  value: unknown,
  options: { compact: boolean; keepAx: boolean; keepDomChanges: boolean },
) {
  const actual = actualStringFromToolValue(value);
  if (actual === undefined) return options.compact ? boundedValue(value, 4_000) : value;
  const nextActual = sanitizeBrowserCodeActual(actual, options);
  const record = recordFromUnknown(value);
  if (!record) return nextActual;
  const next = {
    ...record,
    actual: nextActual,
    referenceImagePath: undefined,
    referenceImagePaths: undefined,
  };
  return nextActual === actual && !options.compact ? value : next;
}

type MutableToolResultPart = {
  type?: unknown;
  toolName?: unknown;
  output?: {
    type?: unknown;
    value?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

/**
 * Model-bound browserCode history has two independent rolling evidence slots:
 * one newest AX tree and one newest DOM-change journal. Older evidence is
 * removed completely while durable outcomes remain available. Persisted
 * execution traces are not modified.
 */
export function compactOlderBrowserCodeToolResults(messages: ModelMessage[]): ModelMessage[] {
  const locations: Array<{
    ax: boolean;
    domChanges: boolean;
    messageIndex: number;
    partIndex: number;
  }> = [];
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const [partIndex, rawPart] of message.content.entries()) {
      const part = rawPart as MutableToolResultPart;
      if (part.type !== 'tool-result' || part.toolName !== 'browserCode') continue;
      const actual = actualStringFromToolValue(part.output?.value);
      const evidence = actual ? actualEvidence(actual) : { ax: false, domChanges: false };
      locations.push({ ...evidence, messageIndex, partIndex });
    }
  }
  if (!locations.length) return messages;

  const latestIndex = locations.length - 1;
  const latestAxIndex = locations.findLastIndex((location) => location.ax);
  const latestDomChangesIndex = locations.findLastIndex((location) => location.domChanges);
  const locationsByMessage = new Map<number, Map<number, number>>();
  locations.forEach((location, index) => {
    const parts = locationsByMessage.get(location.messageIndex) || new Map<number, number>();
    parts.set(location.partIndex, index);
    locationsByMessage.set(location.messageIndex, parts);
  });

  let changed = false;
  const rewritten = messages.map((message, messageIndex) => {
    const partIndexes = locationsByMessage.get(messageIndex);
    if (!partIndexes || message.role !== 'tool' || !Array.isArray(message.content)) return message;
    const content = message.content.map((rawPart, partIndex) => {
      const locationIndex = partIndexes.get(partIndex);
      if (locationIndex === undefined) return rawPart;
      const part = rawPart as MutableToolResultPart;
      const output = part.output;
      if (!output || !('value' in output)) return rawPart;
      const nextValue = rewriteBrowserCodeToolValue(output.value, {
        compact: locationIndex !== latestIndex,
        keepAx: locationIndex === latestAxIndex,
        keepDomChanges: locationIndex === latestDomChangesIndex,
      });
      if (nextValue === output.value) return rawPart;
      changed = true;
      return {
        ...part,
        output: { ...output, value: nextValue },
      } as unknown as typeof rawPart;
    });
    return content.every((part, index) => part === message.content[index])
      ? message
      : { ...message, content } as ModelMessage;
  });
  return changed ? rewritten : messages;
}
