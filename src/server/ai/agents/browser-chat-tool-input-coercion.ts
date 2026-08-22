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
  return normalized === 'unoapi' || normalized === 'uno-api' || normalized === 'uno_api'
    ? 'unoApi'
    : normalized;
}

function documentTypeFromFileName(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const extension = value.trim().toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (['doc', 'docx', 'odt'].includes(extension || '')) return 'word';
  if (['xls', 'xlsx', 'ods'].includes(extension || '')) return 'spreadsheet';
  if (['ppt', 'pptx', 'odp'].includes(extension || '')) return 'presentation';
  return undefined;
}

/** Scalar transport normalization only; never reshape a document or program. */
export function coerceBrowserChatToolInput(toolName: string, value: unknown) {
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
  for (const key of ['limit', 'offset']) if (key in input) input[key] = numberFromString(input[key]);
  // Compatibility with recorded/queued calls from the retired optimistic-lock protocol.
  delete input.expectedRevision;
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
