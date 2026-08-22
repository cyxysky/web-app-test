import type {
  OfficeBlock,
  OfficeBlockStyle,
  OfficeDocumentKind,
  OfficeDocumentSpec,
} from './office-document-spec';

const presentationExtensions = new Set(['.ppt', '.pptx', '.odp']);
const spreadsheetExtensions = new Set(['.xls', '.xlsx', '.ods']);
export const officeBlockStyleKeys = new Set([
  'align', 'backgroundColor', 'borderColor', 'borderRadius', 'borderWidth',
  'color', 'fill', 'fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'gap',
  'height', 'letterSpacing', 'lineHeight', 'margin', 'opacity', 'padding',
  'paddingBottom', 'paddingLeft', 'paddingRight', 'paddingTop', 'position',
  'rotation', 'shadow', 'textAlign', 'unit', 'verticalAlign', 'width', 'x', 'y',
]);

const unsupportedBlockAliases = new Map([
  ['content', 'svg'],
  ['url', 'source'],
]);

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function canonicalStyle(value: unknown): OfficeBlockStyle | undefined {
  const source = plainRecord(value);
  if (!source) return undefined;
  return { ...source };
}

export function normalizeOfficeBlock(block: OfficeBlock): OfficeBlock {
  const style = canonicalStyle(block.style);
  const normalized: OfficeBlock = {
    ...block,
    ...(style ? { style } : {}),
  };
  if (Array.isArray(block.children)) normalized.children = block.children.map(normalizeOfficeBlock);
  if (Array.isArray(block.columns)) {
    normalized.columns = block.columns.map((column) => ({
      ...column,
      blocks: Array.isArray(column.blocks) ? column.blocks.map(normalizeOfficeBlock) : column.blocks,
    }));
  }
  return normalized;
}

function canonicalFieldError(path: string, field: string, target: string) {
  return `${path}.${field} is not a canonical document field; use ${path}.${target}. The renderer does not guess or move semantically ambiguous fields.`;
}

export function validateCanonicalOfficeBlockInput(block: OfficeBlock, path = 'block'): void {
  const source = block as Record<string, unknown>;
  for (const key of officeBlockStyleKeys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      throw new Error(canonicalFieldError(path, key, `style.${key}`));
    }
  }
  for (const [alias, canonical] of unsupportedBlockAliases) {
    if (Object.prototype.hasOwnProperty.call(source, alias)) {
      throw new Error(canonicalFieldError(path, alias, canonical));
    }
  }
  const style = plainRecord(block.style);
  if (style && Object.prototype.hasOwnProperty.call(style, 'text')) {
    throw new Error(`${path}.style.text is not a canonical style field; use ${path}.text. The renderer does not guess or move semantically ambiguous fields.`);
  }
  if (style && Object.prototype.hasOwnProperty.call(style, 'textAlign')) {
    throw new Error(canonicalFieldError(`${path}.style`, 'textAlign', 'align'));
  }
  for (const [index, child] of (block.children || []).entries()) {
    validateCanonicalOfficeBlockInput(child, `${path}.children[${index}]`);
  }
  for (const [columnIndex, column] of (block.columns || []).entries()) {
    for (const [blockIndex, child] of (column.blocks || []).entries()) {
      validateCanonicalOfficeBlockInput(child, `${path}.columns[${columnIndex}].blocks[${blockIndex}]`);
    }
  }
}

export function validateCanonicalOfficeBlockPatch(patch: Record<string, unknown>, path = 'patch'): void {
  for (const key of officeBlockStyleKeys) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      throw new Error(canonicalFieldError(path, key, `style.${key}`));
    }
  }
  for (const [alias, canonical] of unsupportedBlockAliases) {
    if (Object.prototype.hasOwnProperty.call(patch, alias)) {
      throw new Error(canonicalFieldError(path, alias, canonical));
    }
  }
  const style = plainRecord(patch.style);
  if (style && Object.prototype.hasOwnProperty.call(style, 'text')) {
    throw new Error(`${path}.style.text is not a canonical style field; use ${path}.text. The renderer does not guess or move semantically ambiguous fields.`);
  }
  if (style && Object.prototype.hasOwnProperty.call(style, 'textAlign')) {
    throw new Error(canonicalFieldError(`${path}.style`, 'textAlign', 'align'));
  }
  if (Array.isArray(patch.children)) {
    patch.children.forEach((child, index) => validateCanonicalOfficeBlockInput(child as OfficeBlock, `${path}.children[${index}]`));
  }
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

function validateRenderableBlocks(blocks: OfficeBlock[], parent = 'document') {
  for (const block of blocks) {
    const blockPath = `${parent}.${block.id || '<missing-id>'}`;
    const style = plainRecord(block.style) || {};
    for (const key of ['width', 'height']) {
      const value = style[key];
      if (typeof value === 'number' && (!Number.isFinite(value) || value <= 0)) {
        throw new Error(`${blockPath}.style.${key} must be a positive finite number.`);
      }
    }
    if ((block.type === 'text' || block.type === 'heading')
      && !String(block.text ?? block.markdown ?? block.title ?? '').trim()) {
      throw new Error(`${blockPath} is a ${block.type} block without visible text.`);
    }
    if (block.breakBefore !== undefined && block.breakBefore !== 'page') {
      throw new Error(`${blockPath}.breakBefore must be "page" when supplied.`);
    }
    if (block.type === 'spacer' && style.height === undefined) {
      throw new Error(`${blockPath} is a spacer block and requires style.height with an optional style.unit.`);
    }
    if (block.type === 'svg' && !String(block.svg || '').match(/<svg\b/i) && !String(block.source || '').trim()) {
      throw new Error(`${blockPath} requires inline svg markup or a graphic source.`);
    }
    if (block.type === 'image' && !String(block.source || '').trim()) {
      throw new Error(`${blockPath} requires a graphic source.`);
    }
    if (block.type === 'table') {
      if (!Array.isArray(block.rows) || !block.rows.length || !block.rows.some((row) => row.length)) {
        throw new Error(`${blockPath} requires at least one non-empty table row.`);
      }
    }
    if (block.type === 'page' && (!Array.isArray(block.children) || !block.children.length)) {
      throw new Error(`${blockPath} requires at least one child block.`);
    }
    if (Array.isArray(block.children)) validateRenderableBlocks(block.children, blockPath);
    for (const [index, column] of (block.columns || []).entries()) {
      if (Array.isArray(column.blocks)) validateRenderableBlocks(column.blocks, `${blockPath}.columns[${index}]`);
    }
  }
}

export function validateOfficeDocumentStructure(spec: OfficeDocumentSpec, extension: string) {
  const officeStructured = presentationExtensions.has(extension)
    || spreadsheetExtensions.has(extension)
    || extension === '.pdf';
  if (!officeStructured) return;
  spec.blocks.forEach((block, index) => validateCanonicalOfficeBlockInput(block, `blocks[${index}]`));
  const error = topLevelStructureError(spec.documentType, spec.blocks);
  if (error) throw new Error(error);
  validateRenderableBlocks(spec.blocks);
}
