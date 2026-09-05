/** The trace/UI keep the original structured result. The model transport must
 * not JSON-encode a JSON string containing another JSON-encoded Python string. */
export function fileToolModelOutput({ output }: { output: unknown }) {
  const record = (value: unknown): Record<string, unknown> | undefined => {
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { return undefined; }
    }
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : undefined;
  };
  const envelope = record(output);
  if (!envelope) return { type: 'text' as const, value: typeof output === 'string' ? output : JSON.stringify(output) ?? String(output) };
  const actual = record(envelope.actual);
  if (!actual) return { type: 'text' as const, value: JSON.stringify(envelope) };
  if (actual.readKind === 'source' && typeof actual.program === 'string') {
    const { program, ...metadata } = actual;
    const fence = '`'.repeat(Math.max(3, ...[...program.matchAll(/`+/g)].map((match) => match[0].length + 1)));
    return {
      type: 'text' as const,
      value: `${JSON.stringify({ ...envelope, actual: metadata })}\n\nExact source below: whitespace, quotes and backslashes are literal, not JSON transport escapes. Copy only source characters into oldText; encode the edit argument as JSON once.\n${fence}${actual.sourceLanguage || ''}\n${program}${program.endsWith('\n') ? '' : '\n'}${fence}`,
    };
  }
  return { type: 'text' as const, value: JSON.stringify({ ...envelope, actual }) };
}
