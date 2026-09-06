import {
  arrayFromJsonString,
  jsonRecordFromUnknown,
  jsonValueFromString,
  unwrapToolTransport,
  type JsonRecord,
} from '@webpilot/capability-sdk';

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
  if (['readsource', 'read-source', 'read_source'].includes(normalized)) return 'readSource';
  if (['readcontent', 'read-content', 'read_content'].includes(normalized)) return 'readContent';
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

export function normalizeFileToolInput(value: unknown) {
  const source = jsonRecordFromUnknown(unwrapToolTransport(value));
  if (!source) return value;
  const input: JsonRecord = { ...source };
  if ('action' in input) input.action = normalizedAction(input.action);
  // Preserve old integrations while giving models two unambiguous actions.
  // Conflicting identities are rejected by validation, never silently ignored.
  if (input.action === 'read') input.action = input.documentId ? 'readSource' : 'readContent';
  if ('documentType' in input) input.documentType = normalizedDocumentType(input.documentType);
  if (input.action === 'plan' && !input.documentType) {
    const inferred = documentTypeFromFileName(input.fileName);
    if (inferred) input.documentType = inferred;
  }
  for (const key of ['render', 'includeVisuals', 'includeDiagnostics', 'replaceExisting']) {
    if (key in input) input[key] = booleanFromString(input[key]);
  }
  for (const key of ['limit', 'offset', 'startLine', 'endLine']) {
    if (key in input) input[key] = numberFromString(input[key]);
  }
  if ('pages' in input) input.pages = arrayFromJsonString(input.pages);
  if (Array.isArray(input.pages)) input.pages = input.pages.map(numberFromString);
  if ('contentPages' in input) input.contentPages = arrayFromJsonString(input.contentPages);
  if (Array.isArray(input.contentPages)) input.contentPages = input.contentPages.map(numberFromString);
  if ('screenshotIds' in input) input.screenshotIds = arrayFromJsonString(input.screenshotIds);
  if ('reviews' in input) input.reviews = arrayFromJsonString(input.reviews);
  if ('replacements' in input) input.replacements = arrayFromJsonString(input.replacements);
  if ('deckReview' in input) input.deckReview = jsonValueFromString(input.deckReview);
  if ('spec' in input) input.spec = jsonValueFromString(input.spec);
  if ('design' in input) input.design = jsonValueFromString(input.design);
  return input;
}
