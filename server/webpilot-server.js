/* eslint-disable @typescript-eslint/no-require-imports */
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
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
const { startProcessMemoryMonitor } = require('./process-memory-monitor');

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

function configureNextDevelopmentRuntime(dev, environment = process.env) {
  if (!dev) return;
  // Next's route modules read this flag when they are constructed. Set it
  // before spawning the API runtime or loading Next so development routes do
  // not attempt to read production-only manifests.
  environment.__NEXT_DEV_SERVER = '1';
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

const identityHeaderNames = new Set([
  'x-webpilot-identity-user-id',
  'x-webpilot-identity-username',
  'x-webpilot-identity-roles',
  'x-webpilot-identity-proof',
]);

function applyTrustedIdentityHeaders(request, principal, proof) {
  for (const name of identityHeaderNames) delete request.headers[name];
  if (Array.isArray(request.rawHeaders)) {
    const retained = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = String(request.rawHeaders[index] || '');
      if (identityHeaderNames.has(name.toLowerCase())) continue;
      retained.push(name, request.rawHeaders[index + 1]);
    }
    request.rawHeaders.splice(0, request.rawHeaders.length, ...retained);
  }
  if (!principal) return;
  const userId = String(principal.userId || '').trim();
  const username = String(principal.username || '').trim();
  const roles = Array.isArray(principal.roles) ? principal.roles.map((role) => String(role || '').trim()).filter(Boolean) : [];
  const trustedProof = typeof proof === 'string' ? proof.trim() : '';
  if (!userId || !trustedProof) return;
  const values = {
    'x-webpilot-identity-user-id': userId,
    'x-webpilot-identity-username': username,
    'x-webpilot-identity-roles': roles.join(','),
    'x-webpilot-identity-proof': trustedProof,
  };
  for (const [name, value] of Object.entries(values)) {
    request.headers[name] = value;
    if (Array.isArray(request.rawHeaders)) request.rawHeaders.push(name, value);
  }
}

function proxyRequestHeaders(requestHeaders, target) {
  const headers = {};
  for (const [name, value] of Object.entries(requestHeaders || {})) {
    if (value !== undefined) headers[name] = value;
  }
  headers.host = requestHeaders?.host || `${target.hostname}:${target.port}`;
  return headers;
}

function runtimeApiRequest(pathname) {
  return pathname.startsWith('/api/') && pathname !== '/api/system/shutdown';
}

function splitRuntimeEnabled(dev, runtimeChildMode, environment = process.env) {
  // Every Next development server rewrites the same next-env.d.ts file. Running
  // the UI and API compilers together makes them invalidate each other while
  // Webpack is emitting chunks, which can leave a runtime referring to vendor
  // chunks that have not been written yet. Keep process isolation in production
  // and use one compiler for all development routes.
  return !dev && !runtimeChildMode && environment.WEBPILOT_SPLIT_RUNTIME !== 'false';
}

function availableInternalPort(hostname) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, hostname, () => {
      const address = probe.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitForInternalPort(port, hostname, child, timeoutMs = 60_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let timer;
    let completed = false;
    const finish = (error) => {
      if (completed) return;
      completed = true;
      if (timer) clearTimeout(timer);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onExit = (code, signal) => finish(new Error(
      `The API runtime exited before it became ready (code=${code ?? 'none'}, signal=${signal || 'none'}).`,
    ));
    const probe = () => {
      if (completed) return;
      const socket = net.createConnection({ host: hostname, port });
      let retried = false;
      socket.setTimeout(500);
      socket.once('connect', () => {
        socket.destroy();
        finish();
      });
      const retry = () => {
        if (retried || completed) return;
        retried = true;
        socket.destroy();
        if (Date.now() - startedAt >= timeoutMs) {
          finish(new Error(`Timed out waiting for the API runtime on ${hostname}:${port}.`));
          return;
        }
        timer = setTimeout(probe, 100);
        timer.unref?.();
      };
      socket.once('error', retry);
      socket.once('timeout', retry);
    };
    child.once('exit', onExit);
    probe();
  });
}

async function startApiRuntimeChild({ appDir, dev, externalPort }) {
  const hostname = '127.0.0.1';
  const configuredPort = Number(process.env.WEBPILOT_RUNTIME_PORT || 0);
  const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535
    ? configuredPort
    : await availableInternalPort(hostname);
  const args = [__filename, '--runtime-child', ...(dev ? ['--dev'] : [])];
  const child = spawn(process.execPath, args, {
    cwd: appDir,
    env: {
      ...process.env,
      HOSTNAME: hostname,
      PORT: String(port),
      WEBPILOT_REALTIME_PUBLISH_PORT: String(externalPort),
      WEBPILOT_SERVER_ROLE: 'runtime',
    },
    stdio: 'inherit',
    windowsHide: true,
  });
  child.once('error', (error) => {
    console.error('[webpilot-server] API runtime child failed.', error);
  });
  const stopChildOnExit = () => {
    if (!child.killed) child.kill('SIGTERM');
  };
  process.once('exit', stopChildOnExit);
  child.once('exit', () => process.off('exit', stopChildOnExit));
  return { child, hostname, port, ready: waitForInternalPort(port, hostname, child) };
}

function createApiRuntimeSupervisor({
  appDir,
  dev,
  externalPort,
  startRuntime = startApiRuntimeChild,
  restartDelayMs = 250,
}) {
  let current;
  let starting;
  let restartTimer;
  let stopped = false;

  const clearRestartTimer = () => {
    if (!restartTimer) return;
    clearTimeout(restartTimer);
    restartTimer = undefined;
  };

  const scheduleRestart = () => {
    if (stopped || restartTimer) return;
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      void ensure().catch((error) => {
        console.error('[webpilot-server] API runtime restart failed; retrying.', error);
        scheduleRestart();
      });
    }, restartDelayMs);
    restartTimer.unref?.();
  };

  const start = async () => {
    const runtime = await startRuntime({ appDir, dev, externalPort });
    if (stopped) {
      if (!runtime.child.killed) runtime.child.kill('SIGTERM');
      throw new Error('API runtime supervisor is stopped.');
    }
    current = runtime;
    runtime.child.once('exit', (code, signal) => {
      if (current !== runtime) return;
      current = undefined;
      if (stopped) return;
      console.error(`[webpilot-server] API runtime exited (${code ?? 'unknown'}${signal ? `, ${signal}` : ''}); restarting.`);
      scheduleRestart();
    });
    try {
      await runtime.ready;
      if (current !== runtime) throw new Error('API runtime exited before it became available.');
      return runtime;
    } catch (error) {
      if (current === runtime) current = undefined;
      if (!runtime.child.killed) runtime.child.kill('SIGTERM');
      scheduleRestart();
      throw error;
    }
  };

  const ensure = () => {
    if (stopped) return Promise.reject(new Error('API runtime supervisor is stopped.'));
    clearRestartTimer();
    if (current && current.child.exitCode == null && !current.child.killed) {
      const runtime = current;
      return Promise.resolve(runtime.ready).then(() => {
        if (current !== runtime) return ensure();
        return runtime;
      });
    }
    if (starting) return starting;
    starting = start().finally(() => {
      starting = undefined;
    });
    return starting;
  };

  const invalidate = (runtime) => {
    if (current !== runtime || stopped) return;
    current = undefined;
    if (!runtime.child.killed) runtime.child.kill('SIGTERM');
    scheduleRestart();
  };

  const stop = () => {
    stopped = true;
    clearRestartTimer();
    const runtime = current;
    current = undefined;
    if (runtime?.child && !runtime.child.killed) runtime.child.kill('SIGTERM');
  };

  return { ensure, invalidate, stop };
}

function proxyHttpRequest(request, response, target, onUnavailable) {
  const upstream = http.request({
    headers: proxyRequestHeaders(request.headers, target),
    hostname: target.hostname,
    method: request.method,
    path: request.url,
    port: target.port,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.once('error', (error) => {
    console.error('[webpilot-server] API runtime proxy failed.', error);
    onUnavailable?.(error);
    if (!response.headersSent) {
      response.writeHead(503, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Retry-After': '1',
      });
    }
    response.end('API Runtime Unavailable');
  });
  request.once('aborted', () => upstream.destroy());
  request.pipe(upstream);
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
  const runtimeChildMode = process.argv.includes('--runtime-child');
  configureNextDevelopmentRuntime(dev);
  process.env.WEBPILOT_SERVER_ROLE = runtimeChildMode ? 'runtime' : 'ui';
  const hostname = String(process.env.HOSTNAME || '127.0.0.1');
  const port = Math.max(1, Math.floor(Number(process.env.PORT || 3000)));
  const appDir = path.resolve(process.env.WEBPILOT_APP_DIR || process.cwd());
  const { loadEnvConfig } = requireRuntimeDependency(appDir, '@next/env');
  loadEnvConfig(appDir, dev);
  const memoryMonitor = startProcessMemoryMonitor();
  process.env.WEBPILOT_REALTIME_PUBLISH_TOKEN ||= randomBytes(32).toString('base64url');
  process.env.WEBPILOT_IDENTITY_HEADER_SECRET ||= randomBytes(32).toString('base64url');
  process.env.WEBPILOT_IDENTITY_SECRET ||= randomBytes(32).toString('base64url');
  process.env.WEBPILOT_INTERNAL_REQUEST_TOKEN ||= randomBytes(32).toString('base64url');
  const identityHeaderSecret = process.env.WEBPILOT_IDENTITY_HEADER_SECRET;
  const compiledConfig = dev ? undefined : loadCompiledNextConfig(appDir);
  const apiRuntimeSupervisor = splitRuntimeEnabled(dev, runtimeChildMode)
    ? createApiRuntimeSupervisor({ appDir, dev, externalPort: port })
    : undefined;

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
    // Turbopack 16.3 can lose an incremental HMR graph cell during long-lived
    // sessions and then panic on every subscription retry. Use Next's stable
    // Webpack development path for both the UI and isolated API runtime.
    webpack: dev,
    ...(compiledConfig ? { conf: compiledConfig } : {}),
  });
  const handle = application.getRequestHandler();
  await Promise.all([
    application.prepare(),
    apiRuntimeSupervisor?.ensure(),
  ]);
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

      const principal = internalPrincipal(request, pathname) || requestIdentity(request);
      applyTrustedIdentityHeaders(request, principal, identityHeaderSecret);

      if (!principal && !publicPath(pathname) && !internalRequestAuthorized(request, pathname)) {
        rejectMissingIdentity(response);
        return;
      }
      if (apiRuntimeSupervisor && runtimeApiRequest(pathname)) {
        try {
          const apiRuntime = await apiRuntimeSupervisor.ensure();
          proxyHttpRequest(request, response, apiRuntime, () => apiRuntimeSupervisor.invalidate(apiRuntime));
        } catch (error) {
          console.error('[webpilot-server] API runtime is unavailable.', error);
          if (!response.headersSent) {
            response.writeHead(503, {
              'Content-Type': 'text/plain; charset=utf-8',
              'Retry-After': '1',
            });
          }
          response.end('API Runtime Unavailable');
        }
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
    const role = runtimeChildMode ? 'API runtime' : 'UI';
    console.log(`[webpilot-server] ${role} ready on http://${hostname}:${port}${basePath || '/'}`);
  });

  const close = () => {
    memoryMonitor.stop();
    refreshHub.close();
    apiRuntimeSupervisor?.stop();
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
  applyTrustedIdentityHeaders,
  applicationBasePath,
  createApiRuntimeSupervisor,
  configureCompiledNextRuntime,
  configureNextDevelopmentRuntime,
  loadCompiledNextConfig,
  nextDevelopmentUpgrade,
  normalizeBasePath,
  proxyRequestHeaders,
  requireRuntimeDependency,
  runtimeApiRequest,
  splitRuntimeEnabled,
  stripBasePath,
  unsafeCrossOriginRequest,
  webSocketUpgradeTarget,
};
