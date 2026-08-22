type JsonRecord = Record<string, unknown>;

function recordFromUnknown(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function parseJsonContainer(value: unknown, expected: 'array' | 'object') {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text || (expected === 'array' ? !text.startsWith('[') : !text.startsWith('{'))) return value;
  try {
    const parsed = JSON.parse(text);
    if (expected === 'array') return Array.isArray(parsed) ? parsed : value;
    return recordFromUnknown(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function providerArray(value: unknown) {
  return parseJsonContainer(value, 'array');
}

function blockArray(value: unknown) {
  return providerArray(value);
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

function coerceStyle(value: unknown) {
  const parsed = parseJsonContainer(value, 'object');
  const source = recordFromUnknown(parsed);
  if (!source) return parsed;
  const style: JsonRecord = { ...source };
  for (const key of [
    'borderRadius', 'borderWidth', 'fontSize', 'gap', 'height', 'letterSpacing',
    'lineHeight', 'opacity', 'rotation', 'width', 'x', 'y',
  ]) {
    if (key in style) style[key] = numberFromString(style[key]);
  }
  if ('padding' in style) {
    style.padding = providerArray(style.padding);
    if (Array.isArray(style.padding)) style.padding = style.padding.map(numberFromString);
  }
  if ('shadow' in style) style.shadow = booleanFromString(parseJsonContainer(style.shadow, 'object'));
  if ('fill' in style) style.fill = parseJsonContainer(style.fill, 'object');
  return style;
}

function coerceBlock(value: unknown): unknown {
  const parsed = parseJsonContainer(value, 'object');
  const source = recordFromUnknown(parsed);
  if (!source) return parsed;
  const block: JsonRecord = { ...source };
  if ('level' in block) block.level = numberFromString(block.level);
  if ('ordered' in block) block.ordered = booleanFromString(block.ordered);
  if ('style' in block) block.style = coerceStyle(block.style);
  if ('unoProperties' in block) block.unoProperties = parseJsonContainer(block.unoProperties, 'object');
  if ('data' in block && typeof block.data === 'string') {
    const arrayData = parseJsonContainer(block.data, 'array');
    block.data = arrayData === block.data ? parseJsonContainer(block.data, 'object') : arrayData;
  }
  for (const key of ['children', 'items', 'rows']) {
    if (key in block) block[key] = providerArray(block[key]);
  }
  if ('children' in block) block.children = blockArray(block.children);
  if (Array.isArray(block.children)) block.children = block.children.map(coerceBlock);
  if (Array.isArray(block.rows)) block.rows = block.rows.map(providerArray);
  if ('columns' in block) {
    block.columns = providerArray(block.columns);
  }
  if (Array.isArray(block.columns)) {
    block.columns = block.columns.map((column) => {
      const columnRecord = recordFromUnknown(column);
      if (!columnRecord) return column;
      const normalized: JsonRecord = { ...columnRecord };
      if ('width' in normalized) normalized.width = numberFromString(normalized.width);
      if ('blocks' in normalized) normalized.blocks = blockArray(normalized.blocks);
      if (Array.isArray(normalized.blocks)) normalized.blocks = normalized.blocks.map(coerceBlock);
      return normalized;
    });
  }
  return block;
}

function coerceDocument(value: unknown) {
  const parsed = parseJsonContainer(value, 'object');
  const source = recordFromUnknown(parsed);
  if (!source) return parsed;
  const document: JsonRecord = { ...source };
  if ('defaultStyle' in document) document.defaultStyle = coerceStyle(document.defaultStyle);
  if ('page' in document) document.page = parseJsonContainer(document.page, 'object');
  const page = recordFromUnknown(document.page);
  if (page) {
    const normalizedPage: JsonRecord = { ...page };
    for (const key of ['height', 'marginBottom', 'marginLeft', 'marginRight', 'marginTop', 'width']) {
      if (key in normalizedPage) normalizedPage[key] = numberFromString(normalizedPage[key]);
    }
    if ('showPageNumber' in normalizedPage) normalizedPage.showPageNumber = booleanFromString(normalizedPage.showPageNumber);
    document.page = normalizedPage;
  }
  return document;
}

function coerceEditOperation(value: unknown) {
  const source = recordFromUnknown(value);
  if (!source) return value;
  const operation: JsonRecord = { ...source };
  if ('block' in operation) operation.block = coerceBlock(operation.block);
  if ('blocks' in operation) operation.blocks = blockArray(operation.blocks);
  if (Array.isArray(operation.blocks)) operation.blocks = operation.blocks.map(coerceBlock);
  if ('patch' in operation) operation.patch = parseJsonContainer(operation.patch, 'object');
  return operation;
}

export function coerceBrowserChatToolInput(toolName: string, value: unknown) {
  if (toolName !== 'file') return value;
  const source = recordFromUnknown(value);
  if (!source || typeof source.action !== 'string') return value;
  const input: JsonRecord = { ...source };
  if (source.action === 'plan') {
    if ('document' in input) input.document = coerceDocument(input.document);
    if ('outline' in input) {
      input.outline = providerArray(input.outline);
    }
    if (Array.isArray(input.outline)) {
      input.outline = input.outline.map((item) => {
        const outline = recordFromUnknown(item);
        if (!outline) return item;
        const normalized: JsonRecord = { ...outline };
        if ('suggestedBlocks' in normalized) normalized.suggestedBlocks = providerArray(normalized.suggestedBlocks);
        return normalized;
      });
    }
  }
  if (source.action === 'generate') {
    input.blocks = blockArray(input.blocks);
    if (Array.isArray(input.blocks)) input.blocks = input.blocks.map(coerceBlock);
    if ('render' in input) input.render = booleanFromString(input.render);
    if ('expectedRevision' in input) input.expectedRevision = numberFromString(input.expectedRevision);
  }
  if (source.action === 'edit') {
    input.operations = providerArray(input.operations);
    if (Array.isArray(input.operations)) input.operations = input.operations.map(coerceEditOperation);
    if ('render' in input) input.render = booleanFromString(input.render);
    if ('expectedRevision' in input) input.expectedRevision = numberFromString(input.expectedRevision);
  }
  if (source.action === 'render' && 'expectedRevision' in input) {
    input.expectedRevision = numberFromString(input.expectedRevision);
  }
  if (source.action === 'read') {
    if ('includeVisuals' in input) input.includeVisuals = booleanFromString(input.includeVisuals);
    for (const key of ['limit', 'offset']) {
      if (key in input) input[key] = numberFromString(input[key]);
    }
    if ('pages' in input) input.pages = providerArray(input.pages);
    if (Array.isArray(input.pages)) input.pages = input.pages.map(numberFromString);
  }
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
