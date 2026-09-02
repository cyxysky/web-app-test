import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

export type NodeArtifactKind = 'download' | 'generated';

export type NodeArtifactUrlResolver = (input: {
  absolutePath: string;
  relativePath: string;
}) => string | undefined;

export type NodeArtifactPayload<TKind extends NodeArtifactKind = NodeArtifactKind> = {
  artifactId: string;
  kind: TKind;
  fileName: string;
  path: string;
  url?: string;
  downloadUrl?: string;
  bytes: number;
};

export function sanitizeNodeArtifactFileName(
  value: string | undefined | null,
  fallback: string,
) {
  const cleaned = String(value || '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 160);
  return cleaned || fallback;
}

export function nodeArtifactFileExtension(value: string) {
  const name = String(value || '').split(/[?#]/, 1)[0]
    .replace(/\\/g, '/')
    .split('/')
    .at(-1) || '';
  const dot = name.lastIndexOf('.');
  return dot > -1 ? name.slice(dot).toLowerCase() : '';
}

export function nodeArtifactRelativePath(
  artifactsRoot: string,
  candidatePath: string,
  errorMessage = 'Artifact must stay inside the configured artifact root.',
) {
  const root = path.resolve(artifactsRoot);
  const absolutePath = path.resolve(candidatePath);
  const relativePath = path.relative(root, absolutePath).replace(/\\/g, '/');
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(errorMessage);
  }
  return { absolutePath, relativePath };
}

export function createNodeArtifactPayload<TKind extends NodeArtifactKind>(
  store: {
    artifactsRoot: string;
    artifactUrl?: NodeArtifactUrlResolver;
  },
  input: {
    bytes: number;
    fileName: string;
    filePath: string;
    kind: TKind;
  },
): NodeArtifactPayload<TKind> {
  const { absolutePath, relativePath } = nodeArtifactRelativePath(
    store.artifactsRoot,
    input.filePath,
  );
  const url = store.artifactUrl?.({ absolutePath, relativePath });
  const separator = url?.includes('?') ? '&' : '?';
  return {
    artifactId: relativePath,
    kind: input.kind,
    fileName: input.fileName,
    path: absolutePath,
    url,
    downloadUrl: url ? `${url}${separator}download=1` : undefined,
    bytes: input.bytes,
  };
}

export async function uniqueNodeArtifactPath(
  directory: string,
  requestedFileName: string,
) {
  const parsed = path.parse(requestedFileName);
  const base = sanitizeNodeArtifactFileName(parsed.name, 'artifact');
  const extension = parsed.ext.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '').slice(0, 32);
  for (let index = 0; index < 1000; index += 1) {
    const fileName = index === 0 ? `${base}${extension}` : `${base}-${index + 1}${extension}`;
    const filePath = path.join(directory, fileName);
    try {
      await access(filePath);
    } catch {
      return { fileName, filePath };
    }
  }
  const fileName = `${base}-${randomUUID().slice(0, 8)}${extension}`;
  return { fileName, filePath: path.join(directory, fileName) };
}

export async function sha256NodeFile(filePath: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
