import { withWebPilotBasePath } from '@/lib/webpilot-base-path';

export function artifactApiUrl(filePath?: string, options: { artifactsRoot?: string } = {}) {
  if (!filePath) return undefined;
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.startsWith('/api/artifacts/')) return withWebPilotBasePath(normalized);

  const root = options.artifactsRoot?.replace(/\\/g, '/').replace(/\/+$/, '');
  if (root) {
    const rootPrefix = `${root}/`;
    if (normalized.toLowerCase().startsWith(rootPrefix.toLowerCase())) {
      return withWebPilotBasePath(`/api/artifacts/${normalized.slice(rootPrefix.length)}`);
    }
  }

  const marker = '/artifacts/';
  const index = normalized.lastIndexOf(marker);
  if (index < 0) return undefined;
  return withWebPilotBasePath(`/api/artifacts/${normalized.slice(index + marker.length)}`);
}

export function artifactApiUrlFromRelative(relativePath: string) {
  return withWebPilotBasePath(`/api/artifacts/${relativePath.split('/').map(encodeURIComponent).join('/')}`);
}
