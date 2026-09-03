import type { CDPSession, Page } from 'playwright';
import {
  flattenCdpFrameTree,
  type CapturedSnapshotFrame,
  type CdpAxNode,
  type CdpAxProperty,
  type CdpAxValue,
  type CdpFrameTree,
} from './snapshot-shared.js';

export type { CapturedSnapshotFrame } from './snapshot-shared.js';

export type SnapshotView = 'actionable' | 'full' | 'text';

export type CapturedSnapshotNode = {
  identity: string;
  frameId: string;
  documentId: string;
  frameUrl?: string;
  frameDepth: number;
  axNodeId: string;
  backendDOMNodeId?: number;
  parentAxNodeId?: string;
  childAxNodeIds: string[];
  depth: number;
  ignored: boolean;
  role: string;
  name: string;
  description: string;
  value: string;
  url: string;
  properties: Record<string, string | number | boolean>;
  actionable: boolean;
};

export type CapturedAxSnapshot = {
  frames: CapturedSnapshotFrame[];
  nodes: CapturedSnapshotNode[];
  skippedFrames: CapturedSnapshotFrame[];
  timings: {
    totalMs: number;
    frameTreeMs: number;
    axTreeMs: number;
  };
};

export type SnapshotNodeWithUid = CapturedSnapshotNode & {
  uid: string;
  source?: 'ax' | 'dom' | 'dom-snapshot';
  selector?: string;
  framePath?: string;
  actions?: string[];
};

export type SnapshotRecord = {
  line: string;
  uid?: string;
  role?: string;
  name?: string;
  url?: string;
  actionable?: boolean;
  frameId?: string;
};

export type SnapshotViews = {
  actionable: SnapshotRecord[];
  full: SnapshotRecord[];
  text: SnapshotRecord[];
};

const actionableRoles = new Set([
  'button',
  'checkbox',
  'combobox',
  'gridcell',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'scrollbar',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

const actionableProperties = new Set([
  'actions',
  'editable',
  'settable',
]);

const contextualRoles = new Set([
  'alert',
  'article',
  'banner',
  'cell',
  'columnheader',
  'complementary',
  'contentinfo',
  'dialog',
  'form',
  'heading',
  'labeltext',
  'list',
  'listitem',
  'main',
  'menu',
  'navigation',
  'paragraph',
  'row',
  'rowgroup',
  'rowheader',
  'status',
  'table',
  'toolbar',
]);

const actionableContextRoots = new Set([
  'dialog',
  'form',
  'listitem',
  'menu',
  'row',
  'toolbar',
]);

const serializedProperties = [
  'class',
  'icon',
  'checked',
  'disabled',
  'expanded',
  'focused',
  'hasPopup',
  'invalid',
  'level',
  'modal',
  'multiline',
  'multiselectable',
  'orientation',
  'pressed',
  'readonly',
  'required',
  'selected',
  'valuemax',
  'valuemin',
  'valuetext',
] as const;

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function valueOf(value?: CdpAxValue) {
  const raw = value?.value;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return raw;
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    if (typeof record.value === 'string' || typeof record.value === 'number' || typeof record.value === 'boolean') {
      return record.value;
    }
  }
  return String(raw);
}

function stringValue(value?: CdpAxValue) {
  const raw = valueOf(value);
  return typeof raw === 'string' ? raw : String(raw || '');
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function readableText(value: unknown) {
  return normalizeWhitespace(String(value || '').replace(/\p{Co}/gu, ' '));
}

function propertyRecord(properties?: CdpAxProperty[]) {
  const result: Record<string, string | number | boolean> = {};
  for (const property of properties || []) {
    if (!property.name) continue;
    const value = valueOf(property.value);
    if (value === '') continue;
    result[property.name] = value;
  }
  return result;
}

function roleOf(node: CdpAxNode) {
  return normalizeWhitespace(stringValue(node.role) || stringValue(node.chromeRole) || 'generic');
}

function isActionable(role: string, properties: Record<string, string | number | boolean>) {
  const normalizedRole = role.toLowerCase();
  if (actionableRoles.has(normalizedRole)) return true;
  if (Object.keys(properties).some((name) => actionableProperties.has(name) && properties[name] !== false && properties[name] !== 'false')) return true;
  return properties.focusable !== false
    && properties.focusable !== 'false'
    && Boolean(properties.focusable)
    && !contextualRoles.has(normalizedRole)
    && !['generic', 'none', 'rootwebarea', 'statictext', 'webarea'].includes(normalizedRole);
}

async function concurrentMap<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>) {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, values.length)) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function normalizeFrameNodes(
  frame: CapturedSnapshotFrame,
  rawNodes: CdpAxNode[],
  sensitiveBackendNodeIds: ReadonlySet<number> = new Set(),
) {
  const rawById = new Map(rawNodes.map((node) => [String(node.nodeId || ''), node]));
  const depthById = new Map<string, number>();
  const depthOf = (nodeId: string, visiting = new Set<string>()): number => {
    const cached = depthById.get(nodeId);
    if (cached !== undefined) return cached;
    if (!nodeId || visiting.has(nodeId)) return 0;
    visiting.add(nodeId);
    const parentId = rawById.get(nodeId)?.parentId;
    const depth = parentId ? depthOf(parentId, visiting) + 1 : 0;
    visiting.delete(nodeId);
    depthById.set(nodeId, depth);
    return depth;
  };

  return rawNodes.map((node, index): CapturedSnapshotNode => {
    const axNodeId = String(node.nodeId || `${frame.frameId}:${index}`);
    const properties = propertyRecord(node.properties);
    const role = roleOf(node);
    const urlProperty = properties.url;
    const sensitive = Boolean(
      (node.backendDOMNodeId && sensitiveBackendNodeIds.has(node.backendDOMNodeId))
      || properties.protected === true
      || properties.protected === 'true',
    );
    if (sensitive) properties.sensitiveInput = true;
    return {
      identity: `${frame.documentId}:${frame.frameId}:${node.backendDOMNodeId || axNodeId}`,
      frameId: frame.frameId,
      documentId: frame.documentId,
      frameUrl: frame.url,
      frameDepth: frame.depth,
      axNodeId,
      backendDOMNodeId: node.backendDOMNodeId,
      parentAxNodeId: node.parentId,
      childAxNodeIds: (node.childIds || []).map(String),
      depth: depthOf(axNodeId),
      ignored: node.ignored === true,
      role,
      name: normalizeWhitespace(stringValue(node.name)),
      description: normalizeWhitespace(stringValue(node.description)),
      value: sensitive && stringValue(node.value) ? '[redacted]' : normalizeWhitespace(stringValue(node.value)),
      url: typeof urlProperty === 'string' ? urlProperty : '',
      properties,
      actionable: isActionable(role, properties),
    };
  });
}

async function sensitiveBackendNodes(client: CDPSession, nodes: CdpAxNode[]) {
  const candidates = nodes.filter((node) => {
    if (!node.backendDOMNodeId) return false;
    const role = roleOf(node).toLowerCase();
    return ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(role);
  });
  const sensitive = new Set<number>();
  await concurrentMap(candidates, 8, async (node) => {
    const backendNodeId = node.backendDOMNodeId;
    if (!backendNodeId) return;
    let objectId = '';
    try {
      const resolved = await client.send('DOM.resolveNode', { backendNodeId }) as {
        object?: { objectId?: string };
      };
      objectId = resolved.object?.objectId || '';
      if (!objectId) return;
      const checked = await client.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function () {
          if (!(this instanceof HTMLInputElement) && !(this instanceof HTMLTextAreaElement)) return false;
          const type = this instanceof HTMLInputElement ? String(this.type || '').toLowerCase() : '';
          const autocomplete = String(this.autocomplete || this.getAttribute('autocomplete') || '');
          return type === 'password'
            || /(?:^|\\s)(?:current-password|new-password|one-time-code)(?:\\s|$)/i.test(autocomplete)
            || this.getAttribute('data-webpilot-sensitive-input') === 'true';
        }`,
        returnByValue: true,
        silent: true,
      }) as { result?: { value?: unknown } };
      if (checked.result?.value === true) sensitive.add(backendNodeId);
    } catch {
      // A detached node is safe to ignore; the snapshot will be discarded on navigation/mutation.
    } finally {
      if (objectId) await client.send('Runtime.releaseObject', { objectId }).catch(() => undefined);
    }
  });
  return sensitive;
}

export async function captureAxSnapshot(page: Page, allowedFrameIds?: ReadonlySet<string>): Promise<CapturedAxSnapshot> {
  const totalStartedAt = Date.now();
  const client: CDPSession = await page.context().newCDPSession(page);
  try {
    const frameTreeStartedAt = Date.now();
    const frameTreeResult = await client.send('Page.getFrameTree') as { frameTree: CdpFrameTree };
    const frames = flattenCdpFrameTree(frameTreeResult.frameTree)
      .filter((frame) => !allowedFrameIds || allowedFrameIds.has(frame.frameId));
    const frameTreeMs = Date.now() - frameTreeStartedAt;
    const axTreeStartedAt = Date.now();
    const perFrame = await concurrentMap(frames, 4, async (frame) => {
      try {
        const result = await client.send('Accessibility.getFullAXTree', { frameId: frame.frameId }) as { nodes?: CdpAxNode[] };
        const rawNodes = result.nodes || [];
        const sensitiveNodeIds = await sensitiveBackendNodes(client, rawNodes);
        return { frame, nodes: normalizeFrameNodes(frame, rawNodes, sensitiveNodeIds) };
      } catch (error) {
        return { frame: { ...frame, error: errorText(error) }, nodes: [] as CapturedSnapshotNode[] };
      }
    });
    const axTreeMs = Date.now() - axTreeStartedAt;
    const normalizedFrames = perFrame.map((item) => item.frame);
    return {
      frames: normalizedFrames,
      nodes: perFrame.flatMap((item) => item.nodes),
      skippedFrames: normalizedFrames.filter((frame) => Boolean(frame.error)),
      timings: {
        totalMs: Date.now() - totalStartedAt,
        frameTreeMs,
        axTreeMs,
      },
    };
  } finally {
    await client.detach().catch(() => undefined);
  }
}

function escaped(value: string, maxLength = 500) {
  const normalized = normalizeWhitespace(value);
  const compact = normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
  return compact.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function meaningfulNode(node: SnapshotNodeWithUid) {
  if (node.ignored) return false;
  const role = node.role.toLowerCase();
  if (role === 'inlinetextbox') return false;
  if (node.actionable || node.name || node.value || node.description || node.url) return true;
  return role === 'rootwebarea' || role === 'webarea' || contextualRoles.has(role);
}

function snapshotNodeKey(node: SnapshotNodeWithUid) {
  return `${node.frameId}:${node.axNodeId}`;
}

function displayTextForNode(node: SnapshotNodeWithUid) {
  return readableText(node.name) || readableText(node.description) || readableText(node.value);
}

function ancestorsForNode(
  node: SnapshotNodeWithUid,
  byFrameAndId: ReadonlyMap<string, SnapshotNodeWithUid>,
  maxHops = 24,
) {
  const ancestors: SnapshotNodeWithUid[] = [];
  let current = node;
  for (let hops = 0; current.parentAxNodeId && hops < maxHops; hops += 1) {
    const parent = byFrameAndId.get(`${current.frameId}:${current.parentAxNodeId}`);
    if (!parent) break;
    ancestors.push(parent);
    current = parent;
  }
  return ancestors;
}

function contextLabelForUnnamedAction(
  node: SnapshotNodeWithUid,
  byFrameAndId: ReadonlyMap<string, SnapshotNodeWithUid>,
) {
  if (!node.actionable) return '';
  const ancestors = ancestorsForNode(node, byFrameAndId);
  const namedAncestor = (roles: ReadonlySet<string>) => ancestors.find((ancestor) => (
    roles.has(ancestor.role.toLowerCase()) && displayTextForNode(ancestor)
  ));
  const row = namedAncestor(new Set(['row', 'rowheader']));
  const column = namedAncestor(new Set(['columnheader']));
  const container = namedAncestor(new Set(['toolbar', 'menu', 'dialog', 'form', 'navigation', 'list']));
  const page = namedAncestor(new Set(['rootwebarea', 'webarea']));
  const context = (candidate?: SnapshotNodeWithUid) => displayTextForNode(candidate || node).slice(0, 180);
  const role = node.role.toLowerCase();

  if (role === 'checkbox' && row) return `[上下文] 选择：${context(row)}`;
  if (role === 'checkbox' && column) return `[上下文] ${context(column)}列全选`;
  if (column) return `[无标签控件：${context(column)}列]`;
  if (row) return `[无标签控件：${context(row)}行]`;
  if (container) return `[无标签控件：${context(container)}]`;
  if (page) return `[无标签页面控件：${context(page)}]`;
  return '[无标签页面控件]';
}

function displayNameForNode(
  node: SnapshotNodeWithUid,
  byFrameAndId: ReadonlyMap<string, SnapshotNodeWithUid>,
) {
  return displayTextForNode(node) || contextLabelForUnnamedAction(node, byFrameAndId);
}

function serializeNode(node: SnapshotNodeWithUid, displayName: string) {
  const parts = node.actionable ? [`uid=${node.uid}`, node.role || 'generic'] : [node.role || 'generic'];
  const primaryName = displayName;
  if (primaryName) parts.push(`"${escaped(primaryName)}"`);
  if (node.value && readableText(node.value) !== normalizeWhitespace(primaryName)) {
    parts.push(`value="${escaped(node.value, 300)}"`);
  }
  if (node.url) parts.push(`url="${escaped(node.url, 800)}"`);
  for (const name of serializedProperties) {
    const value = node.properties[name];
    if (value === undefined || value === '' || value === false || value === 'false') continue;
    parts.push(`${name}=${typeof value === 'string' && /\s/.test(value) ? `"${escaped(value, 200)}"` : String(value)}`);
  }
  if (node.source !== 'ax' && node.actions?.length) parts.push(`actions=${node.actions.join('|')}`);
  return `${'  '.repeat(Math.min(24, node.frameDepth + node.depth))}${parts.join(' ')}`;
}

function frameBoundary(frame: CapturedSnapshotFrame): SnapshotRecord {
  const details = [
    `frame=${frame.frameId}`,
    frame.url ? `url="${escaped(frame.url, 800)}"` : '',
    frame.name ? `name="${escaped(frame.name, 200)}"` : '',
    frame.error ? `error="${escaped(frame.error, 500)}"` : '',
  ].filter(Boolean).join(' ');
  return { line: `${'  '.repeat(Math.min(24, frame.depth))}[${details}]`, frameId: frame.frameId };
}

function recordForNode(node: SnapshotNodeWithUid, displayName: string): SnapshotRecord {
  return {
    line: serializeNode(node, displayName),
    uid: node.uid,
    role: node.role,
    name: displayName || undefined,
    url: node.url || undefined,
    actionable: node.actionable,
    frameId: node.frameId,
  };
}

function actionableNodeIds(nodes: SnapshotNodeWithUid[]) {
  const included = new Set<string>();
  const byFrameAndId = new Map(nodes.map((node) => [`${node.frameId}:${node.axNodeId}`, node]));
  const contextRoots = new Set<string>();

  for (const node of nodes) {
    if (!node.actionable) continue;
    included.add(`${node.frameId}:${node.axNodeId}`);
    let current: SnapshotNodeWithUid | undefined = node;
    let hops = 0;
    while (current?.parentAxNodeId && hops < 30) {
      const parent = byFrameAndId.get(`${node.frameId}:${current.parentAxNodeId}`);
      if (!parent) break;
      const key = `${parent.frameId}:${parent.axNodeId}`;
      const parentRole = parent.role.toLowerCase();
      if (
        contextualRoles.has(parentRole)
        || parentRole === 'rootwebarea'
        || parentRole === 'webarea'
      ) included.add(key);
      if (actionableContextRoots.has(parentRole)) contextRoots.add(key);
      current = parent;
      hops += 1;
    }
  }

  const withinContextRoot = (node: SnapshotNodeWithUid) => {
    let current: SnapshotNodeWithUid | undefined = node;
    let hops = 0;
    while (current && hops < 12) {
      const key = `${current.frameId}:${current.axNodeId}`;
      if (contextRoots.has(key)) return { key, distance: hops };
      if (!current.parentAxNodeId) return undefined;
      current = byFrameAndId.get(`${current.frameId}:${current.parentAxNodeId}`);
      hops += 1;
    }
    return undefined;
  };

  const contextCandidates = new Map<string, Array<{ key: string; distance: number; priority: number }>>();
  for (const node of nodes) {
    if (!node.name && !node.value && !node.description) continue;
    const role = node.role.toLowerCase();
    if (!contextualRoles.has(role) && role !== 'statictext' && role !== 'labeltext') continue;
    const root = withinContextRoot(node);
    if (!root) continue;
    const candidates = contextCandidates.get(root.key) || [];
    candidates.push({
      key: `${node.frameId}:${node.axNodeId}`,
      distance: root.distance,
      priority: role === 'labeltext' ? 0 : role === 'statictext' ? 2 : 1,
    });
    contextCandidates.set(root.key, candidates);
  }
  for (const candidates of contextCandidates.values()) {
    candidates
      .sort((left, right) => left.priority - right.priority || left.distance - right.distance)
      .slice(0, 24)
      .forEach((candidate) => included.add(candidate.key));
  }
  return included;
}

export function buildSnapshotViews(
  frames: CapturedSnapshotFrame[],
  nodes: SnapshotNodeWithUid[],
): SnapshotViews {
  const meaningful = nodes.filter(meaningfulNode);
  const nodeByFrameAndId = new Map(meaningful.map((node) => [snapshotNodeKey(node), node]));
  const displayNameByKey = new Map(meaningful.map((node) => [
    snapshotNodeKey(node),
    displayNameForNode(node, nodeByFrameAndId),
  ]));
  const actionableIds = actionableNodeIds(meaningful);
  const actionable: SnapshotRecord[] = [];
  const full: SnapshotRecord[] = [];
  const text: SnapshotRecord[] = [];
  const textSeen = new Set<string>();
  const nodesByFrame = new Map<string, SnapshotNodeWithUid[]>();
  for (const node of meaningful) {
    const list = nodesByFrame.get(node.frameId) || [];
    list.push(node);
    nodesByFrame.set(node.frameId, list);
  }

  for (const frame of frames) {
    const frameNodes = nodesByFrame.get(frame.frameId) || [];
    const hasAxTree = frameNodes.some((node) => node.source === 'ax');
    const treeNodes = hasAxTree ? frameNodes.filter((node) => node.source === 'ax') : frameNodes;
    const domOnlyNodes = hasAxTree ? frameNodes.filter((node) => node.source !== 'ax') : [];
    const boundary = frameBoundary(frame);
    full.push(boundary);
    if (frameNodes.some((node) => actionableIds.has(`${node.frameId}:${node.axNodeId}`))) actionable.push(boundary);
    if (treeNodes.some((node) => displayTextForNode(node))) text.push(boundary);
    const actionableFrameNodes = frameNodes.filter((node) => (
      actionableIds.has(`${node.frameId}:${node.axNodeId}`) || (node.source !== 'ax' && node.actionable)
    ));
    for (const node of actionableFrameNodes) {
      actionable.push(recordForNode(node, displayNameByKey.get(snapshotNodeKey(node)) || ''));
    }
    for (const node of treeNodes) {
      const displayName = displayNameByKey.get(snapshotNodeKey(node)) || '';
      const record = recordForNode(node, displayName);
      full.push(record);
      const textValue = displayTextForNode(node);
      if (!textValue) continue;
      const textKey = `${frame.frameId}:${textValue}`;
      if (textSeen.has(textKey)) continue;
      textSeen.add(textKey);
      text.push({ ...record, line: `${'  '.repeat(Math.min(24, node.frameDepth))}${textValue}` });
    }
    if (domOnlyNodes.length) {
      full.push({ line: `${'  '.repeat(Math.min(24, frame.depth + 1))}[DOM-only interactive controls]`, frameId: frame.frameId });
      for (const node of domOnlyNodes) {
        full.push(recordForNode(node, displayNameByKey.get(snapshotNodeKey(node)) || ''));
      }
    }
  }
  return { actionable, full, text };
}

export function snapshotRoleIsActionable(role: string) {
  return actionableRoles.has(role.toLowerCase());
}
