type JsonRecord = Record<string, unknown>;

function recordFromUnknown(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function jsonValueFromString(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function unwrapToolTransport(value: unknown) {
  let current = jsonValueFromString(value);
  for (let depth = 0; depth < 3; depth += 1) {
    const record = recordFromUnknown(current);
    if (!record) return current;
    const wrapped = ['arguments', 'input', 'params']
      .map((key) => jsonValueFromString(record[key]))
      .find((candidate) => Boolean(recordFromUnknown(candidate)));
    const wrappedRecord = recordFromUnknown(wrapped);
    if (!wrappedRecord) return record;
    current = { ...record, ...wrappedRecord };
    delete (current as JsonRecord).arguments;
    delete (current as JsonRecord).input;
    delete (current as JsonRecord).params;
  }
  return current;
}

function booleanFromString(value: unknown) {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return value;
}

function numberFromString(value: unknown) {
  if (typeof value !== 'string') return value;
  const normalized = value.trim();
  if (!/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) return value;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : value;
}

function arrayFromJsonString(value: unknown) {
  if (typeof value !== 'string' || !value.trim().startsWith('[')) return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function normalizedDocumentType(value: unknown) {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase().replace(/[\s_.-]+/g, '');
  if (['word', 'writer', 'swriter', 'doc', 'docx', 'odt'].includes(normalized)) return 'word';
  if (['spreadsheet', 'calc', 'scalc', 'excel', 'xls', 'xlsx', 'ods'].includes(normalized)) return 'spreadsheet';
  if (['presentation', 'impress', 'simpress', 'powerpoint', 'ppt', 'pptx', 'odp'].includes(normalized)) return 'presentation';
  return value;
}

function normalizedAction(value: unknown) {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (['unoapi', 'uno-api', 'uno_api'].includes(normalized)) return 'unoApi';
  if (['jsapi', 'js-api', 'js_api'].includes(normalized)) return 'jsApi';
  if (['visualindex', 'visual-index', 'visual_index', 'visual.index'].includes(normalized)) return 'visualIndex';
  if (['visualread', 'visual-read', 'visual_read', 'visual.read'].includes(normalized)) return 'visualRead';
  if (['visualreport', 'visual-report', 'visual_report', 'visual.report'].includes(normalized)) return 'visualReport';
  return normalized;
}

function documentTypeFromFileName(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const extension = value.trim().toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (['doc', 'docx', 'odt'].includes(extension || '')) return 'word';
  if (['xls', 'xlsx', 'ods'].includes(extension || '')) return 'spreadsheet';
  if (['ppt', 'pptx', 'odp'].includes(extension || '')) return 'presentation';
  return undefined;
}

function codexPatchHasChanges(value: string) {
  return value.split(/\r?\n/).some((line) => (
    (line.startsWith('+') && !line.startsWith('+++'))
    || (line.startsWith('-') && !line.startsWith('---'))
  ));
}

function codexPatchHasAdditions(value: string) {
  return value.split(/\r?\n/).some((line) => line.startsWith('+') && !line.startsWith('+++'));
}

function normalizeRepeatedCodexPatchEnvelopes(value: string) {
  const lines = value.replace(/\r\n/g, '\n').trim().split('\n');
  if (lines.filter((line) => line.trim() === '*** Begin Patch').length <= 1) return value;
  const body = lines.filter((line) => (
    line.trim() !== '*** Begin Patch' && line.trim() !== '*** End Patch'
  ));
  return ['*** Begin Patch', ...body, '*** End Patch'].join('\n');
}

function legacyReplacementPatch(oldValue: string, newValue: string) {
  const trimEmptyEdgeLines = (lines: string[]) => {
    let start = 0;
    let end = lines.length;
    while (start < end && !lines[start].trim()) start += 1;
    while (end > start && !lines[end - 1].trim()) end -= 1;
    return lines.slice(start, end);
  };
  let oldLines = trimEmptyEdgeLines(oldValue.replace(/\r\n/g, '\n').split('\n'));
  if (oldLines[0]?.trim() === '*** Begin Patch') {
    oldLines = oldLines.flatMap((line) => {
      if (
        line.trim() === '*** Begin Patch'
        || line.trim() === '*** End Patch'
        || line.trim() === '*** End of File'
        || line.startsWith('*** Update File: ')
        || line === '@@'
        || line.startsWith('@@ ')
      ) return [];
      if (line.startsWith('+')) return [];
      if (line.startsWith('-') || line.startsWith(' ')) return [line.slice(1)];
      return [line];
    });
  }
  const replacement = trimEmptyEdgeLines(newValue
    .replace(/^```(?:python|py)?[ \t]*\r?\n/i, '')
    .replace(/\r?\n```[ \t]*$/i, '')
    .replace(/\r\n/g, '\n')
    .split('\n'));
  if (!oldLines.length || !oldLines.some((line) => line.length)) return undefined;
  return [
    '*** Begin Patch',
    '*** Update File: draft.py',
    '@@',
    ...oldLines.map((line) => `-${line}`),
    ...replacement.map((line) => `+${line}`),
    '*** End Patch',
  ].join('\n');
}

export function normalizeFileToolInput(value: unknown) {
  const source = recordFromUnknown(unwrapToolTransport(value));
  if (!source) return value;
  const input: JsonRecord = { ...source };
  if ('action' in input) input.action = normalizedAction(input.action);
  if ('documentType' in input) input.documentType = normalizedDocumentType(input.documentType);
  if (input.action === 'plan' && !input.documentType) {
    const inferred = documentTypeFromFileName(input.fileName);
    if (inferred) input.documentType = inferred;
  }
  for (const key of ['render', 'includeVisuals', 'replaceExisting']) {
    if (key in input) input[key] = booleanFromString(input[key]);
  }
  for (const key of ['limit', 'offset', 'startLine', 'endLine']) {
    if (key in input) input[key] = numberFromString(input[key]);
  }
  delete input.expectedRevision;
  if (input.action === 'edit' && typeof input.patch === 'string' && typeof input.replace === 'string') {
    if (!codexPatchHasChanges(input.patch) || !codexPatchHasAdditions(input.patch)) {
      input.patch = legacyReplacementPatch(input.patch, input.replace) || input.patch;
    }
    delete input.replace;
  }
  if (input.action === 'edit' && typeof input.patch === 'string') {
    input.patch = normalizeRepeatedCodexPatchEnvelopes(input.patch);
  }
  if ('pages' in input) input.pages = arrayFromJsonString(input.pages);
  if (Array.isArray(input.pages)) input.pages = input.pages.map(numberFromString);
  if ('screenshotIds' in input) input.screenshotIds = arrayFromJsonString(input.screenshotIds);
  if ('reviews' in input) input.reviews = arrayFromJsonString(input.reviews);
  if ('deckReview' in input) input.deckReview = jsonValueFromString(input.deckReview);
  return input;
}
