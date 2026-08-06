/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');

function normalizeBasePath(value) {
  const normalized = String(value || '').trim().replace(/^\/+|\/+$/g, '');
  return normalized ? `/${normalized}` : '';
}

function compiledServerBasePath(serverDir, fallback = '') {
  try {
    const manifestPath = path.join(serverDir, '.next', 'required-server-files.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return normalizeBasePath(manifest?.config?.basePath);
  } catch {
    return normalizeBasePath(fallback);
  }
}

function withServerBasePath(serverUrl, basePath) {
  const url = new URL(String(serverUrl || '').trim());
  const normalizedBasePath = normalizeBasePath(basePath);
  if (!normalizedBasePath) return url.toString().replace(/\/$/, '');

  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname === normalizedBasePath || pathname.endsWith(`${normalizedBasePath}`)) {
    url.pathname = pathname || '/';
  } else {
    url.pathname = `${pathname || ''}${normalizedBasePath}`;
  }
  return url.toString().replace(/\/$/, '');
}

function serverRouteUrl(serverUrl, basePath, routePath) {
  const baseUrl = withServerBasePath(serverUrl, basePath);
  return new URL(String(routePath || '').replace(/^\/+/, ''), `${baseUrl}/`).toString();
}

module.exports = {
  compiledServerBasePath,
  normalizeBasePath,
  serverRouteUrl,
  withServerBasePath,
};
