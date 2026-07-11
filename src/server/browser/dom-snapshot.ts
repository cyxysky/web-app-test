import type { CDPSession, Page } from 'playwright';
import type { CapturedSnapshotFrame, CapturedSnapshotNode } from './ax-snapshot';

type StringIndex = number;
type RareStringData = { index?: number[]; value?: number[] };
type RareIntegerData = { index?: number[]; value?: number[] };
type RareBooleanData = { index?: number[] };

type DomSnapshotDocument = {
  documentURL: StringIndex;
  title: StringIndex;
  baseURL: StringIndex;
  frameId: StringIndex;
  scrollOffsetX?: number;
  scrollOffsetY?: number;
  contentWidth?: number;
  contentHeight?: number;
  nodes: {
    parentIndex?: number[];
    nodeType?: number[];
    nodeName?: StringIndex[];
    nodeValue?: StringIndex[];
    backendNodeId?: number[];
    attributes?: StringIndex[][];
    textValue?: RareStringData;
    inputValue?: RareStringData;
    inputChecked?: RareBooleanData;
    optionSelected?: RareBooleanData;
    contentDocumentIndex?: RareIntegerData;
    isClickable?: RareBooleanData;
  };
  layout: {
    nodeIndex: number[];
    styles: StringIndex[][];
    bounds: number[][];
    text: StringIndex[];
    paintOrders?: number[];
    scrollRects?: number[][];
    clientRects?: number[][];
  };
};

type DomSnapshotResult = {
  documents: DomSnapshotDocument[];
  strings: string[];
};

type CdpFrameTree = {
  frame: {
    id: string;
    loaderId?: string;
    name?: string;
    parentId?: string;
    url?: string;
  };
  childFrames?: CdpFrameTree[];
};

type CdpAxValue = { value?: unknown };
type CdpAxNode = {
  nodeId?: string;
  ignored?: boolean;
  role?: CdpAxValue;
  chromeRole?: CdpAxValue;
  name?: CdpAxValue;
  description?: CdpAxValue;
  value?: CdpAxValue;
  properties?: Array<{ name?: string; value?: CdpAxValue }>;
  backendDOMNodeId?: number;
};

export type CapturedDomSnapshotNode = CapturedSnapshotNode & {
  source: 'dom-snapshot';
  actions: string[];
};

export type CapturedDomSnapshot = {
  frames: CapturedSnapshotFrame[];
  nodes: CapturedDomSnapshotNode[];
  skippedFrames: CapturedSnapshotFrame[];
  timings: {
    totalMs: number;
    frameTreeMs: number;
    domSnapshotMs: number;
    axEnrichmentMs: number;
  };
};

const computedStyles = [
  'display',
  'visibility',
  'opacity',
  'pointer-events',
  'cursor',
  'overflow-x',
  'overflow-y',
  'position',
  'z-index',
  'content-visibility',
];

const clickRoles = new Set([
  'button', 'checkbox', 'gridcell', 'link', 'listbox', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'radio', 'scrollbar', 'slider', 'switch', 'tab', 'treeitem',
]);

const typeRoles = new Set(['textbox', 'searchbox', 'spinbutton']);
const structuralRoles = new Set([
  'alert', 'article', 'banner', 'cell', 'columnheader', 'complementary', 'contentinfo', 'dialog',
  'form', 'heading', 'labeltext', 'list', 'listitem', 'main', 'menu', 'navigation', 'paragraph',
  'region', 'row', 'rowgroup', 'rowheader', 'status', 'table', 'toolbar',
]);

const textBearingRoles = new Set([
  'alert', 'article', 'cell', 'columnheader', 'heading', 'labeltext', 'listitem', 'paragraph',
  'rowheader', 'status',
]);

const ignoredTags = new Set(['HEAD', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK']);

function text(value: unknown) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function axValue(value?: CdpAxValue) {
  const raw = value?.value;
  return typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean' ? raw : '';
}

function frameList(tree: CdpFrameTree, depth = 0, output: CapturedSnapshotFrame[] = []) {
  output.push({
    frameId: tree.frame.id,
    documentId: tree.frame.loaderId || tree.frame.id,
    name: tree.frame.name || undefined,
    parentFrameId: tree.frame.parentId || undefined,
    url: tree.frame.url || undefined,
    depth,
  });
  for (const child of tree.childFrames || []) frameList(child, depth + 1, output);
  return output;
}

function rareString(data: RareStringData | undefined, strings: string[]) {
  const result = new Map<number, string>();
  for (let cursor = 0; cursor < (data?.index?.length || 0); cursor += 1) {
    result.set(data!.index![cursor], strings[data!.value?.[cursor] || 0] || '');
  }
  return result;
}

function rareBoolean(data?: RareBooleanData) {
  return new Set(data?.index || []);
}

function attributesAt(raw: StringIndex[] | undefined, strings: string[]) {
  const result: Record<string, string> = {};
  for (let cursor = 0; cursor < (raw?.length || 0); cursor += 2) {
    const name = (strings[raw![cursor]] || '').toLowerCase();
    if (name) result[name] = strings[raw![cursor + 1]] || '';
  }
  return result;
}

function inferredRole(tag: string, attributes: Record<string, string>) {
  const explicit = text(attributes.role).toLowerCase().split(/\s+/)[0];
  if (explicit) return explicit;
  const inputType = (attributes.type || 'text').toLowerCase();
  if (tag === 'A' && attributes.href) return 'link';
  if (tag === 'BUTTON') return 'button';
  if (tag === 'TEXTAREA') return 'textbox';
  if (tag === 'SELECT') return 'combobox';
  if (tag === 'INPUT') {
    if (inputType === 'checkbox') return 'checkbox';
    if (inputType === 'radio') return 'radio';
    if (inputType === 'range') return 'slider';
    if (inputType === 'number') return 'spinbutton';
    if (inputType === 'search') return 'searchbox';
    if (['button', 'submit', 'reset', 'image'].includes(inputType)) return 'button';
    return 'textbox';
  }
  if (/^H[1-6]$/.test(tag)) return 'heading';
  if (tag === 'ARTICLE') return 'article';
  if (tag === 'NAV') return 'navigation';
  if (tag === 'MAIN') return 'main';
  if (tag === 'FORM') return 'form';
  if (tag === 'LI') return 'listitem';
  if (tag === 'UL' || tag === 'OL') return 'list';
  if (tag === 'P') return 'paragraph';
  if (tag === 'TABLE') return 'table';
  if (tag === 'TR') return 'row';
  if (tag === 'TH') return 'columnheader';
  if (tag === 'TD') return 'cell';
  if (tag === 'LABEL') return 'labeltext';
  if (tag === 'IMG') return 'image';
  return 'generic';
}

function actionsFor(tag: string, role: string, attributes: Record<string, string>, clickable: boolean, cursor: string) {
  const actions = new Set<string>();
  const inputType = (attributes.type || 'text').toLowerCase();
  const clickAttribute = Object.keys(attributes).some((name) => (
    /^(onclick|jsaction|ng-click|@click|v-on:click|data-.+?(click|action|href|url|target))$/i.test(name)
    && attributes[name] !== 'false'
  ));
  if (
    clickable
    || clickRoles.has(role)
    || tag === 'BUTTON'
    || (tag === 'A' && Boolean(attributes.href))
    || (tag === 'INPUT' && ['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit'].includes(inputType))
    || clickAttribute
    || cursor === 'pointer'
  ) actions.add('click');
  if (
    tag === 'TEXTAREA'
    || (tag === 'INPUT' && !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(inputType))
    || attributes.contenteditable === ''
    || attributes.contenteditable === 'true'
    || typeRoles.has(role)
  ) {
    actions.add('focus');
    actions.add('type');
  }
  if (tag === 'SELECT' || role === 'combobox') {
    actions.add('click');
    actions.add('focus');
  }
  if ('tabindex' in attributes && !['list', 'listitem', 'row', 'rowgroup', 'table'].includes(role)) actions.add('focus');
  return [...actions];
}

function resolveUrl(value: string, baseUrl: string) {
  if (!value) return '';
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return value;
  }
}

function candidateScore(node: CapturedDomSnapshotNode) {
  const role = node.role.toLowerCase();
  let score = 0;
  if (typeRoles.has(role) || role === 'combobox') score += 100;
  else if (role === 'button') score += 80;
  else if (role === 'link') score += 45;
  else if (node.actionable) score += 55;
  if (node.name) score += 20;
  if (node.properties.rendered === true) score += 15;
  if (node.properties.viewportVisible === true) score += 25;
  if (node.properties.disabled === true) score -= 40;
  if (node.actions.includes('type')) score += 20;
  return score;
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>) {
  const output = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return output;
}

function enrichFromAx(node: CapturedDomSnapshotNode, axNode: CdpAxNode | undefined) {
  if (!axNode) return node;
  const properties = { ...node.properties };
  for (const property of axNode.properties || []) {
    if (!property.name) continue;
    const value = axValue(property.value);
    if (value !== '') properties[property.name] = value;
  }
  const axRole = text(axValue(axNode.role) || axValue(axNode.chromeRole));
  const role = axRole && !['generic', 'none'].includes(axRole.toLowerCase()) ? axRole : node.role;
  const name = text(axValue(axNode.name)) || node.name;
  const actions = new Set(node.actions);
  if (clickRoles.has(role.toLowerCase())) actions.add('click');
  if (typeRoles.has(role.toLowerCase())) {
    actions.add('focus');
    actions.add('type');
  }
  if (properties.focusable) actions.add('focus');
  return {
    ...node,
    role,
    name,
    description: text(axValue(axNode.description)) || node.description,
    value: text(axValue(axNode.value)) || node.value,
    properties: { ...properties, axIgnored: axNode.ignored === true },
    actions: [...actions],
    actionable: actions.size > 0 && properties.disabled !== true && properties.disabled !== 'true',
  };
}

export async function captureDomSnapshot(page: Page, options: { axCandidateLimit?: number } = {}): Promise<CapturedDomSnapshot> {
  const totalStartedAt = Date.now();
  const viewport = page.viewportSize() || await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    .catch(() => ({ width: 0, height: 0 }));
  const client: CDPSession = await page.context().newCDPSession(page);
  try {
    const frameStartedAt = Date.now();
    const frameTreeResult = await client.send('Page.getFrameTree') as { frameTree: CdpFrameTree };
    const frames = frameList(frameTreeResult.frameTree);
    const frameTreeMs = Date.now() - frameStartedAt;
    const frameById = new Map(frames.map((frame) => [frame.frameId, frame]));

    const snapshotStartedAt = Date.now();
    const snapshot = await client.send('DOMSnapshot.captureSnapshot', {
      computedStyles,
      includePaintOrder: true,
      includeDOMRects: true,
    }) as DomSnapshotResult;
    const domSnapshotMs = Date.now() - snapshotStartedAt;
    const strings = snapshot.strings || [];
    const output: CapturedDomSnapshotNode[] = [];
    const rawParentByBackend = new Map<string, number>();

    for (const [documentIndex, document] of (snapshot.documents || []).entries()) {
      const frameId = strings[document.frameId] || `dom-frame-${documentIndex}`;
      const knownFrame = frameById.get(frameId);
      const frame: CapturedSnapshotFrame = knownFrame || {
        frameId,
        documentId: frameId,
        url: strings[document.documentURL] || undefined,
        depth: 0,
      };
      if (!knownFrame) {
        frames.push(frame);
        frameById.set(frameId, frame);
      }
      const nodes = document.nodes;
      const count = nodes.backendNodeId?.length || nodes.nodeType?.length || 0;
      const parents = nodes.parentIndex || [];
      const children = Array.from({ length: count }, () => [] as number[]);
      for (let index = 0; index < count; index += 1) {
        const parent = parents[index];
        if (parent >= 0 && parent < count) children[parent].push(index);
      }
      const attrs = Array.from({ length: count }, (_, index) => attributesAt(nodes.attributes?.[index], strings));
      const idToIndex = new Map<string, number>();
      for (let index = 0; index < count; index += 1) if (attrs[index].id) idToIndex.set(attrs[index].id, index);
      const layoutByNode = new Map<number, { bounds: number[]; styles: Record<string, string>; paintOrder: number; scrollRect?: number[] }>();
      for (let layoutIndex = 0; layoutIndex < (document.layout?.nodeIndex?.length || 0); layoutIndex += 1) {
        const styles: Record<string, string> = {};
        for (let styleIndex = 0; styleIndex < computedStyles.length; styleIndex += 1) {
          styles[computedStyles[styleIndex]] = strings[document.layout.styles?.[layoutIndex]?.[styleIndex]] || '';
        }
        layoutByNode.set(document.layout.nodeIndex[layoutIndex], {
          bounds: document.layout.bounds?.[layoutIndex] || [],
          styles,
          paintOrder: document.layout.paintOrders?.[layoutIndex] || 0,
          scrollRect: document.layout.scrollRects?.[layoutIndex],
        });
      }
      const inputValues = rareString(nodes.inputValue, strings);
      const textValues = rareString(nodes.textValue, strings);
      const checked = rareBoolean(nodes.inputChecked);
      const selected = rareBoolean(nodes.optionSelected);
      const clickable = rareBoolean(nodes.isClickable);
      const descendantText = Array.from({ length: count }, (_, index) => {
        if (nodes.nodeType?.[index] !== 3 || !layoutByNode.has(index)) return '';
        return text(strings[nodes.nodeValue?.[index] || 0]);
      });
      for (let index = count - 1; index >= 0; index -= 1) {
        if (nodes.nodeType?.[index] !== 1) continue;
        const combined = children[index].map((child) => descendantText[child]).filter(Boolean).join(' ');
        descendantText[index] = text(combined).slice(0, 600);
      }
      const labelByTarget = new Map<string, string>();
      for (let index = 0; index < count; index += 1) {
        if ((strings[nodes.nodeName?.[index] || 0] || '').toUpperCase() === 'LABEL' && attrs[index].for) {
          labelByTarget.set(attrs[index].for, descendantText[index]);
        }
      }
      const depthCache = new Map<number, number>();
      const depthOf = (index: number): number => {
        const cached = depthCache.get(index);
        if (cached !== undefined) return cached;
        const parent = parents[index];
        const depth = parent >= 0 && parent !== index ? depthOf(parent) + 1 : 0;
        depthCache.set(index, depth);
        return depth;
      };
      const documentUrl = strings[document.documentURL] || frame.url || '';
      const baseUrl = strings[document.baseURL] || documentUrl;
      for (let index = 0; index < count; index += 1) {
        const nodeType = nodes.nodeType?.[index];
        const backendDOMNodeId = nodes.backendNodeId?.[index];
        if (!backendDOMNodeId) continue;
        const rawParentBackendId = parents[index] >= 0 ? nodes.backendNodeId?.[parents[index]] : undefined;
        if (rawParentBackendId) rawParentByBackend.set(`${frameId}:${backendDOMNodeId}`, rawParentBackendId);
        if (nodeType === 9) {
          const role = 'RootWebArea';
          output.push({
            identity: `${frame.documentId}:${frameId}:${backendDOMNodeId}`,
            source: 'dom-snapshot',
            frameId,
            documentId: frame.documentId,
            frameUrl: documentUrl,
            frameDepth: frame.depth,
            axNodeId: `dom:${backendDOMNodeId}`,
            backendDOMNodeId,
            childAxNodeIds: [],
            depth: 0,
            ignored: false,
            role,
            name: text(strings[document.title]),
            description: '',
            value: '',
            url: documentUrl,
            properties: { rendered: true },
            actionable: false,
            actions: [],
          });
          continue;
        }
        if (nodeType !== 1) continue;
        const tag = (strings[nodes.nodeName?.[index] || 0] || '').toUpperCase();
        if (!tag || ignoredTags.has(tag)) continue;
        const attributes = attrs[index];
        const layout = layoutByNode.get(index);
        const bounds = layout?.bounds || [];
        const styles = layout?.styles || {};
        const rendered = Boolean(layout && bounds[2] > 0 && bounds[3] > 0
          && styles.display !== 'none'
          && !['hidden', 'collapse'].includes(styles.visibility)
          && styles['content-visibility'] !== 'hidden'
          && Number(styles.opacity || '1') > 0.01);
        const role = inferredRole(tag, attributes);
        const actions = actionsFor(tag, role, attributes, clickable.has(index), styles.cursor || '');
        const disabled = 'disabled' in attributes || attributes['aria-disabled'] === 'true';
        const actionable = rendered && actions.length > 0 && !disabled;
        const labelledBy = text((attributes['aria-labelledby'] || '').split(/\s+/)
          .map((id) => descendantText[idToIndex.get(id) ?? -1] || '')
          .join(' '));
        const ownText = descendantText[index];
        const inputType = (attributes.type || '').toLowerCase();
        const value = text(inputValues.get(index) || textValues.get(index) || attributes.value || '');
        const semanticText = actionable || textBearingRoles.has(role) ? ownText : '';
        const name = text(
          labelledBy
          || attributes['aria-label']
          || (attributes.id ? labelByTarget.get(attributes.id) : '')
          || (tag === 'IMG' ? attributes.alt : '')
          || (tag === 'INPUT' && ['button', 'submit', 'reset'].includes(inputType) ? value : '')
          || semanticText
          || attributes.placeholder
          || attributes.title
          || attributes.name,
        ).slice(0, 400);
        const semantic = structuralRoles.has(role) || ['IMG', 'SECTION'].includes(tag);
        if (!actionable && !semantic) continue;
        const parentBackendId = parents[index] >= 0 ? nodes.backendNodeId?.[parents[index]] : undefined;
        const properties: Record<string, string | number | boolean> = {
          rendered,
          paintOrder: layout?.paintOrder || 0,
        };
        if (
          rendered
          && bounds[0] < (document.scrollOffsetX || 0) + viewport.width
          && bounds[1] < (document.scrollOffsetY || 0) + viewport.height
          && bounds[0] + bounds[2] > (document.scrollOffsetX || 0)
          && bounds[1] + bounds[3] > (document.scrollOffsetY || 0)
        ) properties.viewportVisible = true;
        if (styles.cursor === 'pointer') properties.cursorPointer = true;
        if (disabled) properties.disabled = true;
        if (checked.has(index) || attributes['aria-checked'] === 'true') properties.checked = true;
        if (selected.has(index) || attributes['aria-selected'] === 'true') properties.selected = true;
        if ('required' in attributes || attributes['aria-required'] === 'true') properties.required = true;
        if ('readonly' in attributes || attributes['aria-readonly'] === 'true') properties.readonly = true;
        if (attributes['aria-expanded'] && attributes['aria-expanded'] !== 'false') properties.expanded = attributes['aria-expanded'];
        if (layout?.scrollRect && (layout.scrollRect[2] > bounds[2] || layout.scrollRect[3] > bounds[3])) properties.scrollable = true;
        output.push({
          identity: `${frame.documentId}:${frameId}:${backendDOMNodeId}`,
          source: 'dom-snapshot',
          frameId,
          documentId: frame.documentId,
          frameUrl: documentUrl,
          frameDepth: frame.depth,
          axNodeId: `dom:${backendDOMNodeId}`,
          backendDOMNodeId,
          parentAxNodeId: parentBackendId ? `dom:${parentBackendId}` : undefined,
          childAxNodeIds: children[index]
            .map((child) => nodes.backendNodeId?.[child])
            .filter((id): id is number => Boolean(id))
            .map((id) => `dom:${id}`),
          depth: Math.min(64, depthOf(index)),
          ignored: false,
          role,
          name,
          description: '',
          value,
          url: resolveUrl(attributes.href || '', baseUrl),
          properties,
          actionable,
          actions,
        });
      }
    }

    const byBackend = new Map(output.map((node) => [`${node.frameId}:${node.backendDOMNodeId}`, node]));
    for (const node of output) {
      let parentBackend = rawParentByBackend.get(`${node.frameId}:${node.backendDOMNodeId}`);
      for (let guard = 0; parentBackend && guard < 64; guard += 1) {
        const parent = byBackend.get(`${node.frameId}:${parentBackend}`);
        if (parent) {
          node.parentAxNodeId = parent.axNodeId;
          break;
        }
        parentBackend = rawParentByBackend.get(`${node.frameId}:${parentBackend}`);
      }
    }
    const byAxId = new Map(output.map((node) => [`${node.frameId}:${node.axNodeId}`, node]));
    const deduplicated = output.filter((node) => {
      if (!node.actionable || !node.parentAxNodeId) return true;
      const parent = byAxId.get(`${node.frameId}:${node.parentAxNodeId}`);
      if (!parent?.actionable) return true;
      const sameEntityLink = Boolean(node.url && parent.url === node.url);
      const inheritedPointer = node.properties.cursorPointer === true && parent.properties.cursorPointer === true;
      if (!sameEntityLink && !inheritedPointer) return true;
      return !(parent.name === node.name || Boolean(node.name && parent.name.includes(node.name)));
    });

    const enrichmentStartedAt = Date.now();
    const candidateLimit = Math.min(500, Math.max(0, options.axCandidateLimit ?? 200));
    const candidates = deduplicated
      .filter((node) => node.actionable && node.backendDOMNodeId)
      .sort((left, right) => candidateScore(right) - candidateScore(left))
      .slice(0, candidateLimit);
    const enriched = await mapConcurrent(candidates, 8, async (node) => {
      const result = await client.send('Accessibility.getPartialAXTree', {
        backendNodeId: node.backendDOMNodeId,
        fetchRelatives: false,
      }).catch(() => undefined) as { nodes?: CdpAxNode[] } | undefined;
      const matching = result?.nodes?.find((item) => item.backendDOMNodeId === node.backendDOMNodeId) || result?.nodes?.[0];
      return enrichFromAx(node, matching);
    });
    const enrichedByIdentity = new Map(enriched.map((node) => [node.identity, node]));
    const nodes = deduplicated.map((node) => enrichedByIdentity.get(node.identity) || node);
    const axEnrichmentMs = Date.now() - enrichmentStartedAt;
    return {
      frames,
      nodes,
      skippedFrames: [],
      timings: {
        totalMs: Date.now() - totalStartedAt,
        frameTreeMs,
        domSnapshotMs,
        axEnrichmentMs,
      },
    };
  } finally {
    await client.detach().catch(() => undefined);
  }
}
