export const SENSITIVE_DATA_EVALUATION_CASE_LIMIT = 100;
export const SENSITIVE_DATA_EVALUATION_TEXT_LIMIT = 100_000;
export const SENSITIVE_DATA_EVALUATION_TOTAL_TEXT_LIMIT = 1_000_000;
export const SENSITIVE_DATA_EVALUATION_EXPECTED_VALUE_LIMIT = 100;

export type SensitiveDataEvaluationCase = {
  id: string;
  name: string;
  text: string;
  expectedValues: string[];
};

export type SensitiveDataEvaluationComparison = {
  passed: boolean;
  matchedValues: string[];
  missingValues: string[];
  unexpectedValues: string[];
};

function canonicalValue(value: string) {
  return value.normalize('NFKC').trim().toLocaleLowerCase();
}

function uniqueValues(values: string[], limit = SENSITIVE_DATA_EVALUATION_EXPECTED_VALUE_LIMIT) {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of values) {
    const value = String(item || '').trim();
    const canonical = canonicalValue(value);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    output.push(value);
    if (output.length >= limit) break;
  }
  return output;
}

export function normalizeSensitiveDataEvaluationCases(input: unknown): SensitiveDataEvaluationCase[] {
  if (!Array.isArray(input)) return [];
  const seenIds = new Set<string>();
  const output: SensitiveDataEvaluationCase[] = [];
  for (const [index, item] of input.entries()) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Partial<SensitiveDataEvaluationCase>;
    const text = typeof record.text === 'string'
      ? record.text.slice(0, SENSITIVE_DATA_EVALUATION_TEXT_LIMIT)
      : '';
    if (!text.trim()) continue;
    const baseId = String(record.id || `evaluation-${index + 1}`).trim().slice(0, 120) || `evaluation-${index + 1}`;
    let id = baseId;
    let suffix = 2;
    while (seenIds.has(id)) id = `${baseId}-${suffix++}`;
    seenIds.add(id);
    output.push({
      id,
      name: String(record.name || '').trim().slice(0, 200),
      text,
      expectedValues: uniqueValues(Array.isArray(record.expectedValues) ? record.expectedValues : []),
    });
    if (output.length >= SENSITIVE_DATA_EVALUATION_CASE_LIMIT) break;
  }
  return output;
}

export function compareSensitiveDataEvaluationValues(
  expectedValues: string[],
  detectedValues: string[],
): SensitiveDataEvaluationComparison {
  const expected = uniqueValues(expectedValues);
  const detected = uniqueValues(detectedValues);
  const expectedKeys = new Set(expected.map(canonicalValue));
  const detectedKeys = new Set(detected.map(canonicalValue));
  return {
    passed: expectedKeys.size === detectedKeys.size && [...expectedKeys].every((value) => detectedKeys.has(value)),
    matchedValues: expected.filter((value) => detectedKeys.has(canonicalValue(value))),
    missingValues: expected.filter((value) => !detectedKeys.has(canonicalValue(value))),
    unexpectedValues: detected.filter((value) => !expectedKeys.has(canonicalValue(value))),
  };
}
