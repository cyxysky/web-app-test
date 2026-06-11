export function artifactApiUrl(filePath?: string, options: { artifactsRoot?: string } = {}) {
  if (!filePath) return undefined;
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.startsWith('/api/artifacts/')) return normalized;

  const root = options.artifactsRoot?.replace(/\\/g, '/').replace(/\/+$/, '');
  if (root) {
    const rootPrefix = `${root}/`;
    if (normalized.toLowerCase().startsWith(rootPrefix.toLowerCase())) {
      return `/api/artifacts/${normalized.slice(rootPrefix.length)}`;
    }
  }

  const marker = '/artifacts/';
  const index = normalized.lastIndexOf(marker);
  if (index < 0) return undefined;
  return `/api/artifacts/${normalized.slice(index + marker.length)}`;
}

export function artifactApiUrlFromRelative(relativePath: string) {
  return `/api/artifacts/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
}
