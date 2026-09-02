export type BrowserTextAnchor = {
  offset?: number;
  afterText?: string;
  beforeText?: string;
  occurrence?: number;
};

export type BrowserTextSelectionSpec =
  | {
      exactText: string;
      occurrence?: number;
      direction?: 'forward' | 'backward';
    }
  | {
      start: BrowserTextAnchor;
      end?: BrowserTextAnchor;
      direction?: 'forward' | 'backward';
    };

export type EditableTextSelection = {
  before: string;
  collapsed: boolean;
  direction: 'forward' | 'backward';
  end: number;
  selectedText: string;
  start: number;
};

export function resolveEditableTextSelection(
  before: string,
  spec: BrowserTextSelectionSpec,
): EditableTextSelection {
  const positiveOccurrence = (value: unknown, label: string) => {
    const occurrence = value === undefined ? 1 : Number(value);
    if (!Number.isInteger(occurrence) || occurrence < 1) {
      throw new Error(`${label} occurrence must be a positive integer.`);
    }
    return occurrence;
  };
  const textOccurrenceOffset = (needle: string, occurrenceValue: unknown, label: string) => {
    if (!needle) throw new Error(`${label} text cannot be empty.`);
    const occurrence = positiveOccurrence(occurrenceValue, label);
    let offset = -1;
    let searchFrom = 0;
    for (let index = 0; index < occurrence; index += 1) {
      offset = before.indexOf(needle, searchFrom);
      if (offset < 0) break;
      searchFrom = offset + needle.length;
    }
    if (offset < 0) {
      throw new Error(`${label} occurrence ${occurrence} was not found in the editable text.`);
    }
    return offset;
  };
  const resolveAnchor = (anchor: BrowserTextAnchor, label: string) => {
    if (!anchor || typeof anchor !== 'object') throw new Error(`${label} anchor is required.`);
    const hasOffset = anchor.offset !== undefined;
    const hasAfterText = anchor.afterText !== undefined;
    const hasBeforeText = anchor.beforeText !== undefined;
    if (Number(hasOffset) + Number(hasAfterText) + Number(hasBeforeText) !== 1) {
      throw new Error(`${label} requires exactly one of offset, afterText, or beforeText.`);
    }
    if (hasOffset) {
      if (!Number.isInteger(anchor.offset) || Number(anchor.offset) < 0) {
        throw new Error(`${label} offset must be a non-negative integer.`);
      }
      if (anchor.occurrence !== undefined) {
        throw new Error(`${label} occurrence is available only with afterText or beforeText.`);
      }
      return Number(anchor.offset);
    }
    const needle = hasAfterText ? String(anchor.afterText) : String(anchor.beforeText);
    const matchOffset = textOccurrenceOffset(needle, anchor.occurrence, label);
    return hasAfterText ? matchOffset + needle.length : matchOffset;
  };

  let start: number;
  let end: number;
  if ('exactText' in spec) {
    const exactText = typeof spec.exactText === 'string' ? spec.exactText : '';
    start = textOccurrenceOffset(exactText, spec.occurrence, 'Selection text');
    end = start + exactText.length;
  } else {
    start = resolveAnchor(spec.start, 'Selection start');
    end = spec.end ? resolveAnchor(spec.end, 'Selection end') : start;
  }
  if (start > before.length || end > before.length) {
    throw new Error(`Selection range ${start}-${end} exceeds editable text length ${before.length}.`);
  }
  if (end < start) throw new Error(`Selection end ${end} cannot precede start ${start}.`);
  const direction = spec.direction === 'backward' ? 'backward' : 'forward';
  return {
    before,
    collapsed: start === end,
    direction,
    end,
    selectedText: before.slice(start, end),
    start,
  };
}
