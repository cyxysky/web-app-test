/* eslint-disable @typescript-eslint/no-require-imports */
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { randomBytes } = require('node:crypto');
const {
  identityCookie,
  mountTicketClaims,
  requestIdentity,
} = require('./webpilot-identity');
const { createRealtimeRefreshHub } = require('./realtime-refresh-hub');

function normalizeBasePath(value) {
  const normalized = String(value || '').trim().replace(/^\/+|\/+$/g, '');
  return normalized ? `/${normalized}` : '';
}

function loadCompiledNextConfig(appDir) {
  const manifestPath = path.join(appDir, '.next', 'required-server-files.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`The compiled Next configuration is missing: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest || typeof manifest !== 'object' || !manifest.config || typeof manifest.config !== 'object') {
    throw new Error(`The compiled Next configuration is invalid: ${manifestPath}`);
  }
  return manifest.config;
}

function requireRuntimeDependency(appDir, dependency) {
  const runtimeRequire = createRequire(path.join(appDir, 'package.json'));
  try {
    return runtimeRequire(dependency);
  } catch (error) {
    const expectedPath = path.join(appDir, 'node_modules', dependency);
    throw new Error(
      `The packaged server dependency "${dependency}" could not be resolved from ${appDir}. Expected: ${expectedPath}.`,
      { cause: error },
    );
  }
}

function configureCompiledNextRuntime(compiledConfig, environment = process.env) {
  if (!compiledConfig) return;
  // Next reads this complete build-time configuration while initializing its
  // runtime. `conf` alone is insufficient in some packaged deployments: the
  // server can otherwise fall back to default routing despite route manifests
  // compiled with a basePath.
  environment.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(compiledConfig);
}

function applicationBasePath(dev, compiledConfig, environment = process.env) {
  // Next.js emits basePath into the route and client manifests at build time.
  // Production request and WebSocket routing must use that same value rather
  // than a possibly edited runtime .env file.
  return normalizeBasePath(dev ? environment.WEBPILOT_BASE_PATH : compiledConfig?.basePath);
}

function stripBasePath(pathname, basePath) {
  if (!basePath) return pathname;
  if (pathname === basePath) return '/';
  return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
}

function publicPath(pathname) {
  return pathname === '/favicon.ico'
    || pathname === '/robots.txt'
    || pathname.startsWith('/_next/')
    || pathname.startsWith('/assets/')
    || pathname === '/api/embed/browser-chat/init'
    || pathname === '/embed/webpilot.js';
}

function removeUntrustedProxyHeaders(request) {
  if (String(process.env.WEBPILOT_TRUST_PROXY || '').trim().toLowerCase() === 'true') return;
  delete request.headers['forwarded'];
  delete request.headers['x-forwarded-for'];
  delete request.headers['x-forwarded-host'];
  delete request.headers['x-forwarded-port'];
  delete request.headers['x-forwarded-proto'];
}

function publicRequestOrigin(request) {
  const forwardedHost = String(request.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const host = forwardedHost || String(request.headers.host || '').trim();
  const protocol = forwardedProto || (request.socket && request.socket.encrypted ? 'https' : 'http');
  return host ? `${protocol}://${host}` : '';
}

function normalizedOrigin(value) {
  try {
    return new URL(String(value || '')).origin;
  } catch {
    return '';
  }
}

function unsafeCrossOriginRequest(request) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(request.method || '').toUpperCase())) return false;
  const fetchSite = String(request.headers['sec-fetch-site'] || '').trim().toLowerCase();
  // Fetch Metadata is calculated by the browser from the public page and
  // request origins. It remains accurate when a reverse proxy rewrites the
  // upstream Host or protocol, unlike reconstructing the public origin from
  // the Node-facing request alone.
  if (fetchSite === 'same-origin') return false;
  const origin = String(request.headers.origin || '').trim();
  if (origin) return !normalizedOrigin(origin) || normalizedOrigin(origin) !== normalizedOrigin(publicRequestOrigin(request));
  return fetchSite === 'cross-site';
}

function rejectCrossOrigin(response) {
  const body = Buffer.from(JSON.stringify({ error: 'Cross-origin state change rejected' }), 'utf8');
  response.writeHead(403, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
  });
  response.end(body);
}

function internalPort(value, fallback) {
  const parsed = Number(value || fallback);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65_535 ? Math.floor(parsed) : fallback;
}

function webSocketUpgradeTarget(requestUrl, basePath) {
  const pathname = stripBasePath(requestUrl.pathname, basePath);
  const ticket = requestUrl.searchParams.get('ticket') || '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return undefined;
  if (pathname === '/browser-preview') {
    return { kind: 'browser-preview', target: `/browser-preview${requestUrl.search}` };
  }
  if (pathname === '/refresh') {
    return { kind: 'refresh', target: `/refresh${requestUrl.search}` };
  }
  return undefined;
}

function nextDevelopmentUpgrade(requestUrl, basePath, dev) {
  if (!dev) return false;
  return requestUrl.pathname === `${normalizeBasePath(basePath)}/_next/hmr`;
}

function internalRequestAuthorized(request, pathname) {
  if (pathname === '/api/system/shutdown') {
    const expected = String(process.env.WEBPILOT_INTERNAL_SHUTDOWN_TOKEN || '');
    return Boolean(expected) && request.headers['x-webpilot-shutdown-token'] === expected;
  }
  if (pathname === '/api/automation/scheduler') {
    const expected = String(process.env.WEBPILOT_INTERNAL_REQUEST_TOKEN || '');
    return Boolean(expected) && request.headers['x-webpilot-internal-token'] === expected;
  }
  if (request.method === 'POST' && /^\/api\/automation\/runs\/[^/]+$/.test(pathname)) {
    const expected = String(process.env.WEBPILOT_INTERNAL_REQUEST_TOKEN || '');
    return Boolean(expected)
      && request.headers['x-webpilot-internal-token'] === expected
      && request.headers['x-webpilot-automation-scheduler'] === '1';
  }
  return false;
}

function internalPrincipal(request, pathname) {
  if (!internalRequestAuthorized(request, pathname)) return undefined;
  const userId = String(request.headers['x-webpilot-internal-user-id'] || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(userId)) return undefined;
  return { userId, username: 'internal-scheduler', roles: ['user'] };
}

function rejectMissingIdentity(response) {
  const body = Buffer.from(JSON.stringify({ error: 'A mounted user ID is required' }), 'utf8');
  response.writeHead(401, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
  });
  response.end(body);
}

function initializeMountedIdentity(request, response, requestUrl) {
  const ticket = requestUrl.searchParams.get('identityTicket') || '';
  if (!ticket) return false;
  const claims = mountTicketClaims(ticket);
  if (!claims) {
    rejectMissingIdentity(response);
    return true;
  }
  const refererOrigin = normalizedOrigin(request.headers.referer);
  if (claims.origin && refererOrigin && normalizedOrigin(claims.origin) !== refererOrigin) {
    rejectMissingIdentity(response);
    return true;
  }
  requestUrl.searchParams.delete('identityTicket');
  response.writeHead(303, {
    'Cache-Control': 'no-store',
    'Location': `${requestUrl.pathname}${requestUrl.search}`,
    'Set-Cookie': identityCookie(claims.userId, request),
  });
  response.end();
  return true;
}

function proxyUpgrade(request, clientSocket, head, port, targetPath) {
  const upstream = net.connect({ host: '127.0.0.1', port }, () => {
    const headers = Object.entries(request.headers)
      .filter(([name, value]) => value !== undefined && name.toLowerCase() !== 'host')
      .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
      .join('\r\n');
    upstream.write(`${request.method || 'GET'} ${targetPath} HTTP/${request.httpVersion}\r\nHost: 127.0.0.1:${port}\r\n${headers}\r\n\r\n`);
    if (head && head.length) upstream.write(head);
    clientSocket.pipe(upstream).pipe(clientSocket);
  });
  const close = () => {
    clientSocket.destroy();
    upstream.destroy();
  };
  upstream.once('error', close);
  clientSocket.once('error', close);
}

async function main() {
  const dev = process.argv.includes('--dev');
  const hostname = String(process.env.HOSTNAME || '127.0.0.1');
  const port = Math.max(1, Math.floor(Number(process.env.PORT || 3000)));
  const appDir = path.resolve(process.env.WEBPILOT_APP_DIR || process.cwd());
  const { loadEnvConfig } = requireRuntimeDependency(appDir, '@next/env');
  loadEnvConfig(appDir, dev);
  process.env.WEBPILOT_REALTIME_PUBLISH_TOKEN ||= randomBytes(32).toString('base64url');
  process.env.WEBPILOT_IDENTITY_HEADER_SECRET ||= randomBytes(32).toString('base64url');
  process.env.WEBPILOT_IDENTITY_SECRET ||= randomBytes(32).toString('base64url');
  process.env.WEBPILOT_INTERNAL_REQUEST_TOKEN ||= randomBytes(32).toString('base64url');
  const compiledConfig = dev ? undefined : loadCompiledNextConfig(appDir);

  // Load the complete build-time configuration before loading Next itself.
  // This applies to the packaged runtime regardless of whether the build uses
  // output: 'standalone'.
  configureCompiledNextRuntime(compiledConfig);
  // Electron starts this file with its bundled Node runtime. Resolve Next from
  // the external server directory explicitly instead of relying on Electron's
  // process-level NODE_PATH initialization.
  const next = requireRuntimeDependency(appDir, 'next');

  const application = next({
    dev,
    dir: appDir,
    hostname,
    port,
    ...(compiledConfig ? { conf: compiledConfig } : {}),
  });
  const handle = application.getRequestHandler();
  await application.prepare();
  const handleNextUpgrade = dev ? application.getUpgradeHandler() : undefined;

  // In production the build manifest is the sole source of truth for basePath.
  const basePath = applicationBasePath(dev, compiledConfig);

  const refreshHub = createRealtimeRefreshHub({ appDir });
  const server = http.createServer((request, response) => {
    void (async () => {
      removeUntrustedProxyHeaders(request);
      const requestUrl = new URL(request.url || '/', `http://${request.headers.host || `${hostname}:${port}`}`);
      const pathname = stripBasePath(requestUrl.pathname, basePath);

      if (requestUrl.pathname === '/_webpilot/realtime/publish') {
        await refreshHub.handlePublish(request, response);
        return;
      }

      if (
        unsafeCrossOriginRequest(request)
        && pathname !== '/api/embed/browser-chat/init'
        && !internalRequestAuthorized(request, pathname)
      ) {
        rejectCrossOrigin(response);
        return;
      }

      if (request.method === 'GET' && pathname === '/browser-chat' && initializeMountedIdentity(request, response, requestUrl)) return;

      delete request.headers['x-webpilot-identity-user-id'];
      delete request.headers['x-webpilot-identity-username'];
      delete request.headers['x-webpilot-identity-roles'];
      delete request.headers['x-webpilot-identity-proof'];
      const principal = internalPrincipal(request, pathname) || requestIdentity(request);
      if (principal) {
        request.headers['x-webpilot-identity-user-id'] = principal.userId;
        request.headers['x-webpilot-identity-username'] = principal.username;
        request.headers['x-webpilot-identity-roles'] = principal.roles.join(',');
        request.headers['x-webpilot-identity-proof'] = process.env.WEBPILOT_IDENTITY_HEADER_SECRET;
      }

      if (!principal && !publicPath(pathname) && !internalRequestAuthorized(request, pathname)) {
        rejectMissingIdentity(response);
        return;
      }
      await handle(request, response);
    })().catch((error) => {
      console.error('[webpilot-server] HTTP request failed.', error);
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Internal Server Error');
    });
  });

  server.on('upgrade', (request, socket, head) => {
    removeUntrustedProxyHeaders(request);
    const requestUrl = new URL(request.url || '/', `http://${request.headers.host || `${hostname}:${port}`}`);
    const target = webSocketUpgradeTarget(requestUrl, basePath);
    if (!target) {
      if (handleNextUpgrade && nextDevelopmentUpgrade(requestUrl, basePath, dev)) {
        void Promise.resolve(handleNextUpgrade(request, socket, head)).catch((error) => {
          console.error('[webpilot-server] Next.js development WebSocket upgrade failed.', error);
          socket.destroy();
        });
        return;
      }
      socket.destroy();
      return;
    }
    if (target.kind === 'browser-preview') {
      proxyUpgrade(request, socket, head, internalPort(process.env.BROWSER_CHAT_PREVIEW_WS_PORT, 18021), target.target);
      return;
    }
    refreshHub.acceptUpgrade(request, socket, requestUrl);
  });

  server.listen(port, hostname, () => {
    console.log(`[webpilot-server] Ready on http://${hostname}:${port}${basePath || '/'}`);
  });

  const close = () => {
    refreshHub.close();
    server.close(() => {
      process.exit(0);
    });
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[webpilot-server] Failed to start.', error);
    process.exitCode = 1;
  });
}

module.exports = {
  applicationBasePath,
  configureCompiledNextRuntime,
  loadCompiledNextConfig,
  nextDevelopmentUpgrade,
  normalizeBasePath,
  requireRuntimeDependency,
  stripBasePath,
  unsafeCrossOriginRequest,
  webSocketUpgradeTarget,
};
