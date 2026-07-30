import type { ModelMessage } from 'ai';

type JsonRecord = Record<string, unknown>;

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

function compactDomChanges(value: unknown) {
  const changes = recordFromUnknown(value);
  if (!changes) return undefined;
  const extra = recordFromUnknown(changes?.extra);
  const count = (items: unknown) => Array.isArray(items) ? items.length : 0;
  return {
    epoch: changes.epoch,
    addedCount: count(changes.added),
    updatedCount: count(changes.updated),
    removedCount: count(changes.removed),
    validationErrors: Array.isArray(extra?.validationErrors) ? extra.validationErrors.slice(0, 5) : [],
    errors: Array.isArray(extra?.errors) ? extra.errors.slice(0, 3) : [],
    overflow: changes.overflow === true,
  };
}

function compactBrowserCodeActual(actual: string) {
  let parsed: JsonRecord | undefined;
  try {
    parsed = recordFromUnknown(JSON.parse(actual));
  } catch {
    return actual.length <= 4_000
      ? actual
      : `${actual.slice(0, 4_000)}\n[older browserCode result truncated]`;
  }
  if (!parsed) return actual.slice(0, 4_000);
  const legacySnapshot = recordFromUnknown(parsed.domSnapshot);
  const compact = {
    historicalToolResult: true,
    ok: parsed.ok,
    result: boundedValue(parsed.result),
    error: parsed.error,
    aborted: parsed.aborted,
    elapsedMs: parsed.elapsedMs,
    finalPage: boundedValue(parsed.finalPage, 800),
    domChanges: compactDomChanges(parsed.domChanges),
    legacySnapshot: legacySnapshot ? {
      generationId: legacySnapshot.generationId,
      mode: legacySnapshot.mode,
      hasMore: legacySnapshot.hasMore,
      nodeCount: legacySnapshot.nodeCount,
      actionableCount: legacySnapshot.actionableCount,
      note: 'Full historical DOM content removed; inspect the current live page before another action.',
    } : undefined,
    images: boundedValue(parsed.images, 600),
    note: 'This is an older browserCode result. Its transient page details were compacted; the latest browserCode result is authoritative.',
  };
  return JSON.stringify(compact);
}

function compactBrowserCodeResult(value: unknown) {
  const result = recordFromUnknown(value);
  if (!result) return boundedValue(value, 4_000);
  return {
    ...result,
    actual: typeof result.actual === 'string'
      ? compactBrowserCodeActual(result.actual)
      : boundedValue(result.actual, 4_000),
    domChanges: undefined,
    referenceImagePath: undefined,
    referenceImagePaths: undefined,
  };
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
 * Keep the latest browserCode result intact and roll older results down to
 * durable facts. This runs only on the model-bound copy; persisted execution
 * traces remain complete for debugging and export.
 */
export function compactOlderBrowserCodeToolResults(messages: ModelMessage[]): ModelMessage[] {
  const locations: Array<{ messageIndex: number; partIndex: number }> = [];
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const [partIndex, rawPart] of message.content.entries()) {
      const part = rawPart as MutableToolResultPart;
      if (part.type === 'tool-result' && part.toolName === 'browserCode') {
        locations.push({ messageIndex, partIndex });
      }
    }
  }
  if (locations.length < 2) return messages;
  const latest = locations.at(-1)!;
  const compactLocations = new Map<number, Set<number>>();
  for (const location of locations) {
    if (location.messageIndex === latest.messageIndex && location.partIndex === latest.partIndex) continue;
    const indexes = compactLocations.get(location.messageIndex) || new Set<number>();
    indexes.add(location.partIndex);
    compactLocations.set(location.messageIndex, indexes);
  }
  return messages.map((message, messageIndex) => {
    const indexes = compactLocations.get(messageIndex);
    if (!indexes || message.role !== 'tool' || !Array.isArray(message.content)) return message;
    const content = message.content.map((rawPart, partIndex) => {
      if (!indexes.has(partIndex)) return rawPart;
      const part = rawPart as MutableToolResultPart;
      const output = part.output;
      if (!output || !('value' in output)) return rawPart;
      return {
        ...part,
        output: {
          ...output,
          value: output.type === 'text' && typeof output.value === 'string'
            ? compactBrowserCodeActual(output.value)
            : compactBrowserCodeResult(output.value),
        },
      } as unknown as typeof rawPart;
    });
    return { ...message, content } as ModelMessage;
  });
}

function compactOlderDomUpdates(messages: ModelMessage[]): ModelMessage[] {
  const locations: Array<{ messageIndex: number; partIndex: number }> = [];
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const [partIndex, rawPart] of message.content.entries()) {
      const part = rawPart as MutableToolResultPart;
      const value = recordFromUnknown(part.output?.value);
      const domChanges = value ? recordFromUnknown(value.domChanges) : undefined;
      const hasFullDomUpdate = domChanges && (
        Array.isArray(domChanges.added)
        || Array.isArray(domChanges.updated)
        || Array.isArray(domChanges.removed)
      );
      if (part.type === 'tool-result' && value && hasFullDomUpdate) {
        locations.push({ messageIndex, partIndex });
      }
    }
  }
  if (locations.length < 2) return messages;
  const latest = locations.at(-1)!;
  const compactLocations = new Map<number, Set<number>>();
  for (const location of locations) {
    if (location.messageIndex === latest.messageIndex && location.partIndex === latest.partIndex) continue;
    const indexes = compactLocations.get(location.messageIndex) || new Set<number>();
    indexes.add(location.partIndex);
    compactLocations.set(location.messageIndex, indexes);
  }
  return messages.map((message, messageIndex) => {
    const indexes = compactLocations.get(messageIndex);
    if (!indexes || message.role !== 'tool' || !Array.isArray(message.content)) return message;
    const content = message.content.map((rawPart, partIndex) => {
      if (!indexes.has(partIndex)) return rawPart;
      const part = rawPart as MutableToolResultPart;
      const output = part.output;
      const value = recordFromUnknown(output?.value);
      if (!output || !value) return rawPart;
      return {
        ...part,
        output: {
          ...output,
          value: {
            ...value,
            domChanges: compactDomChanges(value.domChanges),
            historicalDomUpdate: true,
          },
        },
      } as unknown as typeof rawPart;
    });
    return { ...message, content } as ModelMessage;
  });
}

/**
 * Keep only the latest full DOM update in DOM mode. Older updates retain their
 * outcome and compact counts, while persisted traces remain untouched.
 */
export function compactOlderBrowserToolResults(messages: ModelMessage[], mode: 'code' | 'dom') {
  const compacted = compactOlderBrowserCodeToolResults(messages);
  return mode === 'dom' ? compactOlderDomUpdates(compacted) : compacted;
}
