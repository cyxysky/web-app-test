type JsonRecord = Record<string, unknown>;

function recordFromUnknown(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function jsonValueFromString(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * OpenAI-compatible gateways commonly put the actual JSON under `input`,
 * `arguments`, or `params`, and some hand it to the SDK as a JSON string.
 * This normalizes that transport envelope only; it never unwraps document
 * content such as outline/item/blocks or rewrites model-authored programs.
 */
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
    // A provider may retain action/reason alongside a params object.
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
    const parsed = JSON.parse(value);
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
  if (normalized === 'unoapi' || normalized === 'uno-api' || normalized === 'uno_api') return 'unoApi';
  if (normalized === 'jsapi' || normalized === 'js-api' || normalized === 'js_api') return 'jsApi';
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

function browserCodeFromGeneratedMarkup(value: unknown) {
  if (typeof value !== 'string') return value;
  let code = value.trim();
  code = code
    .replace(/^```(?:javascript|js)?[ \t]*\r?\n/i, '')
    .replace(/\r?\n```[ \t]*$/i, '')
    .replace(/^<code(?:\s[^>]*)?>\s*/i, '')
    .replace(/\s*<\/code>$/i, '')
    .trim();
  return code;
}

function codexPatchHasChanges(value: string) {
  return value.split(/\r?\n/).some((line) => (
    (line.startsWith('+') && !line.startsWith('+++'))
    || (line.startsWith('-') && !line.startsWith('---'))
  ));
}

function legacyReplacementPatch(oldValue: string, newValue: string) {
  let oldLines = oldValue.replace(/\r\n/g, '\n').trim().split('\n');
  if (oldLines[0]?.trim() === '*** Begin Patch') {
    oldLines = oldLines.filter((line) => (
      line.trim() !== '*** Begin Patch'
      && line.trim() !== '*** End Patch'
      && line.trim() !== '*** End of File'
      && !line.startsWith('*** Update File: ')
      && line !== '@@'
      && !line.startsWith('@@ ')
    )).map((line) => line.startsWith(' ') ? line.slice(1) : line);
  }
  const replacement = newValue
    .replace(/^```(?:python|py)?[ \t]*\r?\n/i, '')
    .replace(/\r?\n```[ \t]*$/i, '')
    .replace(/\r\n/g, '\n')
    .trim()
    .split('\n');
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

/** Scalar transport normalization only; never reshape a document or program. */
export function coerceBrowserChatToolInput(toolName: string, value: unknown) {
  if (toolName === 'browserCode') {
    const source = recordFromUnknown(unwrapToolTransport(value));
    if (!source) return value;
    return {
      ...source,
      ...('code' in source ? { code: browserCodeFromGeneratedMarkup(source.code) } : {}),
    };
  }
  if (toolName === 'reportDefect') {
    const source = recordFromUnknown(unwrapToolTransport(value));
    if (!source) return value;
    return {
      ...source,
      reasons: arrayFromJsonString(source.reasons),
      reproductionSteps: arrayFromJsonString(source.reproductionSteps),
      screenshotFileNames: arrayFromJsonString(source.screenshotFileNames),
    };
  }
  if (toolName !== 'file' && toolName !== 'fileVisual') return value;
  const source = recordFromUnknown(unwrapToolTransport(value));
  if (!source) return value;
  const input: JsonRecord = { ...source };
  if ('action' in input) input.action = normalizedAction(input.action);
  if (toolName === 'fileVisual') {
    for (const key of ['limit', 'offset']) if (key in input) input[key] = numberFromString(input[key]);
    if ('screenshotIds' in input) input.screenshotIds = arrayFromJsonString(input.screenshotIds);
    return input;
  }
  if ('documentType' in input) input.documentType = normalizedDocumentType(input.documentType);
  if (input.action === 'plan' && !input.documentType) {
    const inferred = documentTypeFromFileName(input.fileName);
    if (inferred) input.documentType = inferred;
  }
  if ('render' in input) input.render = booleanFromString(input.render);
  if ('includeVisuals' in input) input.includeVisuals = booleanFromString(input.includeVisuals);
  if ('replaceExisting' in input) input.replaceExisting = booleanFromString(input.replaceExisting);
  for (const key of ['limit', 'offset']) if (key in input) input[key] = numberFromString(input[key]);
  // Compatibility with recorded/queued calls from the retired optimistic-lock protocol.
  delete input.expectedRevision;
  // A few gateways/models put the old block in patch and the new block in an
  // invented `replace` field. Normalize that deterministic two-block form into
  // the exact Codex patch grammar before schema validation. Proper Codex
  // patches remain untouched, and the compatibility-only field never leaks to
  // the editor implementation.
  if (input.action === 'edit' && typeof input.patch === 'string' && typeof input.replace === 'string') {
    if (!codexPatchHasChanges(input.patch)) {
      input.patch = legacyReplacementPatch(input.patch, input.replace) || input.patch;
    }
    delete input.replace;
  }
  if ('pages' in input) input.pages = arrayFromJsonString(input.pages);
  if (Array.isArray(input.pages)) input.pages = input.pages.map(numberFromString);
  return input;
}

export function repairBrowserChatToolCallInput(toolName: string, rawInput: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawInput);
  } catch {
    return undefined;
  }
  const repaired = coerceBrowserChatToolInput(toolName, parsed);
  const serialized = JSON.stringify(repaired);
  return serialized !== JSON.stringify(parsed) ? serialized : undefined;
}
