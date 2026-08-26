import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

export type GlinerRuntimeMode = 'auto' | 'local' | 'external';

type LocalGlinerRuntimeState = {
  child?: ChildProcess;
  endpoint?: string;
  startPromise?: Promise<string>;
  shutdownRegistered?: boolean;
};

const globalRuntime = globalThis as typeof globalThis & {
  __webPilotLocalGlinerRuntime?: LocalGlinerRuntimeState;
};

const runtimeState = globalRuntime.__webPilotLocalGlinerRuntime ||= {};
const defaultGlinerOpenLabelModel = 'fastino/gliner2.5-multi-v1';

export function normalizedGlinerModelName(value: unknown) {
  const configured = String(value || '').trim();
  return !configured || configured === 'urchade/gliner_multi-v2.1'
    ? defaultGlinerOpenLabelModel
    : configured;
}

export function normalizedGlinerRuntimeMode(value: unknown): GlinerRuntimeMode {
  const normalized = String(value || 'auto').trim().toLowerCase();
  if (normalized === 'local' || normalized === 'external') return normalized;
  return 'auto';
}

function isLoopbackHost(hostname: string) {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export function localGlinerServiceDirectories(projectRoot = process.cwd(), configuredDirectory = '') {
  return [...new Set([
    configuredDirectory ? path.resolve(configuredDirectory) : '',
    ...bundledGlinerRuntimeDirectories(projectRoot).map((runtimeRoot) => path.join(runtimeRoot, 'service')),
    path.resolve(projectRoot, 'services', 'gliner'),
    path.resolve(projectRoot, '..', 'services', 'gliner'),
  ].filter(Boolean))];
}

export function bundledGlinerRuntimeDirectories(projectRoot = process.cwd()) {
  return [...new Set([
    path.resolve(projectRoot, 'gliner-runtime'),
    path.resolve(projectRoot, '..', 'gliner-runtime'),
  ])];
}

function resolveServiceDirectory(projectRoot: string, configuredDirectory: string) {
  return localGlinerServiceDirectories(projectRoot, configuredDirectory)
    .find((directory) => existsSync(path.join(directory, 'app.py')));
}

export function localGlinerPythonCandidates(projectRoot = process.cwd(), configuredPath = '') {
  const executable = process.platform === 'win32' ? 'python.exe' : 'python';
  return [...new Set([
    configuredPath ? path.resolve(configuredPath) : '',
    ...bundledGlinerRuntimeDirectories(projectRoot).map((runtimeRoot) => path.join(runtimeRoot, 'python', executable)),
    path.resolve(projectRoot, '.venv-gliner', process.platform === 'win32' ? 'Scripts' : 'bin', executable),
    path.resolve(projectRoot, '..', '.venv-gliner', process.platform === 'win32' ? 'Scripts' : 'bin', executable),
  ].filter(Boolean))];
}

function bundledModelDirectory(
  projectRoot: string,
  options: {
    bundleEnvironmentKey: 'GLINER_MODEL_BUNDLE_DIR' | 'GLINER_CHINESE_NER_MODEL_BUNDLE_DIR';
    configuredEnvironmentKey: 'GLINER_MODEL' | 'GLINER_CHINESE_NER_MODEL';
    manifestKey: 'modelName' | 'chineseNerModelName';
    relativePath: string[];
  },
) {
  const configured = String(process.env[options.bundleEnvironmentKey] || '').trim();
  const candidates = [
    ...(configured ? [path.resolve(configured)] : []),
    ...bundledGlinerRuntimeDirectories(projectRoot).map((runtimeRoot) => path.join(runtimeRoot, ...options.relativePath)),
  ];
  for (const modelDirectory of candidates) {
    if (!existsSync(path.join(modelDirectory, 'config.json'))) continue;
    const manifestPath = path.join(modelDirectory, '..', '..', 'runtime-manifest.json');
    let bundledModelName = '';
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      bundledModelName = String(manifest[options.manifestKey] || '').trim();
    } catch {
      // An explicitly supplied bundle directory can omit the build manifest.
    }
    const configuredModel = options.configuredEnvironmentKey === 'GLINER_MODEL'
      ? normalizedGlinerModelName(process.env.GLINER_MODEL)
      : String(process.env[options.configuredEnvironmentKey] || '').trim();
    if (!configuredModel || !bundledModelName || configuredModel === bundledModelName) return modelDirectory;
  }
  return '';
}

function resolvePythonCommand(projectRoot: string, configuredPath: string) {
  const local = localGlinerPythonCandidates(projectRoot, configuredPath).find(existsSync);
  if (local) return local;
  return process.platform === 'win32' ? 'python' : 'python3';
}

function healthEndpoint(endpoint: string) {
  return new URL('health', endpoint.endsWith('/') ? endpoint : `${endpoint}/`).toString();
}

async function serviceHealthy(endpoint: string, timeoutMs = 800) {
  try {
    const response = await fetch(healthEndpoint(endpoint), {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const health = await response.json() as { pipeline?: unknown; status?: unknown };
    return health.status === 'ok'
      && health.pipeline === 'gliner2.5-open-label -> chinese-roberta-boundary -> redact';
  } catch {
    return false;
  }
}

function startupTimeoutMs() {
  const configured = Number(process.env.GLINER_LOCAL_STARTUP_TIMEOUT_MS || 600_000);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(Math.floor(configured), 900_000)
    : 600_000;
}

function stopManagedSidecar() {
  const child = runtimeState.child;
  runtimeState.child = undefined;
  runtimeState.endpoint = undefined;
  runtimeState.startPromise = undefined;
  if (child && child.exitCode === null && !child.killed) child.kill();
}

function registerShutdown() {
  if (runtimeState.shutdownRegistered) return;
  runtimeState.shutdownRegistered = true;
  process.once('SIGINT', stopManagedSidecar);
  process.once('SIGTERM', stopManagedSidecar);
  process.once('exit', stopManagedSidecar);
}

async function waitForService(endpoint: string, child: ChildProcess) {
  const deadline = Date.now() + startupTimeoutMs();
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.killed) {
      throw new Error('Local GLiNER process exited before becoming ready. Run "npm run gliner:install" and check the startup output.');
    }
    if (await serviceHealthy(endpoint, 1_000)) return endpoint;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Local GLiNER startup timed out. The first model download can take several minutes; check network access and the GLiNER startup output.');
}

async function startManagedSidecar(endpoint: string, projectRoot: string) {
  if (await serviceHealthy(endpoint)) return endpoint;
  const serviceDirectory = resolveServiceDirectory(projectRoot, String(process.env.GLINER_SERVICE_DIR || '').trim());
  if (!serviceDirectory) {
    throw new Error('Local GLiNER service files were not found. Set GLINER_SERVICE_DIR or use GLINER_RUNTIME_MODE=external.');
  }
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !isLoopbackHost(url.hostname)) {
    throw new Error('Managed local GLiNER requires a loopback HTTP GLINER_SERVICE_URL.');
  }
  const port = Number(url.port || 80);
  const pythonCommand = resolvePythonCommand(projectRoot, String(process.env.GLINER_PYTHON_PATH || '').trim());
  const modelBundleDirectory = bundledModelDirectory(projectRoot, {
    bundleEnvironmentKey: 'GLINER_MODEL_BUNDLE_DIR',
    configuredEnvironmentKey: 'GLINER_MODEL',
    manifestKey: 'modelName',
    relativePath: ['models', 'gliner2'],
  });
  const chineseNerModelBundleDirectory = bundledModelDirectory(projectRoot, {
    bundleEnvironmentKey: 'GLINER_CHINESE_NER_MODEL_BUNDLE_DIR',
    configuredEnvironmentKey: 'GLINER_CHINESE_NER_MODEL',
    manifestKey: 'chineseNerModelName',
    relativePath: ['models', 'chinese-roberta'],
  });
  const modelCacheDirectory = String(process.env.GLINER_MODEL_CACHE_DIR || '').trim()
    || path.resolve(process.env.APP_DATA_DIR || projectRoot, '.data', 'gliner-models');
  console.log(`[gliner-local] Starting ${pythonCommand} on ${url.hostname}:${port}.`);
  const child = spawn(pythonCommand, [
    '-m',
    'uvicorn',
    'app:app',
    '--host',
    url.hostname,
    '--port',
    String(port),
    '--no-access-log',
  ], {
    cwd: serviceDirectory,
    env: {
      ...process.env,
      GLINER_MODEL: modelBundleDirectory || normalizedGlinerModelName(process.env.GLINER_MODEL),
      ...(chineseNerModelBundleDirectory ? {
        GLINER_CHINESE_NER_MODEL: chineseNerModelBundleDirectory,
      } : {}),
      ...(modelBundleDirectory && chineseNerModelBundleDirectory ? {
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
      } : {}),
      HF_HOME: process.env.HF_HOME || modelCacheDirectory,
      TRANSFORMERS_CACHE: process.env.TRANSFORMERS_CACHE || modelCacheDirectory,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  runtimeState.child = child;
  runtimeState.endpoint = endpoint;
  registerShutdown();
  child.once('error', () => {
    if (runtimeState.child === child) runtimeState.child = undefined;
  });
  child.once('exit', () => {
    if (runtimeState.child === child) {
      runtimeState.child = undefined;
      runtimeState.endpoint = undefined;
      runtimeState.startPromise = undefined;
    }
  });
  return waitForService(endpoint, child);
}

export async function prepareGlinerService(endpoint: string) {
  const mode = normalizedGlinerRuntimeMode(process.env.GLINER_RUNTIME_MODE);
  if (mode === 'external') {
    if (runtimeState.child) stopManagedSidecar();
    return endpoint;
  }

  const projectRoot = process.cwd();
  const url = new URL(endpoint);
  const localServiceAvailable = Boolean(resolveServiceDirectory(
    projectRoot,
    String(process.env.GLINER_SERVICE_DIR || '').trim(),
  ));
  if (mode === 'auto' && (!isLoopbackHost(url.hostname) || !localServiceAvailable)) {
    if (runtimeState.child) stopManagedSidecar();
    return endpoint;
  }
  if (runtimeState.child && runtimeState.endpoint !== endpoint) stopManagedSidecar();
  if (runtimeState.endpoint === endpoint && runtimeState.child && runtimeState.child.exitCode === null) {
    if (await serviceHealthy(endpoint)) return endpoint;
  }
  if (!runtimeState.startPromise || runtimeState.endpoint !== endpoint) {
    runtimeState.endpoint = endpoint;
    runtimeState.startPromise = startManagedSidecar(endpoint, projectRoot).catch((error) => {
      if (runtimeState.endpoint === endpoint) {
        runtimeState.startPromise = undefined;
        runtimeState.endpoint = undefined;
      }
      throw error;
    });
  }
  return runtimeState.startPromise;
}
