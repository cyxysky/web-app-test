import type { StepExecutionResult, StepToolCall } from '@/server/ai/schemas/runtime.schema';

export type BrowserChatArtifactSummary = {
  bytes?: number;
  documentId?: string;
  downloadUrl?: string;
  fileName: string;
  id: string;
  kind: 'file' | 'image' | 'screenshot';
  pageCount?: number;
  path?: string;
  title?: string;
  url?: string;
};

const browserChatFileToolNames = new Set([
  'file',
  'downloadFile',
  'generateFile',
  'fillDocumentTemplate',
]);

export function browserChatScreenshotIsInternalDocumentPreview(
  toolName: string,
  screenshot: { path?: string; title?: string },
) {
  const path = String(screenshot.path || '').replace(/\\/g, '/');
  if (/(?:^|\/)attachment-previews(?:\/|$)/i.test(path)) return true;
  const legacyInternalTitle = /^\s*(?:file|readFile|generateFile|fillDocumentTemplate)\s+explicit image\s+\d+\s*$/i.test(String(screenshot.title || ''));
  return legacyInternalTitle && (!toolName || browserChatFileToolNames.has(toolName));
}

function recordFromUnknown(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function jsonRecord(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    return recordFromUnknown(JSON.parse(value));
  } catch {
    return undefined;
  }
}

export function browserChatArtifactFileName(value: unknown) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().replace(/\\/g, '/');
  if (!normalized) return '';
  const fileName = normalized.split('/').pop() || '';
  try {
    return decodeURIComponent(fileName);
  } catch {
    return fileName;
  }
}

export function browserChatArtifactExtension(fileName: string) {
  return fileName.match(/\.([a-z0-9]{1,10})$/i)?.[1]?.toUpperCase();
}

export function browserChatArtifactIsImage(fileName: string) {
  return /\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(fileName);
}

function browserChatFileArtifact(tool: StepToolCall): BrowserChatArtifactSummary | undefined {
  if (!browserChatFileToolNames.has(tool.name)) return undefined;
  const rawResult = recordFromUnknown(tool.rawResult);
  if (rawResult?.ok !== true) return undefined;
  const payload = recordFromUnknown(rawResult.actual) || jsonRecord(rawResult.actual);
  if (!payload) return undefined;

  const artifactId = typeof payload.artifactId === 'string' ? payload.artifactId.trim() : '';
  const path = typeof payload.path === 'string' ? payload.path.trim() : '';
  const url = typeof payload.url === 'string' ? payload.url.trim() : '';
  const downloadUrl = typeof payload.downloadUrl === 'string' ? payload.downloadUrl.trim() : '';
  const documentId = typeof payload.documentId === 'string' ? payload.documentId.trim() : '';
  if (!artifactId && !path && !url && !downloadUrl) return undefined;

  const visualVerification = recordFromUnknown(payload.visualVerification);
  const bytes = typeof payload.bytes === 'number' && Number.isFinite(payload.bytes) && payload.bytes >= 0
    ? payload.bytes
    : undefined;
  const pageCount = typeof visualVerification?.pageCount === 'number'
    && Number.isFinite(visualVerification.pageCount)
    && visualVerification.pageCount > 0
    ? Math.floor(visualVerification.pageCount)
    : undefined;
  const fileName = browserChatArtifactFileName(payload.fileName)
    || browserChatArtifactFileName(path)
    || browserChatArtifactFileName(artifactId)
    || 'artifact';
  return {
    bytes,
    documentId: documentId || undefined,
    downloadUrl: downloadUrl || undefined,
    fileName,
    id: documentId
      ? `file:document:${documentId}`
      : `file:${artifactId || path || url || downloadUrl}`,
    kind: browserChatArtifactIsImage(fileName) ? 'image' : 'file',
    pageCount,
    path: path || undefined,
    url: url || undefined,
  };
}

export function browserChatArtifactsFromTool(tool: StepToolCall) {
  const artifacts: BrowserChatArtifactSummary[] = [];
  const file = browserChatFileArtifact(tool);
  if (file) artifacts.push(file);
  for (const screenshot of tool.screenshots || []) {
    if (browserChatScreenshotIsInternalDocumentPreview(tool.name, screenshot)) continue;
    const path = screenshot.path?.trim();
    if (!path) continue;
    artifacts.push({
      fileName: browserChatArtifactFileName(path) || 'screenshot.png',
      id: `screenshot:${path}`,
      kind: 'screenshot',
      path,
      title: screenshot.title?.trim() || '截图',
    });
  }
  return artifacts;
}

export function mergeBrowserChatArtifactSummaries(
  ...groups: ReadonlyArray<readonly BrowserChatArtifactSummary[] | undefined>
) {
  const byId = new Map<string, BrowserChatArtifactSummary>();
  for (const artifact of groups.flatMap((group) => group || [])) {
    if (
      artifact.kind === 'screenshot'
      && browserChatScreenshotIsInternalDocumentPreview('', artifact)
    ) continue;
    const previous = byId.get(artifact.id);
    byId.set(artifact.id, previous ? { ...previous, ...artifact } : artifact);
  }
  return [...byId.values()];
}

export function browserChatArtifactsFromSteps(steps: readonly StepExecutionResult[]) {
  return mergeBrowserChatArtifactSummaries(
    steps.flatMap((step) => (step.tools || []).flatMap(browserChatArtifactsFromTool)),
  );
}
