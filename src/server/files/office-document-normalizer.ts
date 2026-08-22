import type {
  OfficeBlock,
  OfficeBlockStyle,
  OfficeDocumentKind,
  OfficeDocumentSpec,
} from './office-document-spec';

const presentationExtensions = new Set(['.ppt', '.pptx', '.odp']);
const spreadsheetExtensions = new Set(['.xls', '.xlsx', '.ods']);

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function canonicalStyle(value: unknown): OfficeBlockStyle | undefined {
  const source = plainRecord(value);
  if (!source) return undefined;
  const style: OfficeBlockStyle = { ...source };
  if (style.align === undefined && typeof source.textAlign === 'string') style.align = source.textAlign as OfficeBlockStyle['align'];
  if (style.backgroundColor === undefined && typeof source.fill === 'string' && !/gradient\s*\(/i.test(source.fill)) {
    style.backgroundColor = source.fill;
  }
  return style;
}

export function normalizeOfficeBlock(block: OfficeBlock): OfficeBlock {
  const source = block as Record<string, unknown>;
  const style = canonicalStyle(block.style);
  const normalized: OfficeBlock = {
    ...block,
    ...(style ? { style } : {}),
  };

  if (normalized.text === undefined && typeof style?.text === 'string') normalized.text = style.text;
  if (normalized.svg === undefined && normalized.type === 'svg' && typeof source.content === 'string') normalized.svg = source.content;
  if (normalized.source === undefined && typeof source.url === 'string') normalized.source = source.url;
  if (Array.isArray(block.children)) normalized.children = block.children.map(normalizeOfficeBlock);
  if (Array.isArray(block.columns)) {
    normalized.columns = block.columns.map((column) => ({
      ...column,
      blocks: Array.isArray(column.blocks) ? column.blocks.map(normalizeOfficeBlock) : column.blocks,
    }));
  }
  return normalized;
}

export function normalizeOfficeDocumentSpec<T extends OfficeDocumentSpec>(spec: T): T {
  return {
    ...spec,
    blocks: spec.blocks.map(normalizeOfficeBlock),
  };
}

function topLevelStructureError(documentType: OfficeDocumentKind, blocks: OfficeBlock[]) {
  if (documentType === 'presentation') {
    if (!blocks.length || blocks.some((block) => block.type !== 'page')) {
      return 'Presentation generation requires explicit top-level page blocks; place every slide element inside one page.children array.';
    }
    if (blocks.some((block) => !Array.isArray(block.children))) {
      return 'Every presentation page block requires a children array.';
    }
  }
  if (documentType === 'spreadsheet') {
    if (!blocks.length || blocks.some((block) => block.type !== 'sheet')) {
      return 'Spreadsheet generation requires explicit top-level sheet blocks; place every worksheet element inside one sheet.children array.';
    }
    if (blocks.some((block) => !Array.isArray(block.children))) {
      return 'Every spreadsheet sheet block requires a children array.';
    }
  }
  return undefined;
}

export function validateOfficeDocumentStructure(spec: OfficeDocumentSpec, extension: string) {
  const officeStructured = presentationExtensions.has(extension)
    || spreadsheetExtensions.has(extension)
    || extension === '.pdf';
  if (!officeStructured) return;
  const error = topLevelStructureError(spec.documentType, spec.blocks);
  if (error) throw new Error(error);
}
