export type CdpAxValue = {
  type?: string;
  value?: unknown;
};

export type CdpAxProperty = {
  name?: string;
  value?: CdpAxValue;
};

export type CdpAxNode = {
  backendDOMNodeId?: number;
  childIds?: string[];
  chromeRole?: CdpAxValue;
  description?: CdpAxValue;
  ignored?: boolean;
  name?: CdpAxValue;
  nodeId?: string;
  parentId?: string;
  properties?: CdpAxProperty[];
  role?: CdpAxValue;
  value?: CdpAxValue;
};

export type CdpFrameTree = {
  frame: {
    id: string;
    loaderId?: string;
    name?: string;
    parentId?: string;
    url?: string;
  };
  childFrames?: CdpFrameTree[];
};

export type CapturedSnapshotFrame = {
  depth: number;
  documentId: string;
  error?: string;
  frameId: string;
  name?: string;
  parentFrameId?: string;
  url?: string;
};

export function flattenCdpFrameTree(
  tree: CdpFrameTree,
  depth = 0,
  output: CapturedSnapshotFrame[] = [],
) {
  output.push({
    frameId: tree.frame.id,
    documentId: tree.frame.loaderId || tree.frame.id,
    name: tree.frame.name || undefined,
    parentFrameId: tree.frame.parentId || undefined,
    url: tree.frame.url || undefined,
    depth,
  });
  for (const child of tree.childFrames || []) flattenCdpFrameTree(child, depth + 1, output);
  return output;
}
