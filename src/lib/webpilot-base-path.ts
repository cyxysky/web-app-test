export function normalizeWebPilotBasePath(value?: string) {
  const normalized = String(value || '').trim().replace(/^\/+|\/+$/g, '');
  return normalized ? `/${normalized}` : '';
}

export const WEBPILOT_BASE_PATH = normalizeWebPilotBasePath(
  process.env.NEXT_PUBLIC_WEBPILOT_BASE_PATH,
);

export function withWebPilotBasePath(path: string, basePath = WEBPILOT_BASE_PATH) {
  const normalizedBasePath = normalizeWebPilotBasePath(basePath);
  if (!normalizedBasePath || !path.startsWith('/') || path.startsWith('//')) return path;
  if (
    path === normalizedBasePath
    || path.startsWith(`${normalizedBasePath}/`)
    || path.startsWith(`${normalizedBasePath}?`)
    || path.startsWith(`${normalizedBasePath}#`)
  ) return path;
  return path === '/' ? normalizedBasePath : `${normalizedBasePath}${path}`;
}

export function withoutWebPilotBasePath(path: string, basePath = WEBPILOT_BASE_PATH) {
  const normalizedBasePath = normalizeWebPilotBasePath(basePath);
  if (!normalizedBasePath) return path;
  if (path === normalizedBasePath) return '/';
  return path.startsWith(`${normalizedBasePath}/`) ? path.slice(normalizedBasePath.length) : path;
}

export function joinWebPilotUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/g, '')}/${path.replace(/^\/+/, '')}`;
}
