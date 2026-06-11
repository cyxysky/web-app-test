export function normalizeDomPathString(value: unknown) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  const exact = raw.match(/^\[?(\d+(?:\.\d+)*)\]?$/);
  if (exact) return exact[1];
  const bracketed = raw.match(/\[(\d+(?:\.\d+)*)\]/);
  return bracketed?.[1] || raw;
}

export function normalizeDomPathParam(input: Record<string, unknown>) {
  return normalizeDomPathString(input.path) || normalizeDomPathString(input.domPath);
}

export function normalizeDomNodeIdString(value: unknown) {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!raw) return '';
  const exact = raw.match(/^\[?(\d+)\]?$/);
  if (exact) return exact[1];
  const named = raw.match(/^(?:nodeId|node|id)\s*[:=]\s*\[?(\d+)\]?$/i);
  return named?.[1] || '';
}

export function normalizeDomNodeIdParam(input: Record<string, unknown>) {
  return normalizeDomNodeIdString(input.id) || normalizeDomNodeIdString(input.nodeId);
}
