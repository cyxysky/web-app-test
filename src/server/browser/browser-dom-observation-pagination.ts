export type DomObservationMode = 'actionable' | 'changes' | 'full' | 'text';

export type DomObservationPageRecord = {
  id: string;
  lines: string[];
  mode: DomObservationMode;
  pageMaxChars: number;
  pageStarts: number[];
};

export function encodeDomObservationCursor(record: DomObservationPageRecord, index: number) {
  return Buffer.from(JSON.stringify({ id: record.id, index, mode: record.mode }), 'utf8').toString('base64url');
}

export function parseDomObservationCursor(cursor: string) {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<{
      id: string;
      index: number;
      mode: string;
    }>;
    if (
      typeof value.id !== 'string'
      || !value.id
      || !Number.isFinite(value.index)
      || !['actionable', 'full', 'text', 'changes'].includes(value.mode || '')
    ) return undefined;
    return {
      id: value.id,
      index: Math.max(0, Math.floor(value.index!)),
      mode: value.mode as DomObservationMode,
    };
  } catch {
    return undefined;
  }
}

export function domObservationPageCharLimit(mode: DomObservationMode) {
  return mode === 'full' ? 40_000 : 20_000;
}

export function domObservationPageStarts(lines: string[], maxChars: number) {
  const starts = [0];
  let chars = 0;
  let entries = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const addition = lines[index].length + (entries ? 1 : 0);
    if (entries && chars + addition > maxChars) {
      starts.push(index);
      chars = 0;
      entries = 0;
    }
    chars += lines[index].length + (entries ? 1 : 0);
    entries += 1;
  }
  return starts;
}

export function readDomObservationPage(record: DomObservationPageRecord, startIndex: number) {
  const lines: string[] = [];
  let chars = 0;
  let nextIndex = Math.min(startIndex, record.lines.length);
  for (let index = nextIndex; index < record.lines.length; index += 1) {
    const line = record.lines[index];
    const addition = line.length + (lines.length ? 1 : 0);
    if (lines.length && chars + addition > record.pageMaxChars) break;
    lines.push(line);
    chars += addition;
    nextIndex = index + 1;
  }
  const content = lines.join('\n');
  return {
    content,
    contentCharLength: content.length,
    hasMore: nextIndex < record.lines.length,
    nextCursor: nextIndex < record.lines.length ? encodeDomObservationCursor(record, nextIndex) : undefined,
    pageNumber: Math.max(1, record.pageStarts.indexOf(startIndex) + 1),
    returnedEntries: Math.max(0, nextIndex - startIndex),
    startIndex,
    totalPages: record.pageStarts.length,
    totalEntries: record.lines.length,
  };
}
