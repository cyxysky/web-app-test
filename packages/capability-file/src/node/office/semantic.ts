import type {
  OfficeBlock,
  OfficeBlockStyle,
  OfficeDocumentDraft,
  OfficeDocumentKind,
  OfficeDocumentSpec,
  OfficeLayoutDiagnostic,
  OfficeLayoutPolicy,
  OfficeSemanticBlockInput,
  OfficeSemanticDocumentInput,
  OfficeSemanticTemplate,
  OfficeThemeDefinition,
  OfficeThemePreset,
} from '../../office/types.js';

export const OFFICE_SEMANTIC_SCHEMA_VERSION = '1.0' as const;

export type ResolvedOfficeTheme = NonNullable<OfficeDocumentDraft['semantic']>['theme'];
export type ResolvedOfficeLayoutPolicy = Required<OfficeLayoutPolicy>;

const THEME_PRESETS: Record<OfficeThemePreset, ResolvedOfficeTheme> = {
  clean: {
    version: '1',
    preset: 'clean',
    colors: {
      primary: '2563EB', secondary: '0F3D91', accent: '14B8A6',
      background: 'F8FAFC', surface: 'FFFFFF', text: '0F172A',
      muted: '64748B', border: 'CBD5E1',
    },
    fonts: { heading: 'Aptos Display', body: 'Aptos', mono: 'Aptos Mono' },
    typography: { title: 32, heading: 22, body: 11.5, caption: 9, metric: 28 },
  },
  executive: {
    version: '1',
    preset: 'executive',
    colors: {
      primary: '102A43', secondary: '243B53', accent: '2F80ED',
      background: 'F5F7FA', surface: 'FFFFFF', text: '102A43',
      muted: '627D98', border: 'BCCCDC',
    },
    fonts: { heading: 'Aptos Display', body: 'Aptos', mono: 'Aptos Mono' },
    typography: { title: 34, heading: 23, body: 11.5, caption: 9, metric: 30 },
  },
  editorial: {
    version: '1',
    preset: 'editorial',
    colors: {
      primary: '5B2333', secondary: '2D2A32', accent: 'C58B2A',
      background: 'FAFAF8', surface: 'FFFFFF', text: '242126',
      muted: '6B6670', border: 'D7D2D8',
    },
    fonts: { heading: 'Georgia', body: 'Aptos', mono: 'Consolas' },
    typography: { title: 34, heading: 23, body: 11.5, caption: 9, metric: 29 },
  },
  signal: {
    version: '1',
    preset: 'signal',
    colors: {
      primary: '111827', secondary: '1F2937', accent: 'F97316',
      background: 'F9FAFB', surface: 'FFFFFF', text: '111827',
      muted: '6B7280', border: 'D1D5DB',
    },
    fonts: { heading: 'Aptos Display', body: 'Aptos', mono: 'Consolas' },
    typography: { title: 33, heading: 22, body: 11.5, caption: 9, metric: 29 },
  },
};

const KNOWN_BLOCK_TYPES = new Set([
  'page', 'sheet', 'text', 'heading', 'list', 'quote', 'code', 'image', 'svg',
  'chart', 'table', 'card', 'columns', 'metric', 'timeline', 'shape', 'divider',
  'spacer', 'pageBreak',
]);

const SEMANTIC_PAYLOAD_FIELDS = [
  'alt', 'caption', 'chartType', 'children', 'columns', 'data', 'fit', 'items',
  'language', 'level', 'markdown', 'name', 'ordered', 'rows', 'shapeType', 'source',
  'subtitle', 'svg', 'template', 'text', 'title', 'unoProperties', 'unoService',
] as const;
const KNOWN_SEMANTIC_BLOCK_FIELDS = new Set<string>([
  'id', 'type', 'style', 'breakBefore', ...SEMANTIC_PAYLOAD_FIELDS,
]);

const ALLOWED_SEMANTIC_PAYLOAD_FIELDS: Record<string, ReadonlySet<string>> = {
  page: new Set(['children', 'markdown', 'name', 'subtitle', 'template', 'text', 'title']),
  sheet: new Set(['children', 'markdown', 'name', 'subtitle', 'template', 'text', 'title']),
  text: new Set(['markdown', 'text', 'title']),
  heading: new Set(['level', 'markdown', 'text', 'title']),
  quote: new Set(['markdown', 'text', 'title']),
  code: new Set(['markdown', 'text', 'title']),
  list: new Set(['items', 'level', 'ordered', 'title']),
  table: new Set(['rows', 'title']),
  timeline: new Set(['items', 'title']),
  image: new Set(['alt', 'caption', 'fit', 'source', 'title']),
  chart: new Set(['alt', 'caption', 'chartType', 'data', 'source', 'title']),
  card: new Set(['children', 'data', 'name', 'text', 'title']),
  metric: new Set(['data', 'name', 'text', 'title']),
  columns: new Set(['columns']),
  shape: new Set(['shapeType']),
  divider: new Set(),
  spacer: new Set(),
  pageBreak: new Set(),
  svg: new Set(['svg']),
};

const MAX_SEMANTIC_ELEMENT_ID_LENGTH = 46;
const MAX_FACADE_CHILD_ID_LENGTH = 60;
const MAX_SEMANTIC_PRESENTATION_PAGES = 120;
const MAX_SEMANTIC_SPLIT_PARTS = 500;
const MAX_SEMANTIC_TABLE_CELLS: Record<OfficeDocumentKind, number> = {
  presentation: 50_000,
  spreadsheet: 250_000,
  word: 75_000,
};
const MAX_SEMANTIC_CHART_CATEGORIES: Record<OfficeDocumentKind, number> = {
  presentation: 24,
  spreadsheet: 1_000,
  word: 120,
};
const MAX_SEMANTIC_CHART_SERIES: Record<OfficeDocumentKind, number> = {
  presentation: 6,
  spreadsheet: 32,
  word: 12,
};

function finiteNumber(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function firstNonEmptyString(...values: unknown[]) {
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function truncateUnicode(value: string, maximumCharacters: number) {
  return [...value].slice(0, Math.max(0, maximumCharacters)).join('');
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeHex(value: unknown, fallback: string) {
  const normalized = String(value || '').trim().replace(/^#/, '').toUpperCase();
  return /^[0-9A-F]{6}$/.test(normalized) ? normalized : fallback;
}

function colorLuminance(hex: string) {
  const channels = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrastRatio(left: string, right: string) {
  const a = colorLuminance(left);
  const b = colorLuminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function officeAlignment(value: unknown) {
  const normalized = String(value || 'left').trim().toLowerCase();
  if (normalized === 'justify' || normalized === 'block') return 'BLOCK';
  if (normalized === 'center') return 'CENTER';
  if (normalized === 'right') return 'RIGHT';
  return 'LEFT';
}

function columnWeight(value: unknown) {
  if (typeof value === 'string' && /^\d+(?:\.\d+)?%$/.test(value.trim())) {
    return Math.max(0.01, Number.parseFloat(value) / 100);
  }
  return Math.max(0.01, finiteNumber(value, 1));
}

export function resolveOfficeTheme(theme?: OfficeThemePreset | OfficeThemeDefinition): ResolvedOfficeTheme {
  const definition = typeof theme === 'string' ? { preset: theme } : theme || {};
  const preset = definition.preset && definition.preset in THEME_PRESETS ? definition.preset : 'clean';
  const base = THEME_PRESETS[preset];
  const colors = definition.colors || {};
  const typography = definition.typography || {};
  return {
    version: '1',
    preset,
    colors: {
      primary: normalizeHex(colors.primary, base.colors.primary),
      secondary: normalizeHex(colors.secondary, base.colors.secondary),
      accent: normalizeHex(colors.accent, base.colors.accent),
      background: normalizeHex(colors.background, base.colors.background),
      surface: normalizeHex(colors.surface, base.colors.surface),
      text: normalizeHex(colors.text, base.colors.text),
      muted: normalizeHex(colors.muted, base.colors.muted),
      border: normalizeHex(colors.border, base.colors.border),
    },
    fonts: {
      heading: String(definition.fonts?.heading || base.fonts.heading),
      body: String(definition.fonts?.body || base.fonts.body),
      mono: String(definition.fonts?.mono || base.fonts.mono),
    },
    typography: {
      title: clamp(finiteNumber(typography.title, base.typography.title), 20, 54),
      heading: clamp(finiteNumber(typography.heading, base.typography.heading), 14, 36),
      body: clamp(finiteNumber(typography.body, base.typography.body), 9, 24),
      caption: clamp(finiteNumber(typography.caption, base.typography.caption), 7, 16),
      metric: clamp(finiteNumber(typography.metric, base.typography.metric), 18, 54),
    },
  };
}

export function resolveOfficeLayoutPolicy(
  documentType: OfficeDocumentKind,
  layout?: OfficeLayoutPolicy,
): ResolvedOfficeLayoutPolicy {
  const presentation = documentType === 'presentation';
  const spreadsheet = documentType === 'spreadsheet';
  return {
    enabled: layout?.enabled !== false,
    imageFit: 'contain',
    maxCharactersPerSlide: clamp(finiteNumber(layout?.maxCharactersPerSlide, presentation ? 520 : 4_000), 120, 20_000),
    maxContentUnitsPerSlide: clamp(finiteNumber(layout?.maxContentUnitsPerSlide, presentation ? 5.4 : 20), 1, 100),
    maxListItemsPerSlide: Math.round(clamp(finiteNumber(layout?.maxListItemsPerSlide, presentation ? 7 : 30), 3, 100)),
    maxTableColumns: Math.round(clamp(finiteNumber(layout?.maxTableColumns, spreadsheet ? 24 : presentation ? 6 : 12), 2, 64)),
    maxTableRowsPerSlide: Math.round(clamp(finiteNumber(layout?.maxTableRowsPerSlide, spreadsheet ? 200 : presentation ? 8 : 40), 2, 5_000)),
    minPresentationBodyFontSize: clamp(finiteNumber(layout?.minPresentationBodyFontSize, 16), 12, 28),
    minSpreadsheetFontSize: clamp(finiteNumber(layout?.minSpreadsheetFontSize, 10), 8, 18),
    minWordBodyFontSize: clamp(finiteNumber(layout?.minWordBodyFontSize, 10.5), 9, 18),
    mode: layout?.mode === 'strict' ? 'strict' : 'repair',
    overflow: layout?.overflow === 'error' || layout?.overflow === 'shrink' ? layout.overflow : 'split',
    safeMargin: clamp(finiteNumber(layout?.safeMargin, presentation ? 0.65 : 0.75), 0.35, 1.5),
  };
}

function blockChildren(block: OfficeBlock) {
  return [
    ...(Array.isArray(block.children) ? block.children : []),
    ...(Array.isArray(block.columns)
      ? block.columns.flatMap((column) => Array.isArray(column.blocks) ? column.blocks : [])
      : []),
  ];
}

function timelineItemText(item: unknown) {
  if (item && typeof item === 'object') {
    const record = item as Record<string, unknown>;
    return [firstNonEmptyString(record.title, record.label), firstNonEmptyString(record.body, record.detail, record.text, record.value)]
      .filter(Boolean)
      .join(' ');
  }
  return String(item ?? '');
}

function blockText(block: OfficeBlock): string {
  if (block.type === 'table' && Array.isArray(block.rows)) {
    return [block.title, block.rows.flat().map((cell) => String(cell ?? '')).join(' ')].filter(Boolean).join(' ');
  }
  if (block.type === 'list' && Array.isArray(block.items)) {
    return [block.title, block.items.map(itemText).join(' ')].filter(Boolean).join(' ');
  }
  if (block.type === 'timeline' && Array.isArray(block.items)) {
    return [block.title, block.items.map(timelineItemText).join(' ')].filter(Boolean).join(' ');
  }
  return [block.title, block.text, block.markdown, block.caption, ...blockChildren(block).map(blockText)]
    .filter(Boolean).join(' ').trim();
}

function continuedTitle(title: string | undefined, language: string | undefined) {
  if (!title) return undefined;
  const suffix = /^zh(?:-|$)/i.test(language || '') ? '（续）' : ' · Continued';
  const available = Math.max(20, 140 - weightedCharacters(suffix));
  const prefix = weightedCharacters(title) > available ? splitText(title, available)[0] : title;
  return `${prefix}${suffix}`;
}

function splitText(value: string, limit: number) {
  const chunks: string[] = [];
  let remaining = value.trim();
  while (weightedCharacters(remaining) > limit) {
    let weight = 0;
    let sliceEnd = 0;
    for (const character of remaining) {
      const nextWeight = weight + (/[^\u0000-\u00ff]/.test(character) ? 2 : 1);
      if (nextWeight > limit) break;
      weight = nextWeight;
      sliceEnd += character.length;
    }
    sliceEnd = Math.max(1, sliceEnd);
    const window = remaining.slice(0, sliceEnd);
    const minimumBoundary = Math.floor(sliceEnd * 0.55);
    const candidates = [window.lastIndexOf('\n'), window.lastIndexOf('。'), window.lastIndexOf('；'), window.lastIndexOf('. '), window.lastIndexOf('; '), window.lastIndexOf(' ')];
    const boundary = Math.max(...candidates.filter((position) => position >= minimumBoundary));
    const splitAt = boundary > 0 ? boundary + 1 : sliceEnd;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function contentUnits(block: OfficeBlock): number {
  if (block.type === 'image' || block.type === 'chart') return 2.5;
  if (block.type === 'table') return Math.max(1.2, ((block.rows?.length || 1) * (block.rows?.[0]?.length || 1)) / 18);
  if (block.type === 'columns') return Math.max(1.5, ...((block.columns || []).map((column) =>
    (column.blocks || []).reduce((sum, child) => sum + contentUnits(child), 0))));
  if (block.type === 'metric' || block.type === 'card' || block.type === 'timeline') return 1.1;
  if (block.type === 'heading') return 0.7;
  if (block.type === 'divider' || block.type === 'spacer') return 0.25;
  return Math.max(0.6, weightedCharacters(blockText(block)) / 180);
}

function contentCharacters(block: OfficeBlock): number {
  if (block.type === 'columns') {
    return Math.max(0, ...((block.columns || []).map((column) =>
      (column.blocks || []).reduce((sum, child) => sum + contentCharacters(child), 0))));
  }
  return weightedCharacters(blockText(block));
}

function groupPresentationBlocks(blocks: OfficeBlock[], context: NormalizationContext) {
  const groups: OfficeBlock[][] = [];
  let current: OfficeBlock[] = [];
  let units = 0;
  let characters = 0;
  for (const block of blocks) {
    const nextUnits = contentUnits(block);
    const nextCharacters = contentCharacters(block);
    if (current.length && (
      units + nextUnits > context.layout.maxContentUnitsPerSlide
      || characters + nextCharacters > context.layout.maxCharactersPerSlide
    )) {
      groups.push(current);
      current = [];
      units = 0;
      characters = 0;
    }
    current.push(block);
    units += nextUnits;
    characters += nextCharacters;
  }
  if (current.length) groups.push(current);
  return groups;
}

function inferredTemplate(page: OfficeBlock, index: number): OfficeSemanticTemplate {
  if (page.template) return page.template;
  const children = page.children || [];
  const soleChild = children[0];
  const coverContent = !soleChild
    || (['heading', 'quote', 'text'].includes(soleChild.type) && weightedCharacters(blockText(soleChild)) <= 240);
  if (index === 0 && children.length <= 1 && coverContent && (page.title || soleChild?.type === 'heading')) return 'cover';
  if (children.filter((block) => block.type === 'metric').length >= 2) return 'kpi';
  if (children.some((block) => block.type === 'columns')) return 'two-column';
  if (children.some((block) => block.type === 'chart')) return 'chart';
  if (children.some((block) => block.type === 'image')) return 'image';
  return 'content';
}

type NormalizationContext = {
  blockCount: number;
  blockLimitReported: boolean;
  defaultStyle?: OfficeBlockStyle;
  diagnostics: OfficeLayoutDiagnostic[];
  documentType: OfficeDocumentKind;
  ids: Map<string, number>;
  language?: string;
  layout: ResolvedOfficeLayoutPolicy;
};

function pushDiagnostic(context: NormalizationContext, diagnostic: OfficeLayoutDiagnostic) {
  if (context.layout.mode === 'strict' && diagnostic.repaired) {
    context.diagnostics.push({
      ...diagnostic,
      severity: 'error',
      repaired: false,
      message: `${diagnostic.message} Strict layout mode requires the input to satisfy this rule without automatic repair.`,
    });
    return;
  }
  context.diagnostics.push(diagnostic);
}

function reserveSyntheticId(context: NormalizationContext, base: string) {
  const normalized = truncateUnicode(base, MAX_SEMANTIC_ELEMENT_ID_LENGTH);
  let id = normalized;
  let suffix = 2;
  while (context.ids.has(id)) {
    const ending = `-${suffix}`;
    id = `${truncateUnicode(normalized, MAX_SEMANTIC_ELEMENT_ID_LENGTH - ending.length)}${ending}`;
    suffix += 1;
  }
  context.ids.set(id, 1);
  return id;
}

function normalizedSemanticId(value: unknown, fallback: string) {
  const normalized = String(value ?? '')
    .trim()
    .replace(/[\u0000-\u0020\u007f]+/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '');
  return truncateUnicode(normalized || fallback, MAX_SEMANTIC_ELEMENT_ID_LENGTH);
}

function semanticPayloadPresent(value: unknown) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function semanticScalar(value: unknown) {
  return value === null || typeof value === 'boolean' || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value));
}

function allowedSemanticStyleFields(documentType: OfficeDocumentKind, blockType: string) {
  if (documentType === 'presentation') {
    if (['code', 'heading', 'list', 'quote', 'text'].includes(blockType)) {
      return new Set(['align', 'color', 'fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'lineHeight']);
    }
    if (blockType === 'table') return new Set(['fontSize']);
    if (blockType === 'shape') return new Set(['backgroundColor', 'borderColor']);
    return new Set<string>();
  }
  if (documentType === 'word') {
    if (blockType === 'heading') return new Set(['align', 'color', 'fontFamily', 'fontSize']);
    if (['code', 'quote', 'text'].includes(blockType)) {
      return new Set(['align', 'color', 'fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'lineHeight']);
    }
    if (blockType === 'list') return new Set(['color', 'fontFamily', 'fontSize']);
    if (['card', 'metric', 'table', 'timeline'].includes(blockType)) return new Set(['fontSize']);
    if (blockType === 'image') return new Set(['align']);
    return new Set<string>();
  }
  if (blockType === 'table') return new Set(['fontSize']);
  return new Set<string>();
}

function validSemanticStyleValue(field: string, value: unknown) {
  if (field === 'align') return ['center', 'justify', 'left', 'right'].includes(String(value));
  if (field === 'fontStyle') return ['italic', 'normal'].includes(String(value));
  if (field === 'color' || field === 'backgroundColor' || field === 'borderColor') {
    return typeof value === 'string' && /^#?[0-9a-f]{6}$/i.test(value.trim());
  }
  if (field === 'fontFamily') return typeof value === 'string' && Boolean(value.trim());
  if (field === 'fontSize' || field === 'lineHeight') return typeof value === 'number' && Number.isFinite(value) && value > 0;
  if (field === 'fontWeight') {
    return typeof value === 'number' && Number.isFinite(value)
      || typeof value === 'string' && (/^(?:bold|normal)$/i.test(value.trim()) || /^\d{1,4}$/.test(value.trim()));
  }
  return false;
}

function normalizeBlock(blockInput: OfficeSemanticBlockInput, path: string, context: NormalizationContext, depth = 0): OfficeBlock {
  const source = blockInput && typeof blockInput === 'object' ? blockInput : ({ type: 'text', text: String(blockInput ?? '') } as OfficeBlock);
  const type = String(source.type || 'text');
  const fallbackId = `${type}-${path.replace(/[^A-Za-z0-9_-]+/g, '-')}`;
  const requestedId = source.id === undefined ? fallbackId : String(source.id);
  const proposedId = normalizedSemanticId(requestedId, fallbackId);
  const sanitized = source.id !== undefined && requestedId !== proposedId;
  const duplicate = context.ids.has(proposedId);
  const id = reserveSyntheticId(context, proposedId);
  if (source.id === undefined || sanitized || duplicate) {
    pushDiagnostic(context, {
      code: duplicate ? 'SEMANTIC_DUPLICATE_ID_REPAIRED' : sanitized ? 'SEMANTIC_ID_REPAIRED' : 'SEMANTIC_ID_ASSIGNED',
      severity: duplicate || sanitized ? 'warning' : 'info',
      blockId: id,
      repaired: true,
      message: duplicate
        ? `Duplicate block id ${proposedId} was renamed to ${id}.`
        : sanitized
          ? `Block id ${requestedId} was normalized to the facade-safe id ${id}.`
        : `A deterministic id (${id}) was assigned to a block.`,
    });
  }
  const { children: _sourceChildren, columns: _sourceColumns, ...sourceWithoutNestedBlocks } = source;
  const block: OfficeBlock = {
    ...sourceWithoutNestedBlocks,
    id,
    type: KNOWN_BLOCK_TYPES.has(type) ? type : 'text',
    style: context.defaultStyle || source.style ? { ...(context.defaultStyle || {}), ...(source.style || {}) } : undefined,
  };
  context.blockCount += 1;
  if (context.blockCount > 1_000) {
    if (!context.blockLimitReported) {
      context.blockLimitReported = true;
      pushDiagnostic(context, {
        code: 'SEMANTIC_BLOCK_LIMIT_EXCEEDED', severity: 'error', blockId: id,
        message: 'Semantic documents may contain at most 1,000 nested blocks.',
      });
    }
    block.children = undefined;
    block.columns = undefined;
    return block;
  }
  if (!KNOWN_BLOCK_TYPES.has(type)) {
    pushDiagnostic(context, {
      code: 'SEMANTIC_UNKNOWN_BLOCK_TYPE', severity: 'error', blockId: id,
      message: `Unknown block type ${type}; choose a supported semantic block so structured content is not silently discarded.`,
    });
  }
  if (!source.type && (source.rows || source.items || source.source || source.data || source.children || source.columns || source.svg)) {
    pushDiagnostic(context, {
      code: 'SEMANTIC_BLOCK_TYPE_REQUIRED', severity: 'error', blockId: id,
      message: 'Structured semantic blocks require an explicit type; the compiler will not guess and risk dropping content.',
    });
  }
  const unsupported = context.documentType === 'presentation'
    ? new Set(['pageBreak', 'svg'])
    : context.documentType === 'word'
      ? new Set(['shape', 'svg'])
      : new Set(['pageBreak', 'shape', 'svg']);
  if (unsupported.has(block.type)) {
    pushDiagnostic(context, {
      code: 'SEMANTIC_BLOCK_UNSUPPORTED', severity: 'error', blockId: id,
      message: `${block.type} is not supported by the ${context.documentType} semantic renderer; use a supported semantic block or the raw Office API.`,
    });
  }
  if (depth > 0 && (block.type === 'page' || block.type === 'sheet')) {
    pushDiagnostic(context, {
      code: 'SEMANTIC_NESTED_ROOT_CONTAINER', severity: 'error', blockId: id,
      message: `${block.type} is a root container and cannot be nested inside another semantic block.`,
    });
  }
  const hasNestedBlocks = Boolean(source.children?.length || source.columns?.some((column) => column.blocks?.length));
  if (depth >= 8 && hasNestedBlocks) {
    pushDiagnostic(context, {
      code: 'SEMANTIC_NESTING_LIMIT_EXCEEDED', severity: 'error', blockId: id,
      message: 'Semantic block nesting may not exceed eight levels.',
    });
    block.children = undefined;
    block.columns = undefined;
  } else if (Array.isArray(source.children)) {
    block.children = source.children.map((child, index) => normalizeBlock(child, `${path}-${index + 1}`, context, depth + 1));
  }
  if (depth < 8 && Array.isArray(source.columns)) {
    block.columns = source.columns.slice(0, 4).map((column, columnIndex) => ({
      ...column,
      blocks: (column.blocks || []).map((child, childIndex) => normalizeBlock(child, `${path}-c${columnIndex + 1}-${childIndex + 1}`, context, depth + 1)),
    }));
    if (source.columns.length > 4) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_COLUMNS_CAPPED', severity: 'warning', blockId: id, repaired: true,
        message: 'A columns block was capped at four columns to preserve readable width.',
      });
    }
  }
  if (block.type === 'page' || block.type === 'sheet') {
    const payload = [
      block.type === 'sheet' ? source.subtitle : undefined,
      source.text,
      source.markdown,
    ].map((value) => String(value ?? '').trim()).filter((value, index, values) => value && values.indexOf(value) === index);
    if (block.type === 'page' && !block.title && String(source.name || '').trim()) {
      block.title = String(source.name).trim();
      pushDiagnostic(context, {
        code: 'SEMANTIC_PAGE_NAME_PROMOTED', severity: 'info', blockId: id, repaired: true,
        message: 'A page name was promoted to its visible title.',
      });
    }
    if (block.type === 'page' && block.title && String(source.name || '').trim()
      && String(block.title).trim() !== String(source.name).trim()
    ) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_PAGE_TITLE_AMBIGUOUS', severity: 'error', blockId: id,
        message: 'Page title and name differ; keep one title so no page label is ignored.',
      });
    }
    if (payload.length) {
      const childId = reserveSyntheticId(context, `${id}-body`);
      block.children = [{ id: childId, type: 'text', text: payload.join('\n\n') }, ...(block.children || [])];
      delete block.text;
      delete block.markdown;
      if (block.type === 'sheet') delete block.subtitle;
      pushDiagnostic(context, {
        code: 'SEMANTIC_CONTAINER_TEXT_PRESERVED', severity: 'info', blockId: id, repaired: true,
        message: `${block.type} text was moved into an editable child block so it remains visible.`,
      });
    }
    if (block.template) {
      const requestedTemplate = block.template;
      const presentationTemplates = new Set(['chart', 'comparison', 'content', 'cover', 'image', 'kpi', 'section', 'two-column']);
      const resolvedTemplate = context.documentType === 'presentation'
        ? presentationTemplates.has(requestedTemplate) ? requestedTemplate : 'content'
        : context.documentType === 'word'
          ? requestedTemplate === 'cover' ? 'cover' : 'report'
          : 'worksheet';
      if (resolvedTemplate !== requestedTemplate) {
        block.template = resolvedTemplate;
        pushDiagnostic(context, {
          code: 'SEMANTIC_TEMPLATE_NORMALIZED', severity: 'info', blockId: id, repaired: true,
          message: `${requestedTemplate} maps to the ${resolvedTemplate} template for ${context.documentType}.`,
        });
      }
    }
    if (context.documentType === 'presentation' && block.template === 'kpi'
      && !block.children?.every((child) => child.type === 'card' || child.type === 'metric')
    ) {
      block.template = 'content';
      pushDiagnostic(context, {
        code: 'SEMANTIC_KPI_TEMPLATE_REPAIRED', severity: 'warning', blockId: id, repaired: true,
        message: 'KPI template requires only card or metric children; it was changed to the content template.',
      });
    }
    if (context.documentType === 'presentation' && (block.template === 'chart' || block.template === 'image')
      && !block.children?.some((child) => child.type === block.template)
    ) {
      const requestedTemplate = block.template;
      block.template = 'content';
      pushDiagnostic(context, {
        code: 'SEMANTIC_FOCUS_TEMPLATE_REPAIRED', severity: 'warning', blockId: id, repaired: true,
        message: `${requestedTemplate} template requires a matching ${requestedTemplate} child; it was changed to the content template.`,
      });
    }
  }
  const ownTextFields = [source.title, source.text, source.markdown]
    .map((value) => String(value ?? '').trim())
    .filter((value, index, values) => value && values.indexOf(value) === index);
  if (['code', 'heading', 'quote', 'text'].includes(block.type) && ownTextFields.length > 1) {
    pushDiagnostic(context, {
      code: 'SEMANTIC_TEXT_FIELDS_AMBIGUOUS', severity: 'error', blockId: id,
      message: `${block.type} accepts one of title, text, or markdown; use a separate heading block when multiple visible text regions are needed.`,
    });
  }
  if (['code', 'heading', 'quote', 'text'].includes(block.type) && ownTextFields.length === 0) {
    pushDiagnostic(context, {
      code: 'SEMANTIC_TEXT_CONTENT_MISSING', severity: 'error', blockId: id,
      message: `${block.type} requires non-empty title, text, or markdown content.`,
    });
  }
  if ((block.type === 'card' || block.type === 'metric') && String(source.name || '').trim()) {
    const name = String(source.name).trim();
    if (block.title && String(block.title).trim() !== name) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_CARD_TITLE_AMBIGUOUS', severity: 'error', blockId: id,
        message: `${block.type} cannot use different title and name values; keep one visible label.`,
      });
    } else if (!block.title) {
      block.title = name;
      pushDiagnostic(context, {
        code: 'SEMANTIC_CARD_NAME_PROMOTED', severity: 'info', blockId: id, repaired: true,
        message: `${block.type} name was promoted to its visible title.`,
      });
    }
  }
  if (block.type === 'card' || block.type === 'metric') {
    const data = source.data && typeof source.data === 'object' ? source.data as Record<string, unknown> : {};
    if (source.data !== undefined && (!source.data || typeof source.data !== 'object' || Array.isArray(source.data))) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_CARD_DATA_INVALID', severity: 'error', blockId: id,
        message: `${block.type} data must be an object containing only label and value.`,
      });
    }
    const unknownDataFields = Object.keys(data).filter((field) => !['label', 'value'].includes(field));
    if (unknownDataFields.length) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_CARD_DATA_FIELDS_UNKNOWN', severity: 'error', blockId: id,
        message: `${block.type} data contains unsupported fields: ${unknownDataFields.join(', ')}. Use label/value or visible child blocks.`,
      });
    }
    if (Object.entries(data).some(([field, value]) => ['label', 'value'].includes(field) && !semanticScalar(value))) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_CARD_DATA_VALUE_INVALID', severity: 'error', blockId: id,
        message: `${block.type} label and value must be scalar text, number, boolean, or null values.`,
      });
    }
    const label = String(data.label ?? '').trim();
    if (label && block.title && label !== String(block.title).trim()) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_CARD_LABEL_AMBIGUOUS', severity: 'error', blockId: id,
        message: `${block.type} data.label and title/name disagree; keep one visible label.`,
      });
    }
  }
  const allowedPayload = ALLOWED_SEMANTIC_PAYLOAD_FIELDS[block.type];
  if (allowedPayload) {
    const unsupportedFields = SEMANTIC_PAYLOAD_FIELDS.filter((field) =>
      !allowedPayload.has(field) && semanticPayloadPresent(source[field]));
    if (unsupportedFields.length) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_BLOCK_FIELDS_UNSUPPORTED', severity: 'error', blockId: id,
        message: `${block.type} does not render ${unsupportedFields.join(', ')}; move that content into a compatible sibling block.`,
      });
    }
  }
  const unknownFields = Object.keys(source).filter((field) => !KNOWN_SEMANTIC_BLOCK_FIELDS.has(field));
  if (unknownFields.length) {
    pushDiagnostic(context, {
      code: 'SEMANTIC_BLOCK_FIELDS_UNKNOWN', severity: 'error', blockId: id,
      message: `${block.type} contains unknown semantic fields: ${unknownFields.join(', ')}. Use the raw Office program path for facade-specific options.`,
    });
  }
  if (source.breakBefore === 'page' && context.documentType !== 'word') {
    pushDiagnostic(context, {
      code: 'SEMANTIC_PAGE_BREAK_UNSUPPORTED', severity: 'error', blockId: id,
      message: 'breakBefore is supported only by Writer semantic flow; use explicit page blocks for presentations and sheets for spreadsheets.',
    });
  }
  if ((block.type === 'heading' || block.type === 'list') && block.level !== undefined) {
    const requestedLevel = Number(block.level);
    const minimum = block.type === 'heading' ? 1 : 0;
    const maximum = block.type === 'heading' ? 4 : 8;
    const repairedLevel = Math.round(clamp(finiteNumber(requestedLevel, minimum), minimum, maximum));
    if (!Number.isFinite(requestedLevel) || repairedLevel !== requestedLevel) {
      block.level = repairedLevel;
      pushDiagnostic(context, {
        code: 'SEMANTIC_LEVEL_CLAMPED', severity: 'warning', blockId: id, repaired: true,
        message: `${block.type} level was clamped to the supported ${minimum}-${maximum} range.`,
      });
    }
  }
  if (['list', 'table', 'timeline'].includes(block.type) && block.title && weightedCharacters(block.title) > 140) {
    pushDiagnostic(context, {
      code: 'SEMANTIC_STRUCTURED_TITLE_TOO_LONG', severity: 'error', blockId: id,
      message: `${block.type} title exceeds the readable title slot; shorten it and move detail into a sibling text block.`,
    });
  }
  if (block.type === 'columns' && (!block.columns?.length || block.columns.every((column) => !column.blocks?.length))) {
    pushDiagnostic(context, {
      code: 'SEMANTIC_COLUMNS_EMPTY', severity: 'error', blockId: id,
      message: 'Columns requires at least one column containing a semantic block.',
    });
  }
  if (block.type === 'chart' && !source.source && String(source.caption || '').trim()) {
    pushDiagnostic(context, {
      code: 'SEMANTIC_CHART_TEXT_UNSUPPORTED', severity: 'error', blockId: id,
      message: 'Native charts support title and axis labels; put a caption in a sibling text block.',
    });
  }
  if (block.children?.length && !['card', 'page', 'sheet'].includes(block.type)) {
    pushDiagnostic(context, {
      code: 'SEMANTIC_CHILDREN_UNSUPPORTED', severity: 'error', blockId: id,
      message: `${block.type} cannot contain children; use page, sheet, columns, or a text-only card container.`,
    });
  }
  if (block.type === 'card' && block.children?.some((child) =>
    child.type !== 'text' || Boolean(child.style) || child.breakBefore === 'page'
  )) {
    pushDiagnostic(context, {
      code: 'SEMANTIC_CARD_CHILD_UNSUPPORTED', severity: 'error', blockId: id,
      message: 'Card children are flattened into its body and therefore must be unstyled text blocks; use sibling blocks when headings, lists, quotes, code, or page breaks must retain their role.',
    });
  }
  if (block.columns?.length && block.type !== 'columns') {
    pushDiagnostic(context, {
      code: 'SEMANTIC_COLUMNS_CONTAINER_REQUIRED', severity: 'error', blockId: id,
      message: 'The columns property is valid only on a columns block.',
    });
  }
  const style = { ...(block.style || {}) };
  const semanticOwnedStyleFields = [
    'borderRadius', 'borderWidth', 'gap', 'height', 'margin', 'opacity', 'padding',
    'rotation', 'shadow', 'unit', 'width', 'x', 'y',
  ].filter((field) => style[field] !== undefined);
  if (semanticOwnedStyleFields.length) {
    if (context.layout.enabled) {
      semanticOwnedStyleFields.forEach((field) => delete style[field]);
      pushDiagnostic(context, {
        code: 'SEMANTIC_LAYOUT_STYLE_REMOVED', severity: 'warning', blockId: id, repaired: true,
        message: `Semantic templates own ${semanticOwnedStyleFields.join(', ')}; those manual layout values were removed before reflow.`,
      });
    } else {
      pushDiagnostic(context, {
        code: 'SEMANTIC_LAYOUT_STYLE_UNSUPPORTED', severity: 'error', blockId: id,
        message: `Semantic templates do not render manual ${semanticOwnedStyleFields.join(', ')} values; use the raw Office program path for absolute layout.`,
      });
    }
  }
  const allowedStyle = allowedSemanticStyleFields(context.documentType, block.type);
  const unsupportedStyleFields = Object.keys(style).filter((field) => !allowedStyle.has(field));
  if (unsupportedStyleFields.length) {
    if (context.layout.enabled) {
      unsupportedStyleFields.forEach((field) => delete style[field]);
      pushDiagnostic(context, {
        code: 'SEMANTIC_STYLE_FIELDS_REMOVED', severity: 'warning', blockId: id, repaired: true,
        message: `${block.type} does not expose semantic style ${unsupportedStyleFields.join(', ')} for ${context.documentType}; those values were removed.`,
      });
    } else {
      pushDiagnostic(context, {
        code: 'SEMANTIC_STYLE_FIELDS_UNSUPPORTED', severity: 'error', blockId: id,
        message: `${block.type} does not expose semantic style ${unsupportedStyleFields.join(', ')} for ${context.documentType}; use the raw Office program path.`,
      });
    }
  }
  const invalidStyleFields = Object.entries(style)
    .filter(([field, value]) => allowedStyle.has(field) && !validSemanticStyleValue(field, value))
    .map(([field]) => field);
  if (invalidStyleFields.length) {
    if (context.layout.enabled) invalidStyleFields.forEach((field) => delete style[field]);
    pushDiagnostic(context, context.layout.enabled ? {
      code: 'SEMANTIC_STYLE_VALUES_REPAIRED', severity: 'warning', blockId: id, repaired: true,
      message: `${block.type} contains invalid semantic style values for ${invalidStyleFields.join(', ')}; theme defaults will be used.`,
    } : {
      code: 'SEMANTIC_STYLE_VALUES_INVALID', severity: 'error', blockId: id,
      message: `${block.type} contains invalid semantic style values for ${invalidStyleFields.join(', ')}.`,
    });
  }
  if (context.layout.enabled) {
    const requestedFontSize = Number(style.fontSize);
    const minimum = context.documentType === 'presentation'
      ? block.type === 'heading' ? Math.max(20, context.layout.minPresentationBodyFontSize)
        : ['table', 'timeline'].includes(block.type) ? 10
          : block.type === 'code' ? 12
            : context.layout.minPresentationBodyFontSize
      : context.documentType === 'word' ? context.layout.minWordBodyFontSize : context.layout.minSpreadsheetFontSize;
    const maximum = context.documentType === 'presentation'
      ? block.type === 'heading' ? 54 : ['table', 'timeline'].includes(block.type) ? 18 : 32
      : context.documentType === 'word' ? block.type === 'heading' ? 48 : 24 : 24;
    if (style.fontSize !== undefined && !Number.isFinite(requestedFontSize)) {
      delete style.fontSize;
      pushDiagnostic(context, {
        code: 'SEMANTIC_FONT_SIZE_REPAIRED', severity: 'warning', blockId: id, repaired: true,
        message: 'A non-numeric font size was removed so the theme default can be applied.',
      });
    } else if (Number.isFinite(requestedFontSize)
      && (requestedFontSize < minimum || requestedFontSize > maximum)
    ) {
      style.fontSize = clamp(requestedFontSize, minimum, maximum);
      pushDiagnostic(context, {
        code: 'SEMANTIC_FONT_SIZE_CLAMPED', severity: 'warning', blockId: id, repaired: true,
        message: `Font size ${requestedFontSize}pt was clamped to the readable ${minimum}-${maximum}pt range.`,
      });
    }
  }
  block.style = Object.keys(style).length ? style : undefined;
  if (block.type === 'image') {
    const requestedFit = block.fit === 'cover' ? 'cover' : 'contain';
    block.fit = 'contain';
    if (requestedFit === 'cover') {
      pushDiagnostic(context, {
        code: 'SEMANTIC_IMAGE_COVER_REPAIRED', severity: 'warning', blockId: id, repaired: true,
        message: 'Semantic image cover mode was changed to contain because the installed Office facade cannot crop-to-fill without distortion.',
      });
    }
    block.source = String(block.source || '').trim();
    if (!block.source) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_IMAGE_SOURCE_MISSING', severity: 'error', blockId: id,
        message: 'An image block requires source with an exact workspace asset name.',
      });
    }
    if (!String(block.alt || block.caption || '').trim()) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_IMAGE_DESCRIPTION_MISSING', severity: 'warning', blockId: id,
        message: 'Image has no alt text or caption; add one when the image communicates meaning.',
      });
    }
  }
  if (block.type === 'table') {
    if (!Array.isArray(block.rows) || !block.rows.length) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_TABLE_ROWS_MISSING', severity: 'error', blockId: id,
        message: 'A table block requires at least one row.',
      });
    } else {
      const columnCount = Math.max(0, ...block.rows.map((row) => row.length));
      const cellCount = block.rows.reduce((total, row) => total + row.length, 0);
      if (cellCount > MAX_SEMANTIC_TABLE_CELLS[context.documentType]) {
        pushDiagnostic(context, {
          code: 'SEMANTIC_TABLE_CELL_LIMIT_EXCEEDED', severity: 'error', blockId: id,
          message: `Table contains ${cellCount.toLocaleString('en-US')} cells; the ${context.documentType} semantic limit is ${MAX_SEMANTIC_TABLE_CELLS[context.documentType].toLocaleString('en-US')} to keep generation and validation responsive.`,
        });
      }
      if (!columnCount) {
        pushDiagnostic(context, {
          code: 'SEMANTIC_TABLE_COLUMNS_MISSING', severity: 'error', blockId: id,
          message: 'A table block requires at least one column.',
        });
      } else if (block.rows.some((row) => row.length !== columnCount)) {
        block.rows = block.rows.map((row) => [
          ...row,
          ...Array.from({ length: columnCount - row.length }, () => null),
        ]);
        pushDiagnostic(context, {
          code: 'SEMANTIC_TABLE_ROWS_PADDED', severity: 'warning', blockId: id, repaired: true,
          message: `Ragged table rows were padded to ${columnCount} columns so native Office tables remain valid.`,
        });
      }
      if (context.documentType !== 'presentation' && columnCount > context.layout.maxTableColumns) {
        pushDiagnostic(context, {
          code: 'SEMANTIC_TABLE_WIDE', severity: 'warning', blockId: id,
          message: context.documentType === 'word'
            ? `${columnCount}-column table exceeds the preferred ${context.layout.maxTableColumns}-column reading width; Writer will use landscape when page orientation is not explicitly set.`
            : `${columnCount}-column table exceeds the preferred ${context.layout.maxTableColumns}-column reading width; Calc will preserve all columns and use the configured print orientation.`,
        });
      }
    }
  }
  if (block.type === 'list') {
    const items = Array.isArray(block.items) ? block.items.filter((item) => itemText(item).trim()) : [];
    if (items.length !== (block.items?.length || 0)) {
      block.items = items;
      pushDiagnostic(context, {
        code: 'SEMANTIC_EMPTY_LIST_ITEMS_REMOVED', severity: 'warning', blockId: id, repaired: true,
        message: 'Empty list items were removed before layout.',
      });
    }
    if (!items.length) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_LIST_ITEMS_MISSING', severity: 'error', blockId: id,
        message: 'A list block requires at least one non-empty item.',
      });
    }
    const unknownItemFields = items.flatMap((item) => item && typeof item === 'object' && !Array.isArray(item)
      ? Object.keys(item as Record<string, unknown>).filter((field) => !['label', 'text', 'title', 'value'].includes(field))
      : []);
    if (unknownItemFields.length) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_LIST_ITEM_FIELDS_UNKNOWN', severity: 'error', blockId: id,
        message: `List items contain unsupported fields: ${[...new Set(unknownItemFields)].join(', ')}. Use a text/title/label/value field or a plain value.`,
      });
    }
    if (items.some((item) => Array.isArray(item) || (item && typeof item === 'object'
      && Object.values(item as Record<string, unknown>).some((value) => !semanticScalar(value))
    ))) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_LIST_ITEM_VALUE_INVALID', severity: 'error', blockId: id,
        message: 'List item values must be scalar text, number, boolean, or null values.',
      });
    }
  }
  if (block.type === 'timeline') {
    if (!Array.isArray(block.items) || !block.items.length) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_TIMELINE_ITEMS_MISSING', severity: 'error', blockId: id,
        message: 'A timeline block requires at least one event.',
      });
    } else {
      for (const item of block.items) {
        if (!item || typeof item !== 'object') continue;
        const record = item as Record<string, unknown>;
        if (Array.isArray(item) || Object.values(record).some((value) => !semanticScalar(value))) {
          pushDiagnostic(context, {
            code: 'SEMANTIC_TIMELINE_ITEM_VALUE_INVALID', severity: 'error', blockId: id,
            message: 'Timeline event title/detail aliases must be scalar text, number, boolean, or null values.',
          });
          break;
        }
        const unknownFields = Object.keys(record).filter((field) =>
          !['body', 'detail', 'label', 'text', 'title', 'value'].includes(field));
        if (unknownFields.length) {
          pushDiagnostic(context, {
            code: 'SEMANTIC_TIMELINE_ITEM_FIELDS_UNKNOWN', severity: 'error', blockId: id,
            message: `Timeline events contain unsupported fields: ${unknownFields.join(', ')}. Put dates or status in the visible title/detail text.`,
          });
          break;
        }
        const labels = [record.title, record.label].map((value) => String(value ?? '').trim()).filter(Boolean);
        const details = [record.body, record.detail, record.text, record.value].map((value) => String(value ?? '').trim()).filter(Boolean);
        if (new Set(labels).size > 1 || new Set(details).size > 1) {
          pushDiagnostic(context, {
            code: 'SEMANTIC_TIMELINE_ITEM_AMBIGUOUS', severity: 'error', blockId: id,
            message: 'Timeline event aliases disagree; keep one of title/label and one of body/detail/text/value.',
          });
          break;
        }
      }
    }
  }
  if (block.type === 'chart') {
    if (typeof block.source === 'string') block.source = block.source.trim();
    let data = block.data && typeof block.data === 'object' ? block.data as Record<string, unknown> : {};
    const unknownChartFields = Object.keys(data).filter((field) => ![
      'categories', 'chartType', 'labels', 'series', 'showLegend', 'xAxisTitle', 'yAxisTitle',
    ].includes(field));
    if (unknownChartFields.length) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_CHART_DATA_FIELDS_UNKNOWN', severity: 'error', blockId: id,
        message: `Chart data contains unsupported fields: ${unknownChartFields.join(', ')}. Use the raw Office program path for advanced chart options.`,
      });
    }
    const seriesItems = Array.isArray(data.series) ? data.series : [];
    const validSeries = seriesItems.length > 0;
    const categoryValues = Array.isArray(data.categories) ? data.categories : [];
    const labelValues = Array.isArray(data.labels) ? data.labels : [];
    if ((data.categories !== undefined && !Array.isArray(data.categories))
      || (data.labels !== undefined && !Array.isArray(data.labels))
    ) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_CHART_CATEGORIES_INVALID', severity: 'error', blockId: id,
        message: 'Chart data.categories and data.labels must be arrays when supplied.',
      });
    }
    if ([...categoryValues, ...labelValues].some((value) => !semanticScalar(value))) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_CHART_CATEGORY_VALUE_INVALID', severity: 'error', blockId: id,
        message: 'Chart categories and labels must contain only scalar values.',
      });
    }
    if (data.showLegend !== undefined && typeof data.showLegend !== 'boolean') {
      pushDiagnostic(context, {
        code: 'SEMANTIC_CHART_LEGEND_VALUE_INVALID', severity: 'error', blockId: id,
        message: 'Chart showLegend must be a boolean.',
      });
    }
    if (['chartType', 'xAxisTitle', 'yAxisTitle'].some((field) =>
      data[field] !== undefined && !semanticScalar(data[field])
    )) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_CHART_LABEL_VALUE_INVALID', severity: 'error', blockId: id,
        message: 'Chart type and axis titles must be scalar values.',
      });
    }
    if (categoryValues.length && labelValues.length && JSON.stringify(categoryValues) !== JSON.stringify(labelValues)) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_CHART_CATEGORIES_AMBIGUOUS', severity: 'error', blockId: id,
        message: 'Chart data.categories and data.labels disagree; keep one category array.',
      });
    }
    if (seriesItems.some((item) => {
      const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const name = String(record.name ?? '').trim();
      const label = String(record.label ?? '').trim();
      return name && label && name !== label;
    })) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_CHART_SERIES_NAME_AMBIGUOUS', severity: 'error', blockId: id,
        message: 'A chart series name and label disagree; keep one series label.',
      });
    }
    const unknownSeriesFields = seriesItems.flatMap((item) => item && typeof item === 'object' && !Array.isArray(item)
      ? Object.keys(item as Record<string, unknown>).filter((field) => !['label', 'name', 'values'].includes(field))
      : []);
    if (unknownSeriesFields.length) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_CHART_SERIES_FIELDS_UNKNOWN', severity: 'error', blockId: id,
        message: `Chart series contain unsupported fields: ${[...new Set(unknownSeriesFields)].join(', ')}. Use name/label and values only.`,
      });
    }
    if (seriesItems.some((item) => !item || typeof item !== 'object' || Array.isArray(item)
      || Object.entries(item as Record<string, unknown>).some(([field, value]) =>
        ['label', 'name'].includes(field) ? !semanticScalar(value)
          : field === 'values' ? !Array.isArray(value) || value.some((entry) => !semanticScalar(entry))
            : false)
    )) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_CHART_SERIES_VALUE_INVALID', severity: 'error', blockId: id,
        message: 'Each chart series must be an object with scalar name/label values and a scalar values array.',
      });
    }
    if (block.source && (block.data !== undefined || block.chartType !== undefined)) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_CHART_SOURCE_DATA_AMBIGUOUS', severity: 'error', blockId: id,
        message: 'Image-based charts cannot also use data or chartType; keep one representation so native chart options are not ignored.',
      });
    }
    if (data.chartType !== undefined && block.chartType !== undefined
      && String(data.chartType).trim().toLowerCase() !== String(block.chartType).trim().toLowerCase()
    ) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_CHART_TYPE_AMBIGUOUS', severity: 'error', blockId: id,
        message: 'Chart data.chartType and chartType disagree; keep one chart type.',
      });
    }
    if (!validSeries && !block.source) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_CHART_DATA_MISSING', severity: 'error', blockId: id,
        message: 'A chart block requires data.series or an image source.',
      });
    } else if (validSeries && !block.source) {
      const categories = Array.isArray(data.categories) && data.categories.length
        ? data.categories
        : Array.isArray(data.labels) ? data.labels : [];
      if (categories.length > MAX_SEMANTIC_CHART_CATEGORIES[context.documentType]
        || seriesItems.length > MAX_SEMANTIC_CHART_SERIES[context.documentType]
      ) {
        pushDiagnostic(context, {
          code: 'SEMANTIC_CHART_DENSITY_LIMIT_EXCEEDED', severity: 'error', blockId: id,
          message: `Chart has ${categories.length} categories and ${seriesItems.length} series; the ${context.documentType} semantic limits are ${MAX_SEMANTIC_CHART_CATEGORIES[context.documentType]} categories and ${MAX_SEMANTIC_CHART_SERIES[context.documentType]} series. Summarize the chart or use a table for the full data.`,
        });
      }
      const invalidSeries = seriesItems.some((item) => {
        const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
        return !Array.isArray(record.values) || record.values.length !== categories.length;
      });
      if (!categories.length || invalidSeries) {
        pushDiagnostic(context, {
          code: 'SEMANTIC_CHART_SERIES_INVALID', severity: 'error', blockId: id,
          message: 'Chart categories must be non-empty and every series.values array must have the same length.',
        });
      }
      const invalidNumbers = seriesItems.some((item) => {
        const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
        return Array.isArray(record.values) && record.values.some((value) => !Number.isFinite(Number(value)));
      });
      if (invalidNumbers) {
        data = {
          ...data,
          series: seriesItems.map((item) => {
            const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
            return {
              ...record,
              values: Array.isArray(record.values) ? record.values.map((value) => finiteNumber(value, 0)) : [],
            };
          }),
        };
        block.data = data;
        pushDiagnostic(context, {
          code: 'SEMANTIC_CHART_VALUES_REPAIRED', severity: 'warning', blockId: id, repaired: true,
          message: 'Non-numeric chart values were replaced with zero so the native chart remains valid.',
        });
      }
    }
    if (validSeries && context.documentType !== 'word') {
      const presentationTypes = new Set([
        'area', 'bar', 'bubble', 'column', 'donut', 'doughnut', 'filled-net',
        'filled-radar', 'line', 'net', 'pie', 'radar', 'scatter', 'stock', 'xy',
      ]);
      const spreadsheetTypes = new Set(['area', 'bar', 'column', 'line', 'pie', 'scatter']);
      const requested = firstNonEmptyString(data.chartType, block.chartType, 'column').toLowerCase().replace(/_/g, '-');
      const allowed = context.documentType === 'presentation' ? presentationTypes : spreadsheetTypes;
      const canonical = context.documentType === 'spreadsheet' && requested === 'xy' ? 'scatter' : requested;
      if (!allowed.has(canonical)) {
        block.data = { ...data, chartType: 'column' };
        block.chartType = 'column';
        pushDiagnostic(context, {
          code: 'SEMANTIC_CHART_TYPE_REPAIRED', severity: 'warning', blockId: id, repaired: true,
          message: `Chart type ${requested || '(empty)'} is not supported for ${context.documentType}; it was changed to column.`,
        });
      } else {
        block.data = { ...data, chartType: canonical };
        block.chartType = canonical;
      }
    }
    if (context.documentType === 'word' && validSeries && !block.source) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_CHART_RENDERED_AS_DATA_TABLE', severity: 'warning', blockId: id, repaired: true,
        message: 'Word semantic generation renders chart series as an accessible data table; provide a chart image or use the raw Office API when a visual chart is required.',
      });
    }
    if (context.documentType === 'spreadsheet' && (data.xAxisTitle || data.yAxisTitle)) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_SPREADSHEET_AXIS_TITLES_OMITTED', severity: 'warning', blockId: id, repaired: true,
        message: 'The current native Calc facade does not expose chart axis titles; those labels were omitted.',
      });
    }
    if (context.documentType === 'word' && !block.source && (data.xAxisTitle || data.yAxisTitle)) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_WRITER_AXIS_TITLES_OMITTED', severity: 'warning', blockId: id, repaired: true,
        message: 'Writer semantic charts render as accessible data tables, so axis titles were omitted.',
      });
    }
    if (context.documentType === 'word' && !block.source && block.alt) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_WRITER_CHART_ALT_OMITTED', severity: 'warning', blockId: id, repaired: true,
        message: 'Writer semantic charts render as accessible data tables, so separate chart alt text is unnecessary and was omitted.',
      });
    }
  }
  if (block.type === 'shape' && context.documentType === 'presentation') {
    const allowed = new Set([
      'caption', 'circle', 'diamond', 'ellipse', 'hexagon', 'line', 'measure', 'octagon',
      'parallelogram', 'pentagon', 'rectangle', 'right-triangle', 'round-rectangle',
      'rounded-rectangle', 'star', 'trapezoid', 'triangle',
    ]);
    const requested = String(block.shapeType || 'rectangle').trim().toLowerCase().replace(/_/g, '-');
    if (!allowed.has(requested)) {
      block.shapeType = 'rectangle';
      pushDiagnostic(context, {
        code: 'SEMANTIC_SHAPE_TYPE_REPAIRED', severity: 'warning', blockId: id, repaired: true,
        message: `Unsupported shape type ${requested || '(empty)'} was changed to rectangle.`,
      });
    } else {
      block.shapeType = requested;
    }
  }
  if (block.type === 'columns' && context.documentType === 'word') {
    pushDiagnostic(context, {
      code: 'SEMANTIC_WRITER_COLUMNS_LINEARIZED', severity: 'info', blockId: id, repaired: true,
      message: 'Writer column content uses native reading order and was linearized for safe pagination.',
    });
  }
  if (block.type === 'columns' && context.documentType === 'spreadsheet') {
    pushDiagnostic(context, {
      code: 'SEMANTIC_SPREADSHEET_COLUMNS_LINEARIZED', severity: 'info', blockId: id, repaired: true,
      message: 'Spreadsheet column groups were linearized in reading order to keep cells editable and printable.',
    });
  }
  return block;
}

function splitTableColumns(block: OfficeBlock, context: NormalizationContext) {
  const rows = block.rows || [];
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (width <= context.layout.maxTableColumns) return [block];
  if (context.layout.overflow !== 'split') {
    pushDiagnostic(context, {
      code: 'SEMANTIC_TABLE_TOO_WIDE', severity: context.layout.overflow === 'error' ? 'error' : 'warning', blockId: block.id,
      message: `Table has ${width} columns; the configured readable limit is ${context.layout.maxTableColumns}.`,
    });
    return [block];
  }
  const chunks: OfficeBlock[] = [];
  const payloadWidth = Math.max(1, context.layout.maxTableColumns - 1);
  for (let start = 1, part = 1; start < width; start += payloadWidth, part += 1) {
    chunks.push({
      ...block,
      id: reserveSyntheticId(context, `${block.id}-columns-${part}`),
      rows: rows.map((row) => [row[0] ?? null, ...row.slice(start, start + payloadWidth)]),
    });
  }
  pushDiagnostic(context, {
    code: 'SEMANTIC_TABLE_COLUMNS_SPLIT', severity: 'warning', blockId: block.id, repaired: true,
    message: `A ${width}-column table was split into ${chunks.length} readable column groups with the first column repeated.`,
  });
  return chunks;
}

function splitPresentationBlock(block: OfficeBlock, context: NormalizationContext): OfficeBlock[] {
  if (!context.layout.enabled) return [block];
  const textTooLong = ['code', 'heading', 'quote', 'text'].includes(block.type)
    && contentCharacters(block) > context.layout.maxCharactersPerSlide;
  const listTooLong = block.type === 'list' && (
    (block.items?.length || 0) > context.layout.maxListItemsPerSlide
    || contentCharacters(block) > context.layout.maxCharactersPerSlide
  );
  const timelineTooLong = block.type === 'timeline' && (
    (block.items?.length || 0) > 6
    || contentCharacters(block) > context.layout.maxCharactersPerSlide
  );
  const tableTooLarge = block.type === 'table' && (
    (block.rows?.length || 0) > context.layout.maxTableRowsPerSlide
    || Math.max(0, ...(block.rows || []).map((row) => row.length)) > context.layout.maxTableColumns
  );
  const violatesBlockLimit = textTooLong || listTooLong || timelineTooLong || tableTooLarge;
  if (violatesBlockLimit && context.layout.overflow !== 'split') {
    pushDiagnostic(context, {
      code: context.layout.overflow === 'error' ? 'SEMANTIC_BLOCK_OVERFLOW' : 'SEMANTIC_BLOCK_SHRINK',
      severity: context.layout.overflow === 'error' ? 'error' : 'warning',
      blockId: block.id,
      message: context.layout.overflow === 'error'
        ? `${block.type} exceeds its configured slide limit and overflow=error forbids automatic repair.`
        : `${block.type} exceeds its preferred slide limit and will rely on native fitting down to the configured minimum font size.`,
    });
    return [block];
  }
  if (context.layout.overflow !== 'split') return [block];
  if (block.type === 'text' || block.type === 'quote' || block.type === 'code' || block.type === 'heading') {
    const key = block.markdown !== undefined ? 'markdown' : block.text !== undefined ? 'text' : 'title';
    const value = String(block[key] || '');
    if (weightedCharacters(value) <= context.layout.maxCharactersPerSlide) return [block];
    const chunks = splitText(value, context.layout.maxCharactersPerSlide);
    if (chunks.length > MAX_SEMANTIC_PRESENTATION_PAGES) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_SPLIT_EXPLOSION', severity: 'error', blockId: block.id,
        message: `Splitting this ${block.type} would create ${chunks.length} parts; reduce the content or use a Word document.`,
      });
      return [block];
    }
    pushDiagnostic(context, {
      code: 'SEMANTIC_TEXT_SPLIT', severity: 'warning', blockId: block.id, repaired: true,
      message: `A long ${block.type} block was split into ${chunks.length} continuation blocks.`,
    });
    return chunks.map((text, index) => index === 0 ? { ...block, [key]: text } : {
      ...block,
      id: reserveSyntheticId(context, `${block.id}-part-${index + 1}`),
      type: block.type === 'heading' ? 'text' : block.type,
      title: block.type === 'heading' ? undefined : block.title,
      text: block.type === 'heading' ? text : block.text,
      [key]: text,
    });
  }
  if (block.type === 'list' && listTooLong) {
    const expandedItems = (block.items || []).flatMap((item) => {
      const value = itemText(item);
      return weightedCharacters(value) > context.layout.maxCharactersPerSlide
        ? splitText(value, context.layout.maxCharactersPerSlide)
        : [item];
    });
    const chunks: OfficeBlock[] = [];
    let current: unknown[] = [];
    let characters = 0;
    for (const item of expandedItems) {
      const length = weightedCharacters(itemText(item));
      if (current.length && (
        current.length >= context.layout.maxListItemsPerSlide
        || characters + length > context.layout.maxCharactersPerSlide
      )) {
        chunks.push({
          ...block,
          id: chunks.length ? reserveSyntheticId(context, `${block.id}-part-${chunks.length + 1}`) : block.id,
          items: current,
        });
        current = [];
        characters = 0;
      }
      current.push(item);
      characters += length;
    }
    if (current.length) {
      chunks.push({
        ...block,
        id: chunks.length ? reserveSyntheticId(context, `${block.id}-part-${chunks.length + 1}`) : block.id,
        items: current,
      });
    }
    pushDiagnostic(context, {
      code: 'SEMANTIC_LIST_SPLIT', severity: 'warning', blockId: block.id, repaired: true,
      message: `A long list was split into ${chunks.length} readable continuation blocks.`,
    });
    return chunks;
  }
  if (block.type === 'timeline' && timelineTooLong) {
    const expandedItems = (block.items || []).flatMap((item) => {
      if (!item || typeof item !== 'object') return [item];
      const record = item as Record<string, unknown>;
      const title = firstNonEmptyString(record.title, record.label);
      const body = firstNonEmptyString(record.body, record.detail, record.text, record.value);
      if (weightedCharacters(title) + weightedCharacters(body) <= context.layout.maxCharactersPerSlide) return [item];
      if (!body) {
        return splitText(title, context.layout.maxCharactersPerSlide).map((part) => ({
          ...record,
          title: part,
          body: '',
        }));
      }
      if (weightedCharacters(title) >= context.layout.maxCharactersPerSlide - 80) {
        const titleParts = splitText(title, Math.max(80, context.layout.maxCharactersPerSlide - 80));
        const bodyParts = splitText(body, context.layout.maxCharactersPerSlide);
        return [
          ...titleParts.map((part) => ({ ...record, title: part, body: '' })),
          ...bodyParts.map((part, index) => ({
            ...record,
            title: continuedTitle(titleParts.at(-1), context.language) || `Detail ${index + 1}`,
            body: part,
          })),
        ];
      }
      const available = Math.max(80, context.layout.maxCharactersPerSlide - weightedCharacters(title));
      return splitText(body, available).map((part, index) => ({
        ...record,
        title: index ? continuedTitle(title, context.language) || title : title,
        body: part,
      }));
    });
    const chunks: OfficeBlock[] = [];
    let current: unknown[] = [];
    let characters = 0;
    for (const item of expandedItems) {
      const length = weightedCharacters(timelineItemText(item));
      if (current.length && (current.length >= 6 || characters + length > context.layout.maxCharactersPerSlide)) {
        chunks.push({
          ...block,
          id: chunks.length ? reserveSyntheticId(context, `${block.id}-part-${chunks.length + 1}`) : block.id,
          items: current,
        });
        current = [];
        characters = 0;
      }
      current.push(item);
      characters += length;
    }
    if (current.length) chunks.push({
      ...block,
      id: chunks.length ? reserveSyntheticId(context, `${block.id}-part-${chunks.length + 1}`) : block.id,
      items: current,
    });
    pushDiagnostic(context, {
      code: 'SEMANTIC_TIMELINE_SPLIT', severity: 'warning', blockId: block.id, repaired: true,
      message: `A long timeline was split into ${chunks.length} readable continuation blocks.`,
    });
    return chunks;
  }
  if (block.type === 'table') {
    const rows = block.rows || [];
    const width = Math.max(0, ...rows.map((row) => row.length));
    const columnParts = width <= context.layout.maxTableColumns
      ? 1
      : Math.ceil(Math.max(1, width - 1) / Math.max(1, context.layout.maxTableColumns - 1));
    const rowParts = rows.length <= context.layout.maxTableRowsPerSlide
      ? 1
      : Math.ceil(Math.max(1, rows.length - 1) / Math.max(1, context.layout.maxTableRowsPerSlide - 1));
    if (columnParts * rowParts > MAX_SEMANTIC_SPLIT_PARTS) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_SPLIT_EXPLOSION', severity: 'error', blockId: block.id,
        message: `Splitting this table would create ${columnParts * rowParts} slide tables; use a spreadsheet or a summarized appendix instead.`,
      });
      return [block];
    }
    return splitTableColumns(block, context).flatMap((columnBlock) => {
      const rows = columnBlock.rows || [];
      if (rows.length <= context.layout.maxTableRowsPerSlide) return [columnBlock];
      const header = rows[0];
      const chunks: OfficeBlock[] = [];
      const payloadRows = Math.max(1, context.layout.maxTableRowsPerSlide - 1);
      for (let index = 1; index < rows.length; index += payloadRows) {
        chunks.push({
          ...columnBlock,
          id: reserveSyntheticId(context, `${columnBlock.id}-rows-${chunks.length + 1}`),
          rows: [header, ...rows.slice(index, index + payloadRows)],
        });
      }
      pushDiagnostic(context, {
        code: 'SEMANTIC_TABLE_ROWS_SPLIT', severity: 'warning', blockId: columnBlock.id, repaired: true,
        message: `A long table was split into ${chunks.length} slide-sized parts with its header repeated.`,
      });
      return chunks;
    });
  }
  if (block.type === 'columns') {
    const columns = (block.columns || []).map((column) => ({
      ...column,
      blocks: (column.blocks || []).flatMap((child) => splitPresentationBlock(child, context)),
    }));
    const grouped = columns.map((column) => groupPresentationBlocks(column.blocks || [], context));
    const partCount = Math.max(1, ...grouped.map((groups) => groups.length));
    if (partCount > MAX_SEMANTIC_PRESENTATION_PAGES) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_SPLIT_EXPLOSION', severity: 'error', blockId: block.id,
        message: `Splitting this columns block would create ${partCount} parts; reduce the content or use a Word document.`,
      });
      return [block];
    }
    if (partCount === 1) return [{ ...block, columns }];
    pushDiagnostic(context, {
      code: 'SEMANTIC_COLUMNS_SPLIT', severity: 'warning', blockId: block.id, repaired: true,
      message: `Dense column content was reflowed into ${partCount} continuation blocks.`,
    });
    return Array.from({ length: partCount }, (_, index) => ({
      ...block,
      id: index ? reserveSyntheticId(context, `${block.id}-part-${index + 1}`) : block.id,
      columns: columns.map((column, columnIndex) => ({ ...column, blocks: grouped[columnIndex]?.[index] || [] })),
    }));
  }
  return [block];
}

function normalizePresentationPages(blocks: OfficeBlock[], context: NormalizationContext) {
  const pageBlocks = blocks.some((block) => block.type === 'page')
    ? blocks.filter((block) => block.type === 'page')
    : [{ id: 'page-1', type: 'page', title: undefined, children: blocks } as OfficeBlock];
  const pages: OfficeBlock[] = [];
  for (const [pageIndex, page] of pageBlocks.entries()) {
    const template = inferredTemplate(page, pageIndex);
    let title = page.title;
    let subtitle = page.subtitle;
    let subtitleElementId: string | undefined;
    let expanded = (page.children || []).flatMap((block) => splitPresentationBlock(block, context));
    let titleOverflowBlocks: OfficeBlock[] = [];
    let subtitleOverflowBlocks: OfficeBlock[] = [];
    if ((template === 'cover' || template === 'section') && !title && expanded[0]?.type === 'heading') {
      title = ownBlockText(expanded[0]);
      expanded = expanded.slice(1);
      pushDiagnostic(context, {
        code: 'SEMANTIC_COVER_TITLE_PROMOTED', severity: 'info', pageId: page.id, repaired: true,
        message: 'The first heading was promoted to the cover title.',
      });
    }
    if ((template === 'cover' || template === 'section') && !subtitle
      && expanded[0] && ['heading', 'quote', 'text'].includes(expanded[0].type)) {
      subtitle = ownBlockText(expanded[0]);
      subtitleElementId = expanded[0].id;
      expanded = expanded.slice(1);
      pushDiagnostic(context, {
        code: 'SEMANTIC_COVER_SUBTITLE_PROMOTED', severity: 'info', pageId: page.id, repaired: true,
        message: 'The first short text block was promoted to the cover subtitle.',
      });
    }
    if (context.layout.enabled && title && weightedCharacters(title) > 140) {
      const chunks = splitText(title, 140);
      if (context.layout.overflow === 'error') {
        pushDiagnostic(context, {
          code: 'SEMANTIC_PAGE_TITLE_OVERFLOW', severity: 'error', pageId: page.id,
          message: 'Page title exceeds the 140-character title-slot limit and overflow=error forbids reflow.',
        });
      } else {
        title = chunks[0];
        titleOverflowBlocks = chunks.slice(1).map((text, index) => ({
            id: reserveSyntheticId(context, `${page.id}-title-detail-${index + 1}`),
            type: 'text' as const,
            text,
          }));
        pushDiagnostic(context, {
          code: 'SEMANTIC_PAGE_TITLE_REFLOWED', severity: 'warning', pageId: page.id, repaired: true,
          message: 'A long page title was shortened to the title slot and its remaining text moved into editable body content.',
        });
      }
    }
    if (context.layout.enabled && subtitle && weightedCharacters(subtitle) > 260 && (template === 'cover' || template === 'section')) {
      const chunks = splitText(subtitle, 260);
      if (context.layout.overflow === 'error') {
        pushDiagnostic(context, {
          code: 'SEMANTIC_PAGE_SUBTITLE_OVERFLOW', severity: 'error', pageId: page.id,
          message: 'Cover subtitle exceeds the 260-character subtitle-slot limit and overflow=error forbids reflow.',
        });
      } else {
        subtitle = chunks[0];
        subtitleOverflowBlocks = chunks.slice(1).map((text, index) => ({
            id: reserveSyntheticId(context, `${page.id}-subtitle-detail-${index + 1}`),
            type: 'text' as const,
            text,
          }));
        pushDiagnostic(context, {
          code: 'SEMANTIC_PAGE_SUBTITLE_REFLOWED', severity: 'warning', pageId: page.id, repaired: true,
          message: 'A long cover subtitle was shortened to the subtitle slot and its remaining text moved to a continuation slide.',
        });
      }
    }
    expanded = [...titleOverflowBlocks, ...subtitleOverflowBlocks, ...expanded];
    if ((template === 'cover' || template === 'section') && subtitle && !subtitleElementId) {
      subtitleElementId = reserveSyntheticId(context, `${page.id}-subtitle`);
    }
    if (subtitle && template !== 'cover' && template !== 'section') {
      const subtitleBlock: OfficeBlock = {
        id: reserveSyntheticId(context, `${page.id}-subtitle`),
        type: 'text',
        text: subtitle,
      };
      expanded.unshift(...splitPresentationBlock(subtitleBlock, context));
      subtitle = undefined;
      pushDiagnostic(context, {
        code: 'SEMANTIC_PAGE_SUBTITLE_MOVED_TO_BODY', severity: 'info', pageId: page.id, repaired: true,
        message: 'A content-page subtitle was moved into the body because that template has no subtitle slot.',
      });
    }
    if (template === 'cover' || template === 'section') {
      const continuation = expanded;
      pages.push({ ...page, title, subtitle, subtitleElementId, template, children: [] });
      if (continuation.length) {
        const groups = context.layout.enabled && context.layout.overflow !== 'error'
          ? groupPresentationBlocks(continuation, context)
          : [continuation];
        groups.forEach((children, groupIndex) => pages.push({
          ...page,
          id: reserveSyntheticId(context, `${page.id}-continued-${groupIndex + 2}`),
          title: continuedTitle(title, context.language),
          template: 'content',
          subtitle: undefined,
          children,
        }));
        const overflowIsError = context.layout.enabled && context.layout.overflow === 'error';
        pushDiagnostic(context, {
          code: 'SEMANTIC_COVER_CONTENT_REFLOWED',
          severity: overflowIsError ? 'error' : 'warning',
          pageId: page.id,
          repaired: !overflowIsError,
          message: `Cover content beyond its title and subtitle was moved to ${groups.length} continuation slide${groups.length === 1 ? '' : 's'}.`,
        });
      }
      continue;
    }
    const totalUnits = expanded.reduce((sum, block) => sum + contentUnits(block), 0);
    const totalCharacters = expanded.reduce((sum, block) => sum + contentCharacters(block), 0);
    const exceedsBudget = totalUnits > context.layout.maxContentUnitsPerSlide
      || totalCharacters > context.layout.maxCharactersPerSlide;
    if (!context.layout.enabled || context.layout.overflow !== 'split' || !exceedsBudget) {
      if (context.layout.enabled && exceedsBudget) {
        pushDiagnostic(context, {
          code: 'SEMANTIC_SLIDE_DENSITY_HIGH',
          severity: context.layout.overflow === 'error' ? 'error' : 'warning',
          pageId: page.id,
          message: `Slide content (${totalUnits.toFixed(1)} units, ${totalCharacters} characters) exceeds the configured ${context.layout.maxContentUnitsPerSlide.toFixed(1)} unit or ${context.layout.maxCharactersPerSlide} character budget.`,
        });
      }
      pages.push({ ...page, title, subtitle, template, children: expanded });
      continue;
    }
    const groups = groupPresentationBlocks(expanded, context);
    for (const [groupIndex, children] of groups.entries()) {
      pages.push({
        ...page,
        id: groupIndex ? reserveSyntheticId(context, `${page.id}-continued-${groupIndex + 1}`) : page.id,
        title: groupIndex ? continuedTitle(title, context.language) : title,
        subtitle,
        template: groupIndex ? 'content' : template,
        children,
      });
    }
    pushDiagnostic(context, {
      code: 'SEMANTIC_SLIDE_SPLIT', severity: 'warning', pageId: page.id, repaired: true,
      message: `A dense slide was automatically reflowed into ${groups.length} slides.`,
    });
  }
  if (pages.length > MAX_SEMANTIC_PRESENTATION_PAGES) {
    pushDiagnostic(context, {
      code: 'SEMANTIC_PAGE_LIMIT_EXCEEDED', severity: 'error',
      message: `Semantic presentation generation is limited to ${MAX_SEMANTIC_PRESENTATION_PAGES} pages; this input expands to ${pages.length}.`,
    });
    return pages.slice(0, MAX_SEMANTIC_PRESENTATION_PAGES);
  }
  return pages;
}

function normalizeWorksheetNames(blocks: OfficeBlock[], context: NormalizationContext) {
  const used = new Set<string>();
  return blocks.map((block, index) => {
    if (block.type !== 'sheet') return block;
    const fallback = `Sheet ${index + 1}`;
    const requested = String(block.name || block.title || fallback);
    const cleaned = requested
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/[\\/?*\[\]:]+/g, ' ')
      .trim()
      .replace(/^'+|'+$/g, '')
      .trim() || fallback;
    const base = [...cleaned].slice(0, 31).join('');
    let name = base;
    let suffixIndex = 2;
    let duplicate = false;
    while (used.has(name.toLocaleLowerCase('en-US'))) {
      duplicate = true;
      const suffix = ` ${suffixIndex}`;
      name = `${[...base].slice(0, Math.max(1, 31 - suffix.length)).join('')}${suffix}`;
      suffixIndex += 1;
    }
    used.add(name.toLocaleLowerCase('en-US'));
    if (name !== requested || duplicate) {
      pushDiagnostic(context, {
        code: duplicate ? 'SEMANTIC_SHEET_NAME_DEDUPLICATED' : 'SEMANTIC_SHEET_NAME_REPAIRED',
        severity: 'warning',
        blockId: block.id,
        repaired: true,
        message: duplicate
          ? `Worksheet name ${requested} was renamed to ${name} to remain unique.`
          : `Worksheet name ${requested} was normalized to the valid name ${name}.`,
      });
    }
    return { ...block, name };
  });
}

function normalizeTopLevelBlocks(blocks: OfficeSemanticBlockInput[], context: NormalizationContext): OfficeBlock[] {
  const normalized = blocks.map((block, index) => normalizeBlock(block, String(index + 1), context));
  if (context.documentType === 'presentation') {
    const roots: OfficeBlock[] = [];
    let loose: OfficeBlock[] = [];
    const flushLoose = () => {
      if (!loose.length) return;
      const id = reserveSyntheticId(context, `page-${roots.length + 1}`);
      roots.push({ id, type: 'page', template: 'content', children: loose });
      loose = [];
      pushDiagnostic(context, {
        code: 'SEMANTIC_ROOT_CONTENT_GROUPED', severity: 'info', pageId: id, repaired: true,
        message: 'Top-level presentation content was grouped into a semantic page without changing its order.',
      });
    };
    for (const block of normalized) {
      const compatible = block.type === 'sheet'
        ? { ...block, type: 'page', template: 'content' as const, title: block.title || block.name }
        : block;
      if (block.type === 'sheet') {
        pushDiagnostic(context, {
          code: 'SEMANTIC_SHEET_CONVERTED_TO_PAGE', severity: 'warning', blockId: block.id, repaired: true,
          message: 'A spreadsheet sheet container was converted to a presentation page so its children are preserved.',
        });
      }
      if (compatible.type === 'page') {
        flushLoose();
        roots.push(compatible);
      } else {
        loose.push(compatible);
      }
    }
    flushLoose();
    return normalizePresentationPages(roots, context);
  }
  if (context.documentType === 'spreadsheet') {
    const roots: OfficeBlock[] = [];
    let loose: OfficeBlock[] = [];
    let summaryIndex = 0;
    const flushLoose = () => {
      if (!loose.length) return;
      summaryIndex += 1;
      const id = reserveSyntheticId(context, `sheet-summary-${summaryIndex}`);
      roots.push({
        id,
        type: 'sheet',
        name: summaryIndex === 1 ? 'Summary' : `Summary ${summaryIndex}`,
        template: 'worksheet',
        children: loose,
      });
      loose = [];
      pushDiagnostic(context, {
        code: 'SEMANTIC_ROOT_CONTENT_GROUPED', severity: 'info', blockId: id, repaired: true,
        message: 'Top-level spreadsheet content was grouped into a worksheet without changing its order.',
      });
    };
    for (const block of normalized) {
      let compatible = block;
      if (block.type === 'page') {
        const subtitle = String(block.subtitle || '').trim();
        compatible = {
          ...block,
          type: 'sheet',
          template: 'worksheet' as const,
          name: block.name || block.title,
          subtitle: undefined,
          children: [
            ...(subtitle ? [{
              id: reserveSyntheticId(context, `${block.id}-subtitle`),
              type: 'text' as const,
              text: subtitle,
            }] : []),
            ...(block.children || []),
          ],
        };
        pushDiagnostic(context, {
          code: 'SEMANTIC_PAGE_CONVERTED_TO_SHEET', severity: 'warning', blockId: block.id, repaired: true,
          message: 'A page container was converted to a worksheet so its children are preserved.',
        });
      }
      if (compatible.type === 'sheet') {
        flushLoose();
        roots.push(compatible);
      } else {
        loose.push(compatible);
      }
    }
    flushLoose();
    return normalizeWorksheetNames(roots, context);
  }
  if (context.documentType === 'word') {
    return normalized.map<OfficeBlock>((block) => {
      if (block.type !== 'sheet') return block;
      pushDiagnostic(context, {
        code: 'SEMANTIC_SHEET_CONVERTED_TO_WORD_SECTION', severity: 'warning', blockId: block.id, repaired: true,
        message: 'A spreadsheet sheet container was converted to a Writer section so its children are preserved.',
      });
      return { ...block, type: 'page', template: 'report', title: block.title || block.name };
    });
  }
  return normalized;
}

function repairThemeContrast(theme: ResolvedOfficeTheme, context: NormalizationContext) {
  const repaired = structuredClone(theme);
  if (contrastRatio(repaired.colors.text, repaired.colors.surface) < 4.5) {
    repaired.colors.text = THEME_PRESETS[repaired.preset].colors.text;
    pushDiagnostic(context, {
      code: 'SEMANTIC_THEME_CONTRAST_REPAIRED', severity: 'warning', repaired: true,
      message: 'Theme surface text color was restored to the preset value to maintain readable contrast.',
    });
  }
  if (contrastRatio('FFFFFF', repaired.colors.primary) < 4.5) {
    repaired.colors.primary = THEME_PRESETS[repaired.preset].colors.primary;
    pushDiagnostic(context, {
      code: 'SEMANTIC_THEME_PRIMARY_REPAIRED', severity: 'warning', repaired: true,
      message: 'Theme primary color was restored to keep cover text readable.',
    });
  }
  return repaired;
}

export function normalizeOfficeSemanticDocument(
  input: OfficeSemanticDocumentInput & Required<Pick<OfficeDocumentSpec, 'documentType' | 'fileName'>>,
) {
  const documentType = input.documentType;
  const layout = resolveOfficeLayoutPolicy(documentType, input.layout);
  const diagnostics: OfficeLayoutDiagnostic[] = [];
  const suppliedSchemaVersion = (input as { schemaVersion?: unknown }).schemaVersion;
  if (suppliedSchemaVersion !== undefined && suppliedSchemaVersion !== OFFICE_SEMANTIC_SCHEMA_VERSION) {
    diagnostics.push({
      code: 'SEMANTIC_SCHEMA_VERSION_UNSUPPORTED', severity: 'error',
      message: `Unsupported semantic schema version ${String(suppliedSchemaVersion)}; expected ${OFFICE_SEMANTIC_SCHEMA_VERSION}.`,
    });
  }
  if (!['presentation', 'spreadsheet', 'word'].includes(String(documentType))) {
    diagnostics.push({
      code: 'SEMANTIC_DOCUMENT_TYPE_INVALID', severity: 'error',
      message: `Unsupported semantic document type ${String(documentType)}.`,
    });
  }
  const context: NormalizationContext = {
    blockCount: 0,
    blockLimitReported: false,
    defaultStyle: input.document?.defaultStyle,
    diagnostics,
    documentType,
    ids: new Map(),
    language: input.document?.language,
    layout,
  };
  let theme = resolveOfficeTheme(input.theme);
  const themeInput = input.theme && typeof input.theme === 'object'
    ? input.theme as OfficeThemeDefinition
    : undefined;
  if (themeInput?.colors) {
    const invalidColors = Object.entries(themeInput.colors)
      .filter(([, value]) => value !== undefined && !/^#?[0-9a-f]{6}$/i.test(String(value).trim()))
      .map(([key]) => key);
    if (invalidColors.length) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_THEME_COLORS_REPAIRED', severity: 'warning', repaired: true,
        message: `Invalid theme colors (${invalidColors.join(', ')}) were restored from the selected preset.`,
      });
    }
  }
  if (themeInput?.fonts) {
    const invalidFonts = Object.entries(themeInput.fonts)
      .filter(([, value]) => value !== undefined && (typeof value !== 'string' || !value.trim()))
      .map(([key]) => key);
    if (invalidFonts.length) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_THEME_FONTS_REPAIRED', severity: 'warning', repaired: true,
        message: `Empty theme fonts (${invalidFonts.join(', ')}) were restored from the selected preset.`,
      });
    }
  }
  if (themeInput?.typography) {
    const adjustedTypography = Object.entries(themeInput.typography)
      .filter(([key, value]) => value !== undefined
        && Number(value) !== theme.typography[key as keyof typeof theme.typography])
      .map(([key]) => key);
    if (adjustedTypography.length) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_THEME_TYPOGRAPHY_REPAIRED', severity: 'warning', repaired: true,
        message: `Theme typography (${adjustedTypography.join(', ')}) was clamped to readable semantic limits.`,
      });
    }
  }
  if (input.layout) {
    const numericLayoutFields = [
      'maxCharactersPerSlide', 'maxContentUnitsPerSlide', 'maxListItemsPerSlide',
      'maxTableColumns', 'maxTableRowsPerSlide', 'minPresentationBodyFontSize',
      'minSpreadsheetFontSize', 'minWordBodyFontSize', 'safeMargin',
    ] as const;
    const adjustedLayout = numericLayoutFields.filter((field) => input.layout?.[field] !== undefined
      && Number(input.layout[field]) !== layout[field]);
    if (adjustedLayout.length) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_LAYOUT_POLICY_REPAIRED', severity: 'warning', repaired: true,
        message: `Layout policy (${adjustedLayout.join(', ')}) was clamped to safe semantic limits.`,
      });
    }
  }
  if (layout.enabled) theme = repairThemeContrast(theme, context);
  const sourceBlocks = Array.isArray(input.blocks) ? input.blocks : [];
  const blocks = normalizeTopLevelBlocks(sourceBlocks, context);
  if (!sourceBlocks.length || !blocks.length) {
    diagnostics.push({
      code: 'SEMANTIC_BLOCKS_EMPTY', severity: 'error',
      message: 'Semantic Office generation requires at least one content block.',
    });
  }
  const document = {
    ...(input.document || {}),
    ...(input.document?.page ? { page: { ...input.document.page } } : {}),
  };
  if (document.metadata && Object.keys(document.metadata).length) {
    delete document.metadata;
    pushDiagnostic(context, {
      code: 'SEMANTIC_DOCUMENT_METADATA_OMITTED', severity: 'warning', repaired: true,
      message: 'Arbitrary document metadata is not exposed by the semantic Office facade and was omitted; title, author, and description remain supported.',
    });
  }
  if (document.page) {
    const supportedPageFields = documentType === 'word'
      ? new Set(['footer', 'header', 'height', 'marginBottom', 'marginLeft', 'marginRight', 'marginTop', 'orientation', 'unit', 'width'])
      : documentType === 'presentation'
        ? new Set(['footer', 'header', 'showPageNumber'])
        : new Set(['orientation']);
    const ignoredPageFields = Object.entries(document.page)
      .filter(([field, value]) => !supportedPageFields.has(field) && semanticPayloadPresent(value))
      .map(([field]) => field);
    if (ignoredPageFields.length) {
      ignoredPageFields.forEach((field) => delete document.page?.[field]);
      pushDiagnostic(context, {
        code: 'SEMANTIC_PAGE_FIELDS_OMITTED', severity: 'warning', repaired: true,
        message: `${documentType} semantic generation does not use page ${ignoredPageFields.join(', ')}; those settings were omitted.`,
      });
    }
  }
  if (documentType === 'word') {
    const page = document.page;
    const unit = page?.unit || 'mm';
    if (page) {
      for (const dimension of ['width', 'height'] as const) {
        const value = page[dimension];
        const resolved = writerLength(value, unit, 0);
        if (value !== undefined && (resolved < 5_000 || resolved > 200_000)) {
          delete page[dimension];
          pushDiagnostic(context, {
            code: 'SEMANTIC_PAGE_DIMENSION_REPAIRED', severity: 'warning', repaired: true,
            message: `Writer page ${dimension} must be between 50 mm and 2,000 mm; the A4 default will be used.`,
          });
        }
      }
      if (layout.enabled) {
        const safeMargin = Math.round(layout.safeMargin * 2_540);
        for (const marginName of ['marginLeft', 'marginRight', 'marginTop', 'marginBottom'] as const) {
          const value = page[marginName];
          if (value === undefined) continue;
          const numeric = Number(value);
          const resolved = writerLength(value, unit, safeMargin);
          const repaired = !Number.isFinite(numeric) || numeric < 0
            ? safeMargin
            : clamp(resolved, safeMargin, 10_000);
          if (repaired !== resolved || !Number.isFinite(numeric) || numeric < 0) {
            page[marginName] = writerValueFromLength(repaired, unit);
            pushDiagnostic(context, {
              code: 'SEMANTIC_PAGE_MARGIN_CLAMPED', severity: 'warning', repaired: true,
              message: `Writer ${marginName} was clamped between the configured safe minimum and the 100 mm semantic maximum.`,
            });
          }
        }
      }
      const wideTable = containsWideTable(blocks, layout.maxTableColumns);
      const autoLandscape = !page.orientation && wideTable;
      const landscape = page.orientation === 'landscape' || autoLandscape;
      let rawWidth = writerLength(page.width, unit, 21_000);
      let rawHeight = writerLength(page.height, unit, 29_700);
      let physicalWidth = landscape && rawWidth < rawHeight ? rawHeight : rawWidth;
      let physicalHeight = landscape && rawWidth < rawHeight ? rawWidth : rawHeight;
      if (page.orientation === 'portrait' && rawWidth > rawHeight) {
        [physicalWidth, physicalHeight] = [rawHeight, rawWidth];
      }
      const safeMargin = layout.enabled ? Math.round(layout.safeMargin * 2_540) : 0;
      const resolvedMargin = (value: unknown, fallback: number) => {
        const defaultValue = layout.enabled ? Math.max(safeMargin, fallback) : fallback;
        if (value === undefined || value === null) return defaultValue;
        const resolved = writerLength(value, unit, defaultValue);
        return layout.enabled ? clamp(resolved, safeMargin, 10_000) : resolved;
      };
      const left = resolvedMargin(page.marginLeft, 2_000);
      const right = resolvedMargin(page.marginRight, 2_000);
      const top = resolvedMargin(page.marginTop, 1_800);
      const bottom = resolvedMargin(page.marginBottom, 1_800);
      const requiredWidth = left + right + 2_000;
      const requiredHeight = top + bottom + 2_000;
      if (physicalWidth < requiredWidth || physicalHeight < requiredHeight) {
        if (!layout.enabled) {
          pushDiagnostic(context, {
            code: 'SEMANTIC_PAGE_GEOMETRY_INVALID', severity: 'error',
            message: 'Writer margins leave less than 20 mm of usable width or height; enlarge the page or reduce its margins.',
          });
        } else {
          physicalWidth = Math.max(physicalWidth, requiredWidth);
          physicalHeight = Math.max(physicalHeight, requiredHeight);
          if ((landscape && rawWidth < rawHeight) || (page.orientation === 'portrait' && rawWidth > rawHeight)) {
            [rawWidth, rawHeight] = [physicalHeight, physicalWidth];
          } else {
            [rawWidth, rawHeight] = [physicalWidth, physicalHeight];
          }
          page.width = writerValueFromLength(rawWidth, unit);
          page.height = writerValueFromLength(rawHeight, unit);
          pushDiagnostic(context, {
            code: 'SEMANTIC_PAGE_GEOMETRY_EXPANDED', severity: 'warning', repaired: true,
            message: 'Writer page dimensions were expanded to preserve at least 20 mm of usable content area inside the requested margins.',
          });
        }
      }
    }
    if (layout.enabled && !page?.orientation && containsWideTable(blocks, layout.maxTableColumns)) {
      pushDiagnostic(context, {
        code: 'SEMANTIC_WRITER_LANDSCAPE_SELECTED', severity: 'info', repaired: true,
        message: 'Writer will use landscape orientation because a table exceeds the preferred column count.',
      });
    }
  }
  const normalized: OfficeDocumentSpec = {
    schemaVersion: OFFICE_SEMANTIC_SCHEMA_VERSION,
    fileName: input.fileName,
    documentType,
    document,
    theme,
    layout,
    blocks,
  };
  return { normalized, theme, layout, diagnostics };
}

function pythonString(value: unknown) {
  return JSON.stringify(String(value ?? ''));
}

function pythonJson(value: unknown) {
  return `json.loads(${JSON.stringify(JSON.stringify(value ?? null))})`;
}

function pythonBoolean(value: unknown) {
  return value ? 'True' : 'False';
}

function pythonColor(value: string) {
  return `0x${normalizeHex(value, '000000')}`;
}

function facadeDerivedId(base: string, suffix: string) {
  const ending = `-${suffix}`;
  return `${truncateUnicode(base, MAX_FACADE_CHILD_ID_LENGTH - ending.length)}${ending}`;
}

function sourceUnitSegment(value: unknown, fallback: string) {
  const normalized = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '');
  return (normalized || fallback).slice(0, 72);
}

function ownBlockText(block: OfficeBlock) {
  return firstNonEmptyString(block.markdown, block.text, block.title);
}

function itemText(item: unknown) {
  if (item && typeof item === 'object') {
    const record = item as Record<string, unknown>;
    return [record.text, record.title, record.label, record.value]
      .map((value) => String(value ?? '').trim())
      .filter((value, index, values) => value && values.indexOf(value) === index)
      .join(' — ');
  }
  return String(item ?? '');
}

function timelineRows(block: OfficeBlock) {
  return (block.items || []).map((item) => {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return [
      firstNonEmptyString(record.title, record.label, itemText(item)),
      firstNonEmptyString(record.body, record.detail, record.text, record.value),
    ];
  });
}

function chartData(block: OfficeBlock) {
  const data = block.data && typeof block.data === 'object' ? block.data as Record<string, unknown> : {};
  const categories = Array.isArray(data.categories) && data.categories.length
    ? data.categories
    : Array.isArray(data.labels) ? data.labels : [];
  const series = Array.isArray(data.series) ? data.series.map((item, index) => {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return {
      name: firstNonEmptyString(record.name, record.label, `Series ${index + 1}`),
      values: Array.isArray(record.values) ? record.values.map((value) => finiteNumber(value, 0)) : [],
    };
  }) : [];
  return {
    categories: categories.map((value) => String(value ?? '')),
    series,
    chartType: firstNonEmptyString(data.chartType, block.chartType, 'column').toLowerCase(),
    showLegend: data.showLegend !== false,
    xAxisTitle: firstNonEmptyString(data.xAxisTitle) || undefined,
    yAxisTitle: firstNonEmptyString(data.yAxisTitle) || undefined,
  };
}

function chartRows(block: OfficeBlock) {
  const data = chartData(block);
  return [
    ['Category', ...data.series.map((series) => series.name)],
    ...data.categories.map((category, index) => [category, ...data.series.map((series) => series.values[index] ?? null)]),
  ];
}

function weightedCharacters(value: unknown) {
  return [...String(value ?? '')].reduce((total, character) => total + (/[^\u0000-\u00ff]/.test(character) ? 2 : 1), 0);
}

function tableColumnWeights(rows: unknown[][]) {
  const width = Math.max(1, ...rows.map((row) => row.length));
  return Array.from({ length: width }, (_, column) => clamp(
    Math.max(4, ...rows.slice(0, 200).map((row) => weightedCharacters(row[column]))),
    6,
    36,
  ));
}

function spreadsheetColumnName(index: number) {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

type PythonProgramBuilder = {
  lines: string[];
  variable: number;
};

function pythonLine(builder: PythonProgramBuilder, value: string, indentation = 1) {
  builder.lines.push(`${'    '.repeat(indentation)}${value}`);
}

function pythonVariable(builder: PythonProgramBuilder, prefix: string) {
  builder.variable += 1;
  return `${prefix}_${builder.variable}`;
}

function presentationTextStyle(
  block: OfficeBlock,
  theme: ResolvedOfficeTheme,
  layout: ResolvedOfficeLayoutPolicy,
  options: { muted?: boolean; minimum?: number } = {},
) {
  const style = block.style || {};
  const headingLevel = clamp(Math.round(finiteNumber(block.level, 1)), 1, 4);
  const defaultSize = block.type === 'heading'
    ? Math.max(18, theme.typography.heading - (headingLevel - 1) * 2)
    : Math.max(theme.typography.body, layout.minPresentationBodyFontSize);
  return {
    font_size: Math.max(options.minimum || layout.minPresentationBodyFontSize, finiteNumber(style.fontSize, defaultSize)),
    min_font_size: options.minimum || layout.minPresentationBodyFontSize,
    font_name: String(style.fontFamily || (block.type === 'heading' ? theme.fonts.heading : theme.fonts.body)),
    color: Number.parseInt(normalizeHex(style.color, options.muted ? theme.colors.muted : theme.colors.text), 16),
    bold: style.fontWeight === undefined
      ? block.type === 'heading'
      : String(style.fontWeight).trim().toLowerCase() === 'bold' || finiteNumber(style.fontWeight, 400) >= 600,
    italic: style.fontStyle === undefined ? block.type === 'quote' : style.fontStyle === 'italic',
    align: officeAlignment(style.align),
    valign: 'TOP',
    padding: 0.08,
    line_spacing: clamp(finiteNumber(style.lineHeight, 1.18), 1, 1.8),
  };
}

function emitPresentationBlock(
  builder: PythonProgramBuilder,
  slide: string,
  block: OfficeBlock,
  box: string,
  theme: ResolvedOfficeTheme,
  layout: ResolvedOfficeLayoutPolicy,
) {
  const id = pythonString(block.id);
  const text = ownBlockText(block);
  let contentBox = box;
  if (block.title && ['list', 'table', 'timeline'].includes(block.type)) {
    const titledStack = pythonVariable(builder, 'titled_block');
    pythonLine(builder, `${titledStack} = ${slide}.stack(2, box=${box}, gap=0.1, weights=[0.65, ${Math.max(1, contentUnits(block)).toFixed(2)}])`);
    pythonLine(builder, `${slide}.add_text(${pythonString(facadeDerivedId(block.id, 'title'))}, ${pythonString(block.title)}, box=${titledStack}[0], style=${pythonJson(presentationTextStyle({ ...block, type: 'heading' }, theme, layout, { minimum: Math.max(16, layout.minPresentationBodyFontSize) }))})`);
    contentBox = `${titledStack}[1]`;
  }
  if (block.type === 'heading' || block.type === 'text') {
    pythonLine(builder, `${slide}.add_text(${id}, ${pythonString(text)}, box=${box}, style=${pythonJson(presentationTextStyle(block, theme, layout))})`);
    return;
  }
  if (block.type === 'quote' || block.type === 'code') {
    const style = {
      ...presentationTextStyle(block, theme, layout, { minimum: block.type === 'code' ? 12 : 15 }),
      background: Number.parseInt(theme.colors.surface, 16),
      border: Number.parseInt(block.type === 'quote' ? theme.colors.accent : theme.colors.border, 16),
      font_name: String(block.style?.fontFamily || (block.type === 'code' ? theme.fonts.mono : theme.fonts.body)),
    };
    pythonLine(builder, `${slide}.add_text(${id}, ${pythonString(text)}, box=${box}, style=${pythonJson(style)})`);
    return;
  }
  if (block.type === 'list') {
    const items = (block.items || []).map(itemText).filter(Boolean);
    const level = Math.max(0, Math.round(finiteNumber(block.level, 0)));
    if (block.ordered) {
      const indent = '  '.repeat(level);
      const numbered = items.map((item, index) => `${indent}${index + 1}. ${item}`).join('\n');
      pythonLine(builder, `${slide}.add_text(${id}, ${pythonString(numbered)}, box=${contentBox}, style=${pythonJson(presentationTextStyle(block, theme, layout))})`);
    } else {
      pythonLine(builder, `${slide}.add_bullets(${id}, ${pythonJson(items)}, box=${contentBox}, level=${level}, style=${pythonJson(presentationTextStyle(block, theme, layout))})`);
    }
    return;
  }
  if (block.type === 'metric' || block.type === 'card') {
    const data = block.data && typeof block.data === 'object' ? block.data as Record<string, unknown> : {};
    const title = firstNonEmptyString(block.title, data.label, block.name);
    const body = [block.text, data.value, blockChildren(block).map(blockText).filter(Boolean).join('\n')]
      .map((value) => String(value ?? '').trim())
      .filter((value, index, values) => value && values.indexOf(value) === index)
      .join('\n');
    pythonLine(builder, `${slide}.add_card(${id}, ${pythonString(title)}, ${pythonString(body)}, box=${box}, fill=${pythonColor(theme.colors.surface)}, line=${pythonColor(theme.colors.border)}, accent=${pythonColor(theme.colors.accent)}, title_size=${block.type === 'metric' ? theme.typography.metric : 20}, body_size=${Math.max(13, layout.minPresentationBodyFontSize - 1)}, title_color=${pythonColor(theme.colors.text)}, body_color=${pythonColor(theme.colors.muted)})`);
    return;
  }
  if (block.type === 'table') {
    const rows = block.rows || [];
    const weights = tableColumnWeights(rows);
    pythonLine(builder, `${slide}.add_table(${id}, ${pythonJson(rows)}, box=${contentBox}, header=True, column_weights=${pythonJson(weights)}, header_fill=${pythonColor(theme.colors.primary)}, header_color=0xFFFFFF, body_fill=${pythonColor(theme.colors.background)}, alternate_fill=${pythonColor(theme.colors.surface)}, body_color=${pythonColor(theme.colors.text)}, font_size=${Math.max(10, finiteNumber(block.style?.fontSize, 11))}, font_name=${pythonString(theme.fonts.body)})`);
    return;
  }
  if (block.type === 'image') {
    const contain = block.fit !== 'cover';
    if (block.caption) {
      pythonLine(builder, `${slide}.add_captioned_image(${id}, ${pythonString(block.source)}, ${pythonString(block.caption || block.alt)}, box=${box}, alt_text=${pythonString(block.alt || block.caption)}, title=${pythonString(block.title || block.caption || '')}, contain=${pythonBoolean(contain)}, caption_style=${pythonJson({ font_size: 10, min_font_size: 9, color: Number.parseInt(theme.colors.muted, 16), font_name: theme.fonts.body })})`);
    } else {
      pythonLine(builder, `${slide}.add_image(${id}, ${pythonString(block.source)}, box=${box}, contain=${pythonBoolean(contain)}, alt_text=${pythonString(block.alt || block.title || 'Image')}, title=${pythonString(block.title || '')})`);
    }
    return;
  }
  if (block.type === 'chart') {
    if (block.source) {
      if (block.caption) {
        pythonLine(builder, `${slide}.add_captioned_image(${id}, ${pythonString(block.source)}, ${pythonString(block.caption)}, box=${box}, alt_text=${pythonString(block.alt || block.caption || block.title || 'Chart')}, title=${pythonString(block.title || block.caption || '')}, contain=True, caption_style=${pythonJson({ font_size: 10, min_font_size: 9, color: Number.parseInt(theme.colors.muted, 16), font_name: theme.fonts.body })})`);
      } else {
        pythonLine(builder, `${slide}.add_image(${id}, ${pythonString(block.source)}, box=${box}, contain=True, alt_text=${pythonString(block.alt || block.title || 'Chart')}, title=${pythonString(block.title || '')})`);
      }
      return;
    }
    const data = chartData(block);
    pythonLine(builder, `${slide}.add_chart(${id}, ${pythonString(data.chartType)}, ${pythonJson(data.categories)}, box=${box}, series=${pythonJson(data.series)}, colors=${pythonJson([theme.colors.accent, theme.colors.primary, theme.colors.secondary].map((color) => Number.parseInt(color, 16)))}, font_size=11, show_legend=${pythonBoolean(data.showLegend)}, title=${block.title ? pythonString(block.title) : 'None'}, alt_text=${block.alt ? pythonString(block.alt) : 'None'}, x_axis_title=${data.xAxisTitle ? pythonString(data.xAxisTitle) : 'None'}, y_axis_title=${data.yAxisTitle ? pythonString(data.yAxisTitle) : 'None'}, background=${pythonColor(theme.colors.surface)})`);
    return;
  }
  if (block.type === 'timeline') {
    const events = (block.items || []).map((item) => {
      const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      return {
        title: firstNonEmptyString(record.title, record.label, itemText(item)),
        body: firstNonEmptyString(record.body, record.detail, record.text, record.value),
      };
    });
    pythonLine(builder, `${slide}.add_timeline(${id}, ${pythonJson(events)}, box=${contentBox}, colors=${pythonJson([theme.colors.primary, theme.colors.accent].map((color) => Number.parseInt(color, 16)))}, title_size=14, body_size=10, text_color=${pythonColor(theme.colors.text)}, max_items_per_row=6)`);
    return;
  }
  if (block.type === 'columns') {
    const columns = block.columns || [];
    if (!columns.length) return;
    const grid = pythonVariable(builder, 'columns');
    const weights = columns.map((column) => columnWeight(column.width));
    pythonLine(builder, `${grid} = ${slide}.grid(${columns.length}, 1, box=${box}, gap=0.2, column_weights=${pythonJson(weights)})`);
    columns.forEach((column, columnIndex) => {
      const children = column.blocks || [];
      if (!children.length) return;
      const stack = pythonVariable(builder, 'column_stack');
      pythonLine(builder, `${stack} = ${slide}.stack(${children.length}, box=${grid}[${columnIndex}], gap=0.14, weights=${pythonJson(children.map(contentUnits))})`);
      children.forEach((child, childIndex) => emitPresentationBlock(builder, slide, child, `${stack}[${childIndex}]`, theme, layout));
    });
    return;
  }
  if (block.type === 'divider') {
    const divider = pythonVariable(builder, 'divider_box');
    pythonLine(builder, `${divider} = {**${box}, 'y': ${box}['y'] + (${box}['height'] / 2), 'height': 0.02, 'h': 0.02, '_unit': 'in'}`);
    pythonLine(builder, `${slide}.add_shape(${id}, box=${divider}, shape_type='rectangle', fill=${pythonColor(theme.colors.border)}, line=${pythonColor(theme.colors.border)}, layout_role='decoration', allow_overlap=True)`);
    return;
  }
  if (block.type === 'shape') {
    pythonLine(builder, `${slide}.add_shape(${id}, box=${box}, shape_type=${pythonString(block.shapeType || 'rectangle')}, fill=${pythonColor(String(block.style?.backgroundColor || theme.colors.surface))}, line=${pythonColor(String(block.style?.borderColor || theme.colors.border))})`);
    return;
  }
  if (block.type === 'spacer') return;
  const fallback = text || blockChildren(block).map(blockText).filter(Boolean).join('\n');
  if (fallback) pythonLine(builder, `${slide}.add_text(${id}, ${pythonString(fallback)}, box=${box}, style=${pythonJson(presentationTextStyle(block, theme, layout))})`);
}

function emitPresentationDocument(
  builder: PythonProgramBuilder,
  spec: OfficeDocumentSpec,
  theme: ResolvedOfficeTheme,
  layout: ResolvedOfficeLayoutPolicy,
) {
  pythonLine(builder, `deck = job.presentation('document')`);
  if (spec.document.title || spec.document.author || spec.document.description) {
    pythonLine(builder, `deck.set_doc_info(title=${spec.document.title ? pythonString(spec.document.title) : 'None'}, author=${spec.document.author ? pythonString(spec.document.author) : 'None'}, description=${spec.document.description ? pythonString(spec.document.description) : 'None'})`);
  }
  const pages = spec.blocks.filter((block) => block.type === 'page');
  pages.forEach((page, pageIndex) => {
    builder.lines.push(`    # @webpilot-unit pages/${pageIndex + 1}-${sourceUnitSegment(page.id, 'page')}`);
    (() => {
    const slide = `slide_${pageIndex + 1}`;
    const template = page.template || 'content';
    const layoutName = template === 'cover' ? 'cover'
      : template === 'section' ? 'section'
        : ['two-column', 'comparison', 'chart', 'image'].includes(template) ? 'title-two-column'
          : 'title-content';
    const titleColor = template === 'cover' || template === 'section' ? 'FFFFFF' : theme.colors.text;
    pythonLine(builder, `${slide} = deck.slide(${pythonString(page.id)}, layout=${pythonString(layoutName)}, title=${page.title ? pythonString(page.title) : 'None'}, title_style=${pythonJson({
      font_size: theme.typography.title,
      min_font_size: Math.max(24, layout.minPresentationBodyFontSize),
      font_name: theme.fonts.heading,
      bold: true,
      color: Number.parseInt(titleColor, 16),
      padding: 0,
      valign: 'CENTER',
    })})`);
    if (template === 'cover' || template === 'section') {
      pythonLine(builder, `${slide}.set_background(${pythonColor(theme.colors.primary)})`);
      const subtitle = String(page.subtitle || (page.children?.[0] ? ownBlockText(page.children[0]) : '')).trim();
      if (subtitle) {
        const subtitleId = String(page.subtitleElementId || facadeDerivedId(page.id, 'subtitle'));
        pythonLine(builder, `${slide}.add_text(${pythonString(subtitleId)}, ${pythonString(subtitle)}, slot='subtitle', style=${pythonJson({
          font_size: template === 'cover' ? 19 : 16,
          min_font_size: 14,
          font_name: theme.fonts.body,
          color: Number.parseInt('FFFFFF', 16),
          padding: 0,
          valign: 'TOP',
        })})`);
      }
      return;
    }
    pythonLine(builder, `${slide}.set_background(${pythonColor(theme.colors.background)})`);
    const showPageNumber = spec.document.page?.showPageNumber === true;
    const footer = String(spec.document.page?.footer || '');
    if (footer || showPageNumber) {
      pythonLine(builder, `${slide}.add_footer('footer', left=${pythonString(footer)}, right=${pythonString(showPageNumber ? String(pageIndex + 1).padStart(2, '0') : '')}, accent=${pythonColor(theme.colors.accent)}, color=${pythonColor(theme.colors.muted)})`);
    }
    const header = String(spec.document.page?.header || '');
    if (header) pythonLine(builder, `${slide}.add_header('header', left=${pythonString(header)}, accent=${pythonColor(theme.colors.accent)}, color=${pythonColor(theme.colors.muted)})`);
    const children = page.children || [];
    if (!children.length) return;
    const safe = layout.safeMargin;
    const bodyBox = pythonJson({
      x: safe,
      y: 1.35,
      width: 13.333 - safe * 2,
      height: 7.5 - 1.35 - Math.max(safe, footer || showPageNumber ? 0.8 : safe),
      w: 13.333 - safe * 2,
      h: 7.5 - 1.35 - Math.max(safe, footer || showPageNumber ? 0.8 : safe),
      _unit: 'in',
    });
    if (template === 'kpi' && children.every((block) => block.type === 'metric' || block.type === 'card')) {
      const columns = Math.min(3, Math.max(1, children.length));
      const rows = Math.ceil(children.length / columns);
      const boxes = pythonVariable(builder, 'kpi_boxes');
      pythonLine(builder, `${boxes} = ${slide}.grid(${columns}, ${rows}, box=${bodyBox}, gap=0.22)`);
      children.forEach((block, index) => emitPresentationBlock(builder, slide, block, `${boxes}[${index}]`, theme, layout));
      return;
    }
    if (template === 'two-column' || template === 'comparison') {
      const explicit = children.find((block) => block.type === 'columns');
      if (explicit) {
        if (children.length === 1) {
          emitPresentationBlock(builder, slide, explicit, bodyBox, theme, layout);
        } else {
          const stack = pythonVariable(builder, 'mixed_columns_stack');
          pythonLine(builder, `${stack} = ${slide}.stack(${children.length}, box=${bodyBox}, gap=0.16, weights=${pythonJson(children.map(contentUnits))})`);
          children.forEach((block, index) => emitPresentationBlock(builder, slide, block, `${stack}[${index}]`, theme, layout));
        }
        return;
      }
      const boxes = pythonVariable(builder, 'two_column');
      pythonLine(builder, `${boxes} = ${slide}.grid(2, 1, box=${bodyBox}, gap=0.28)`);
      const midpoint = Math.ceil(children.length / 2);
      [children.slice(0, midpoint), children.slice(midpoint)].forEach((group, column) => {
        if (!group.length) return;
        const stack = pythonVariable(builder, 'two_column_stack');
        pythonLine(builder, `${stack} = ${slide}.stack(${group.length}, box=${boxes}[${column}], gap=0.16, weights=${pythonJson(group.map(contentUnits))})`);
        group.forEach((block, index) => emitPresentationBlock(builder, slide, block, `${stack}[${index}]`, theme, layout));
      });
      return;
    }
    if (template === 'chart' || template === 'image') {
      const primaryType = template;
      const primary = children.find((block) => block.type === primaryType) || children[0];
      const secondary = children.filter((block) => block !== primary);
      const boxes = pythonVariable(builder, 'focus_boxes');
      pythonLine(builder, `${boxes} = ${slide}.grid(2, 1, box=${bodyBox}, gap=0.28, column_weights=[2, 1])`);
      emitPresentationBlock(builder, slide, primary, `${boxes}[0]`, theme, layout);
      if (secondary.length) {
        const stack = pythonVariable(builder, 'focus_stack');
        pythonLine(builder, `${stack} = ${slide}.stack(${secondary.length}, box=${boxes}[1], gap=0.15, weights=${pythonJson(secondary.map(contentUnits))})`);
        secondary.forEach((block, index) => emitPresentationBlock(builder, slide, block, `${stack}[${index}]`, theme, layout));
      }
      return;
    }
    const boxes = pythonVariable(builder, 'content_boxes');
    pythonLine(builder, `${boxes} = ${slide}.stack(${children.length}, box=${bodyBox}, gap=0.16, weights=${pythonJson(children.map(contentUnits))})`);
    children.forEach((block, index) => emitPresentationBlock(builder, slide, block, `${boxes}[${index}]`, theme, layout));
    })();
    builder.lines.push('    # @webpilot-endunit');
  });
  pythonLine(builder, 'deck.save()');
  pythonLine(builder, 'deck.close()');
}

function writerColumnWeights(rows: unknown[][]) {
  return tableColumnWeights(rows).map((value) => Math.max(1, value));
}

function writerLength(value: unknown, unit: unknown, fallback: number) {
  if (!Number.isFinite(Number(value))) return fallback;
  const factors: Record<string, number> = { cm: 1_000, in: 2_540, mm: 100, pt: 2_540 / 72, px: 2_540 / 96 };
  return Math.max(0, Math.round(Number(value) * (factors[String(unit || 'mm').toLowerCase()] || 100)));
}

function writerValueFromLength(value: number, unit: unknown) {
  const factors: Record<string, number> = { cm: 1_000, in: 2_540, mm: 100, pt: 2_540 / 72, px: 2_540 / 96 };
  const resolved = value / (factors[String(unit || 'mm').toLowerCase()] || 100);
  return Number(resolved.toFixed(4));
}

function containsWideTable(blocks: OfficeBlock[], limit: number): boolean {
  return blocks.some((block) => {
    if (block.type === 'table' && Math.max(0, ...(block.rows || []).map((row) => row.length)) > limit) return true;
    return containsWideTable(blockChildren(block), limit);
  });
}

function emitWriterBlock(
  builder: PythonProgramBuilder,
  block: OfficeBlock,
  theme: ResolvedOfficeTheme,
  layout: ResolvedOfficeLayoutPolicy,
) {
  const id = pythonString(block.id);
  const text = ownBlockText(block);
  const fontSize = Math.max(layout.minWordBodyFontSize, finiteNumber(block.style?.fontSize, theme.typography.body));
  const color = pythonColor(String(block.style?.color || theme.colors.text));
  const align = pythonString(officeAlignment(block.style?.align));
  if (block.breakBefore === 'page') {
    pythonLine(builder, `document.add_page_break(${pythonString(facadeDerivedId(block.id, 'break-before'))})`);
  }
  if (block.title && ['chart', 'list', 'table', 'timeline'].includes(block.type)) {
    pythonLine(builder, `document.add_heading(${pythonString(facadeDerivedId(block.id, 'title'))}, ${pythonString(block.title)}, level=2, color=${pythonColor(theme.colors.primary)}, align='LEFT', font_name=${pythonString(theme.fonts.heading)}, font_size=${Math.max(layout.minWordBodyFontSize + 2, theme.typography.heading - 2)})`);
  }
  if (block.type === 'heading') {
    pythonLine(builder, `document.add_heading(${id}, ${pythonString(text)}, level=${clamp(Math.round(finiteNumber(block.level, 1)), 1, 4)}, color=${color}, align=${align}, font_name=${pythonString(block.style?.fontFamily || theme.fonts.heading)}, font_size=${Math.max(layout.minWordBodyFontSize + 2, finiteNumber(block.style?.fontSize, theme.typography.heading))})`);
    return;
  }
  if (block.type === 'text' || block.type === 'quote' || block.type === 'code') {
    const bold = block.style?.fontWeight === undefined
      ? false
      : String(block.style.fontWeight).trim().toLowerCase() === 'bold' || finiteNumber(block.style.fontWeight, 400) >= 600;
    const italic = block.style?.fontStyle === undefined ? block.type === 'quote' : block.style.fontStyle === 'italic';
    pythonLine(builder, `document.add_paragraph(${id}, ${pythonString(text)}, font_size=${fontSize}, bold=${pythonBoolean(bold)}, italic=${pythonBoolean(italic)}, color=${color}, align=${align}, line_spacing=${clamp(finiteNumber(block.style?.lineHeight, 1.3), 1, 1.8)}, font_name=${pythonString(block.style?.fontFamily || (block.type === 'code' ? theme.fonts.mono : theme.fonts.body))})`);
    return;
  }
  if (block.type === 'list') {
    const method = block.ordered ? 'add_numbered_list' : 'add_bullets';
    pythonLine(builder, `document.${method}(${id}, ${pythonJson((block.items || []).map(itemText))}, level=${Math.max(0, Math.round(finiteNumber(block.level, 0)))}, font_size=${fontSize}, color=${color}, font_name=${pythonString(block.style?.fontFamily || theme.fonts.body)})`);
    return;
  }
  if (block.type === 'table') {
    const rows = block.rows || [];
    pythonLine(builder, `document.add_table(${id}, ${pythonJson(rows)}, column_widths=${pythonJson(writerColumnWeights(rows))}, header=True, font_size=${Math.max(9, fontSize)}, font_name=${pythonString(theme.fonts.body)}, header_fill=${pythonColor(theme.colors.primary)}, header_color=0xFFFFFF, body_color=${pythonColor(theme.colors.text)})`);
    return;
  }
  if (block.type === 'image') {
      pythonLine(builder, `document.add_inline_image(${id}, ${pythonString(block.source)}, align=${align}, alt_text=${pythonString(block.alt || block.caption || '')}, title=${pythonString(block.title || '')})`);
    if (block.caption) pythonLine(builder, `document.add_paragraph(${pythonString(facadeDerivedId(block.id, 'caption'))}, ${pythonString(block.caption)}, font_size=9, italic=True, color=${pythonColor(theme.colors.muted)}, align='CENTER', font_name=${pythonString(theme.fonts.body)})`);
    return;
  }
  if (block.type === 'chart') {
    if (block.source) {
      pythonLine(builder, `document.add_inline_image(${id}, ${pythonString(block.source)}, align='CENTER', alt_text=${pythonString(block.alt || block.caption || block.title || 'Chart')}, title=${pythonString(block.title || '')})`);
      if (block.caption) pythonLine(builder, `document.add_paragraph(${pythonString(facadeDerivedId(block.id, 'caption'))}, ${pythonString(block.caption)}, font_size=9, italic=True, color=${pythonColor(theme.colors.muted)}, align='CENTER', font_name=${pythonString(theme.fonts.body)})`);
    } else {
      const rows = chartRows(block);
      pythonLine(builder, `document.add_table(${id}, ${pythonJson(rows)}, column_widths=${pythonJson(writerColumnWeights(rows))}, header=True, font_size=9, font_name=${pythonString(theme.fonts.body)}, header_fill=${pythonColor(theme.colors.primary)}, header_color=0xFFFFFF, body_color=${pythonColor(theme.colors.text)})`);
    }
    return;
  }
  if (block.type === 'metric' || block.type === 'card') {
    const data = block.data && typeof block.data === 'object' ? block.data as Record<string, unknown> : {};
    const body = [block.text, data.value, blockChildren(block).map(blockText).filter(Boolean).join('\n')]
      .map((value) => String(value ?? '').trim())
      .filter((value, index, values) => value && values.indexOf(value) === index)
      .join('\n');
    const rows = [[firstNonEmptyString(block.title, data.label, block.name), body]];
    pythonLine(builder, `document.add_table(${id}, ${pythonJson(rows)}, column_widths=[1, 2], header=False, font_size=${fontSize}, font_name=${pythonString(theme.fonts.body)}, body_color=${pythonColor(theme.colors.text)})`);
    return;
  }
  if (block.type === 'timeline') {
    const rows = [['Milestone', 'Detail'], ...timelineRows(block)];
    pythonLine(builder, `document.add_table(${id}, ${pythonJson(rows)}, column_widths=[1, 2], header=True, font_size=${fontSize}, font_name=${pythonString(theme.fonts.body)}, header_fill=${pythonColor(theme.colors.primary)}, header_color=0xFFFFFF, body_color=${pythonColor(theme.colors.text)})`);
    return;
  }
  if (block.type === 'columns') {
    for (const column of block.columns || []) for (const child of column.blocks || []) emitWriterBlock(builder, child, theme, layout);
    return;
  }
  if (block.type === 'pageBreak') {
    pythonLine(builder, `document.add_page_break(${id})`);
    return;
  }
  if (block.type === 'divider') {
    pythonLine(builder, `document.add_paragraph(${id}, '────────────────────────', font_size=9, color=${pythonColor(theme.colors.border)}, align='CENTER', font_name=${pythonString(theme.fonts.body)})`);
    return;
  }
  if (block.type === 'spacer') {
    pythonLine(builder, `document.add_paragraph(${id}, '', font_size=${layout.minWordBodyFontSize}, space_after=120, font_name=${pythonString(theme.fonts.body)})`);
    return;
  }
  const fallback = text || blockChildren(block).map(blockText).filter(Boolean).join('\n');
  if (fallback) pythonLine(builder, `document.add_paragraph(${id}, ${pythonString(fallback)}, font_size=${fontSize}, color=${color}, align=${align}, font_name=${pythonString(theme.fonts.body)})`);
}

function emitWriterDocument(
  builder: PythonProgramBuilder,
  spec: OfficeDocumentSpec,
  theme: ResolvedOfficeTheme,
  layout: ResolvedOfficeLayoutPolicy,
) {
  pythonLine(builder, `document = job.writer('document')`);
  if (spec.document.title || spec.document.author || spec.document.description) {
    pythonLine(builder, `document.set_doc_info(title=${spec.document.title ? pythonString(spec.document.title) : 'None'}, author=${spec.document.author ? pythonString(spec.document.author) : 'None'}, description=${spec.document.description ? pythonString(spec.document.description) : 'None'})`);
  }
  const page = spec.document.page || {};
  const unit = page.unit || 'mm';
  let pageWidth = writerLength(page.width, unit, 21_000);
  let pageHeight = writerLength(page.height, unit, 29_700);
  const autoLandscape = page.orientation === undefined && containsWideTable(spec.blocks, layout.maxTableColumns);
  const landscape = page.orientation === 'landscape' || autoLandscape;
  if (landscape && pageWidth < pageHeight) [pageWidth, pageHeight] = [pageHeight, pageWidth];
  if (page.orientation === 'portrait' && pageWidth > pageHeight) [pageWidth, pageHeight] = [pageHeight, pageWidth];
  const safeMargin = layout.enabled ? Math.round(layout.safeMargin * 2_540) : 0;
  const margin = (value: unknown, fallback: number) => {
    const defaultValue = layout.enabled ? Math.max(safeMargin, fallback) : fallback;
    if (value === undefined || value === null) return defaultValue;
    const resolved = writerLength(value, unit, defaultValue);
    return layout.enabled ? Math.max(safeMargin, resolved) : resolved;
  };
  const margins = [
    margin(page.marginLeft, 2_000),
    margin(page.marginRight, 2_000),
    margin(page.marginTop, 1_800),
    margin(page.marginBottom, 1_800),
  ];
  pythonLine(builder, `document.set_page('page-style', width=${pageWidth}, height=${pageHeight}, margins=${pythonJson(margins)})`);
  const header = String(spec.document.page?.header || '');
  const footer = String(spec.document.page?.footer || '');
  if (header || footer) {
    pythonLine(builder, `document.set_header_footer(header=${pythonString(header)}, footer=${pythonString(footer)}, header_element_id='document-header', footer_element_id='document-footer')`);
  }
  const roots = spec.blocks;
  roots.forEach((block, index) => {
    if (block.type === 'page') {
      builder.lines.push(`    # @webpilot-unit sections/${index + 1}-${sourceUnitSegment(block.id, 'section')}`);
      if (index > 0 || block.breakBefore === 'page') {
        pythonLine(builder, `document.add_page_break(${pythonString(facadeDerivedId(block.id, 'break'))})`);
      }
      if (block.title) {
        const method = block.template === 'cover' ? 'add_title' : 'add_heading';
        const args = method === 'add_heading' ? ', level=1' : '';
        pythonLine(builder, `document.${method}(${pythonString(facadeDerivedId(block.id, 'title'))}, ${pythonString(block.title)}${args}, color=${pythonColor(theme.colors.primary)}, align=${pythonString(block.template === 'cover' ? 'CENTER' : 'LEFT')}, font_name=${pythonString(theme.fonts.heading)}, font_size=${method === 'add_title' ? theme.typography.title : theme.typography.heading})`);
      }
      if (block.subtitle) pythonLine(builder, `document.add_paragraph(${pythonString(facadeDerivedId(block.id, 'subtitle'))}, ${pythonString(block.subtitle)}, font_size=${Math.max(layout.minWordBodyFontSize, 12)}, color=${pythonColor(theme.colors.muted)}, align=${pythonString(block.template === 'cover' ? 'CENTER' : 'LEFT')}, font_name=${pythonString(theme.fonts.body)})`);
      for (const child of block.children || []) emitWriterBlock(builder, child, theme, layout);
      builder.lines.push('    # @webpilot-endunit');
    } else {
      emitWriterBlock(builder, block, theme, layout);
    }
  });
  pythonLine(builder, 'document.save()');
  pythonLine(builder, 'document.close()');
}

function emitSpreadsheetDocument(
  builder: PythonProgramBuilder,
  spec: OfficeDocumentSpec,
  theme: ResolvedOfficeTheme,
  layout: ResolvedOfficeLayoutPolicy,
) {
  const flattenChildren = (blocks: OfficeBlock[]): OfficeBlock[] => blocks.flatMap((block) => {
    if (block.type === 'columns') {
      return (block.columns || []).flatMap((column) => flattenChildren(column.blocks || []));
    }
    if (block.type === 'page' || block.type === 'sheet') {
      const heading = block.title || block.name
        ? [{ ...block, type: 'heading', children: undefined, columns: undefined } as OfficeBlock]
        : [];
      return [...heading, ...flattenChildren(block.children || [])];
    }
    return [block];
  });
  pythonLine(builder, `workbook = job.spreadsheet('document')`);
  if (spec.document.title || spec.document.author || spec.document.description) {
    pythonLine(builder, `workbook.set_doc_info(title=${spec.document.title ? pythonString(spec.document.title) : 'None'}, author=${spec.document.author ? pythonString(spec.document.author) : 'None'}, description=${spec.document.description ? pythonString(spec.document.description) : 'None'})`);
  }
  const sheets = spec.blocks.filter((block) => block.type === 'sheet');
  const usedSheetNames = new Set<string>();
  sheets.forEach((sheetBlock, sheetIndex) => {
    builder.lines.push(`    # @webpilot-unit sheets/${sheetIndex + 1}-${sourceUnitSegment(sheetBlock.id, 'sheet')}`);
    const sheet = `sheet_${sheetIndex + 1}`;
    const rawName = String(sheetBlock.name || sheetBlock.title || `Sheet ${sheetIndex + 1}`)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/[\\/?*\[\]:]+/g, ' ')
      .trim()
      .replace(/^'+|'+$/g, '')
      .trim() || `Sheet ${sheetIndex + 1}`;
    let name = [...rawName].slice(0, 31).join('');
    let nameSuffix = 2;
    while (usedSheetNames.has(name.toLowerCase())) {
      const suffix = ` ${nameSuffix}`;
      name = `${[...rawName].slice(0, 31 - suffix.length).join('')}${suffix}`;
      nameSuffix += 1;
    }
    usedSheetNames.add(name.toLowerCase());
    pythonLine(builder, `${sheet} = workbook.sheet(${pythonString(sheetBlock.id)}, ${pythonString(name)})`);
    const children = flattenChildren(sheetBlock.children || []);
    const maximumColumns = Math.max(2, ...children.map((block) => block.type === 'table'
      ? Math.max(1, ...(block.rows || []).map((row) => row.length))
      : block.type === 'chart' ? Math.max(10, chartData(block).series.length + 1)
        : block.type === 'image' ? 10 : 2));
    let row = 1;
    let headerRow = 1;
    let hasHeaderRow = false;
    const columnWidths: number[] = [];
    const rememberColumnWidths = (rows: unknown[][]) => {
      tableColumnWeights(rows).forEach((characters, index) => {
        const mm = clamp(8 + characters * 1.55, 22, 64);
        columnWidths[index] = Math.max(columnWidths[index] || 0, mm);
      });
    };
    if (sheetBlock.title || spec.document.title) {
      const lastColumn = spreadsheetColumnName(Math.min(maximumColumns, 12) - 1);
      pythonLine(builder, `${sheet}.set_cell('title', 'A1', ${pythonString(sheetBlock.title || spec.document.title)}, style=${pythonJson({
        font_size: Math.max(18, theme.typography.heading), bold: true,
        color: Number.parseInt(theme.colors.text, 16), background: Number.parseInt(theme.colors.background, 16),
        font_name: theme.fonts.heading, vertical: 'CENTER',
      })})`);
      pythonLine(builder, `${sheet}.merge('title-merge', 'A1:${lastColumn}1')`);
      pythonLine(builder, `${sheet}.row_height('title-height', 1, workbook.mm(12))`);
      row = 3;
      headerRow = 3;
    }
    children.forEach((block) => {
      if (block.title && ['list', 'table', 'timeline'].includes(block.type)) {
        const titleLastColumn = spreadsheetColumnName(Math.min(maximumColumns, 12) - 1);
        pythonLine(builder, `${sheet}.set_cell(${pythonString(facadeDerivedId(block.id, 'title'))}, ${pythonString(`A${row}`)}, ${pythonString(block.title)}, style=${pythonJson({
          font_size: Math.max(14, theme.typography.heading - 4),
          font_name: theme.fonts.heading,
          bold: true,
          color: Number.parseInt(theme.colors.text, 16),
          background: Number.parseInt(theme.colors.background, 16),
          wrap: true,
        })})`);
        pythonLine(builder, `${sheet}.merge(${pythonString(facadeDerivedId(block.id, 'title-merge'))}, ${pythonString(`A${row}:${titleLastColumn}${row}`)})`);
        row += 2;
      }
      if (block.type === 'table') {
        const rows = block.rows || [];
        const width = Math.max(1, ...(rows.map((values) => values.length)));
        const endColumn = spreadsheetColumnName(width - 1);
        pythonLine(builder, `${sheet}.add_table(${pythonString(block.id)}, ${pythonString(`A${row}`)}, ${pythonJson(rows)}, header=True, style=${pythonJson({
          font_size: Math.max(layout.minSpreadsheetFontSize, finiteNumber(block.style?.fontSize, theme.typography.body)),
          font_name: theme.fonts.body, color: Number.parseInt(theme.colors.text, 16),
          vertical: 'CENTER', wrap: true,
        })})`);
        pythonLine(builder, `${sheet}.format(${pythonString(facadeDerivedId(block.id, 'header'))}, ${pythonString(`A${row}:${endColumn}${row}`)}, bold=True, color=0xFFFFFF, background=${pythonColor(theme.colors.primary)}, horizontal='CENTER', vertical='CENTER', wrap=True, font_name=${pythonString(theme.fonts.body)})`);
        pythonLine(builder, `${sheet}.auto_filter(${pythonString(facadeDerivedId(block.id, 'filter'))}, ${pythonString(`A${row}:${endColumn}${row + rows.length - 1}`)})`);
        if (!hasHeaderRow) {
          headerRow = row;
          hasHeaderRow = true;
        }
        rememberColumnWidths(rows);
        row += rows.length + 2;
        return;
      }
      if (block.type === 'chart') {
        if (block.source) {
          pythonLine(builder, `${sheet}.add_image(${pythonString(block.id)}, ${pythonString(block.source)}, (0, 0, workbook.mm(150), workbook.mm(82)), contain=True, alt_text=${pythonString(block.alt || block.caption || block.title || 'Chart')}, title=${pythonString(block.title || '')}, anchor=${pythonString(`A${row}`)}, reserve_space=True)`);
          if (block.caption) {
            pythonLine(builder, `${sheet}.set_cell(${pythonString(facadeDerivedId(block.id, 'caption'))}, ${pythonString(`A${row + 1}`)}, ${pythonString(block.caption)}, style=${pythonJson({
              font_size: Math.max(8, theme.typography.caption),
              font_name: theme.fonts.body,
              italic: true,
              color: Number.parseInt(theme.colors.muted, 16),
              wrap: true,
            })})`);
          }
          row += block.caption ? 3 : 2;
          return;
        }
        const rows = chartRows(block);
        rememberColumnWidths(rows);
        const width = Math.max(2, rows[0]?.length || 2);
        const endColumn = spreadsheetColumnName(width - 1);
        const endRow = row + rows.length - 1;
        pythonLine(builder, `${sheet}.add_table(${pythonString(facadeDerivedId(block.id, 'data'))}, ${pythonString(`A${row}`)}, ${pythonJson(rows)}, header=True, style=${pythonJson({ font_size: layout.minSpreadsheetFontSize, font_name: theme.fonts.body, wrap: true })})`);
        pythonLine(builder, `${sheet}.format(${pythonString(facadeDerivedId(block.id, 'data-header'))}, ${pythonString(`A${row}:${endColumn}${row}`)}, bold=True, color=0xFFFFFF, background=${pythonColor(theme.colors.primary)}, horizontal='CENTER')`);
        const chart = chartData(block);
        pythonLine(builder, `${sheet}.add_chart(${pythonString(block.id)}, ${pythonString(`A${row}:${endColumn}${endRow}`)}, (0, 0, workbook.mm(165), workbook.mm(88)), chart_type=${pythonString(chart.chartType)}, title=${block.title ? pythonString(block.title) : 'None'}, legend=${pythonBoolean(chart.showLegend)}, alt_text=${block.alt ? pythonString(block.alt) : 'None'}, anchor=${pythonString(`A${endRow + 2}`)}, reserve_space=True)`);
        row = endRow + 4;
        return;
      }
      if (block.type === 'metric' || block.type === 'card') {
        const data = block.data && typeof block.data === 'object' ? block.data as Record<string, unknown> : {};
        const body = [block.text, data.value, blockChildren(block).map(blockText).filter(Boolean).join('\n')]
          .map((value) => String(value ?? '').trim())
          .filter((value, index, values) => value && values.indexOf(value) === index)
          .join('\n');
        const rows = [[
          firstNonEmptyString(block.title, data.label, block.name),
          body,
        ]];
        rememberColumnWidths(rows);
        pythonLine(builder, `${sheet}.set_range(${pythonString(block.id)}, ${pythonString(`A${row}`)}, ${pythonJson(rows)}, style=${pythonJson({
          font_size: Math.max(12, layout.minSpreadsheetFontSize), font_name: theme.fonts.body,
          bold: true, background: Number.parseInt(theme.colors.background, 16), color: Number.parseInt(theme.colors.text, 16),
        })})`);
        row += 2;
        return;
      }
      if (block.type === 'list') {
        const indent = '  '.repeat(Math.max(0, Math.round(finiteNumber(block.level, 0))));
        const rows = (block.items || []).map((item, index) => [
          `${indent}${block.ordered ? `${index + 1}.` : '•'} ${itemText(item)}`,
        ]);
        if (rows.length) {
          rememberColumnWidths(rows);
          pythonLine(builder, `${sheet}.set_range(${pythonString(block.id)}, ${pythonString(`A${row}`)}, ${pythonJson(rows)}, style=${pythonJson({
            font_size: layout.minSpreadsheetFontSize,
            font_name: theme.fonts.body,
            color: Number.parseInt(theme.colors.text, 16),
            wrap: true,
          })})`);
          row += rows.length + 1;
        }
        return;
      }
      if (block.type === 'heading' || block.type === 'text' || block.type === 'quote' || block.type === 'code') {
        const lastColumn = spreadsheetColumnName(Math.min(maximumColumns, 12) - 1);
        pythonLine(builder, `${sheet}.set_cell(${pythonString(block.id)}, ${pythonString(`A${row}`)}, ${pythonString(ownBlockText(block))}, style=${pythonJson({
          font_size: block.type === 'heading'
            ? Math.max(14, theme.typography.heading - 4 - (clamp(Math.round(finiteNumber(block.level, 1)), 1, 4) - 1) * 2)
            : layout.minSpreadsheetFontSize,
          font_name: block.type === 'code' ? theme.fonts.mono : block.type === 'heading' ? theme.fonts.heading : theme.fonts.body,
          bold: block.type === 'heading', italic: block.type === 'quote', wrap: true,
          color: Number.parseInt(theme.colors.text, 16), background: Number.parseInt(block.type === 'heading' ? theme.colors.background : theme.colors.surface, 16),
        })})`);
        pythonLine(builder, `${sheet}.merge(${pythonString(facadeDerivedId(block.id, 'merge'))}, ${pythonString(`A${row}:${lastColumn}${row}`)})`);
        row += 2;
        return;
      }
      if (block.type === 'image') {
        pythonLine(builder, `${sheet}.add_image(${pythonString(block.id)}, ${pythonString(block.source)}, (0, 0, workbook.mm(150), workbook.mm(82)), contain=True, alt_text=${pythonString(block.alt || block.caption || '')}, title=${pythonString(block.title || '')}, anchor=${pythonString(`A${row}`)}, reserve_space=True)`);
        if (block.caption) {
          pythonLine(builder, `${sheet}.set_cell(${pythonString(facadeDerivedId(block.id, 'caption'))}, ${pythonString(`A${row + 1}`)}, ${pythonString(block.caption)}, style=${pythonJson({
            font_size: Math.max(8, theme.typography.caption),
            font_name: theme.fonts.body,
            italic: true,
            color: Number.parseInt(theme.colors.muted, 16),
            wrap: true,
          })})`);
        }
        row += block.caption ? 3 : 2;
        return;
      }
      if (block.type === 'timeline') {
        const rows = [['Milestone', 'Detail'], ...timelineRows(block)];
        rememberColumnWidths(rows);
        pythonLine(builder, `${sheet}.add_table(${pythonString(block.id)}, ${pythonString(`A${row}`)}, ${pythonJson(rows)}, header=True, style=${pythonJson({ font_size: layout.minSpreadsheetFontSize, font_name: theme.fonts.body, wrap: true })})`);
        row += rows.length + 2;
        return;
      }
      if (block.type === 'divider') row += 1;
      if (block.type === 'spacer') row += 2;
    });
    columnWidths.forEach((mm, index) => {
      pythonLine(builder, `${sheet}.column_width(${pythonString(`layout-column-${index + 1}`)}, ${pythonString(spreadsheetColumnName(index))}, workbook.mm(${mm.toFixed(1)}))`);
    });
    const lastColumn = spreadsheetColumnName(maximumColumns - 1);
    const lastRow = Math.max(1, row - 1);
    const orientation = spec.document.page?.orientation || (maximumColumns > 8 ? 'landscape' : 'portrait');
    pythonLine(builder, `${sheet}.freeze('freeze-header', rows=${Math.max(1, headerRow)}, columns=0)`);
    pythonLine(builder, `${sheet}.print_setup('print-layout', orientation=${pythonString(orientation)}, scale=85, repeat_rows=${pythonString(`A1:${lastColumn}${Math.max(1, headerRow)}`)}, print_area=${pythonString(`A1:${lastColumn}${lastRow}`)}, margins=${pythonJson({ left: 800, right: 800, top: 900, bottom: 900 })})`);
    builder.lines.push('    # @webpilot-endunit');
  });
  pythonLine(builder, 'workbook.save()');
  pythonLine(builder, 'workbook.close()');
}

function emitUnoSemanticProgram(
  spec: OfficeDocumentSpec,
  theme: ResolvedOfficeTheme,
  layout: ResolvedOfficeLayoutPolicy,
) {
  const builder: PythonProgramBuilder = { lines: ['import json', '', 'def create_document(job):'], variable: 0 };
  if (spec.documentType === 'presentation') emitPresentationDocument(builder, spec, theme, layout);
  else if (spec.documentType === 'word') emitWriterDocument(builder, spec, theme, layout);
  else emitSpreadsheetDocument(builder, spec, theme, layout);
  return `${builder.lines.join('\n')}\n`;
}

export function compileOfficeSemanticDocument(
  input: OfficeSemanticDocumentInput & Required<Pick<OfficeDocumentSpec, 'documentType' | 'fileName'>>,
  generator: 'javascript' | 'uno' = 'uno',
) {
  const result = normalizeOfficeSemanticDocument(input);
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length) {
    const error = new Error(errors.map((diagnostic) => diagnostic.message).join('\n'));
    Object.assign(error, { code: 'SEMANTIC_DOCUMENT_INVALID', diagnostics: result.diagnostics });
    throw error;
  }
  if (generator !== 'uno') {
    const error = new Error('Semantic Office generation currently requires an UNO-planned create workspace; use program for JavaScript or existing-file modification workflows.');
    Object.assign(error, { code: 'SEMANTIC_GENERATOR_UNSUPPORTED', diagnostics: result.diagnostics });
    throw error;
  }
  return {
    ...result,
    program: emitUnoSemanticProgram(result.normalized, result.theme, result.layout),
  };
}

export function officeSemanticThemePresets() {
  return structuredClone(THEME_PRESETS);
}
