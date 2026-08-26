export type ExtraRequestParameterPair = {
  key: string;
  value: string;
};

function displayValue(value: unknown) {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? '' : serialized;
}

export function parseExtraRequestParameterPairs(value: string | undefined): ExtraRequestParameterPair[] {
  const raw = String(value || '').trim();
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.entries(parsed).map(([key, item]) => ({
      key,
      value: displayValue(item),
    }));
  } catch {
    return [];
  }
}

function parsedPairValue(value: string) {
  const raw = value.trim();
  if (!raw) return '';
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // Unquoted values are treated as strings for convenient form entry.
    return value;
  }
}

export function serializeExtraRequestParameterPairs(pairs: ExtraRequestParameterPair[]) {
  const parameters: Record<string, unknown> = {};
  for (const pair of pairs) {
    const key = pair.key.trim();
    if (!key) continue;
    parameters[key] = parsedPairValue(pair.value);
  }
  return Object.keys(parameters).length ? JSON.stringify(parameters) : '';
}

export function duplicateExtraRequestParameterKeys(pairs: ExtraRequestParameterPair[]) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const pair of pairs) {
    const key = pair.key.trim();
    if (!key) continue;
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return [...duplicates];
}
